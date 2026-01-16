import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ■ データ構造の定義
interface MyNode {
    id: string;
    label: string;
    type: 'group' | 'file';
    children?: MyNode[];
    filePath?: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
}

export function activate(context: vscode.ExtensionContext) {
    const treeDataProvider = new CustomTreeDataProvider(context);

    // ビューの作成
    const treeView = vscode.window.createTreeView('custom-explorer-view', {
        treeDataProvider: treeDataProvider,
        dragAndDropController: treeDataProvider, 
        canSelectMany: true
    });

    if (vscode.workspace.name) {
        treeView.title = vscode.workspace.name;
    }

    // ★ 同期機能: マップ検索により高速化されています
    const syncTreeSelection = (editor: vscode.TextEditor | undefined) => {
        if (!editor || !editor.document) return;
        
        // ツリービューが表示されていないときは同期処理をスキップする
        if (!treeView.visible) {
            return;
        }

        const activeFilePath = editor.document.uri.fsPath;
        const foundNode = treeDataProvider.findNodeByPath(activeFilePath);
        
        if (foundNode) {
            treeView.reveal(foundNode, { select: true, focus: false, expand: true });
        }
    };

    // 1. 起動時にすでに開いているファイルがあれば同期
    syncTreeSelection(vscode.window.activeTextEditor);

    // 2. タブを切り替えるたびに同期
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        syncTreeSelection(editor);
    }));

    // ★ 変更点: DecorationProviderにtreeDataProviderを渡す（親子関係を辿るため）
    const decorationProvider = new ProblemFileDecorationProvider(treeDataProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    // 診断情報（エラー発生など）が変わったら、デコレーション表示を更新する
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => {
        // 変更があったファイルだけでなく、その「親フォルダ」も含めて更新通知を出す
        decorationProvider.fireDidChangeFileDecorations(e.uris);
    }));


    // --- コマンド登録 ---

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addRootGroup', async () => {
        const label = await vscode.window.showInputBox({ prompt: 'フォルダ名を入力してください' });
        if (!label) return;
        treeDataProvider.addGroup(label, undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addGroup', async (node?: MyNode) => {
        const label = await vscode.window.showInputBox({ prompt: 'フォルダ名を入力してください' });
        if (!label) return;
        treeDataProvider.addGroup(label, node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.renameEntry', async (node: MyNode) => {
        const newName = await vscode.window.showInputBox({ 
            prompt: '新しい名前を入力してください',
            value: node.label 
        });
        if (!newName) return;
        treeDataProvider.renameNode(node, newName);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.removeEntry', async (node: MyNode) => {
        const answer = await vscode.window.showWarningMessage(
            `'${node.label}' を削除しますか？`,
            { modal: true },
            '削除'
        );
        if (answer === '削除') {
            treeDataProvider.removeNode(node);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.collapseRecursive', (node: MyNode) => {
        treeDataProvider.collapseRecursive(node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.expandRecursive', (node: MyNode) => {
        treeDataProvider.expandRecursive(node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.collapseAll', () => {
        treeDataProvider.collapseRecursive(undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.expandAll', () => {
        treeDataProvider.expandRecursive(undefined);
    }));
}

// ★ エラー・警告状態をツリーアイテムに装飾するためのクラス（親への伝播機能付き）
class ProblemFileDecorationProvider implements vscode.FileDecorationProvider {
    
    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    // データ構造を参照できるようにする
    constructor(private treeDataProvider: CustomTreeDataProvider) {}

    // VS Code が「このファイルURIに何か装飾（色やバッジ）をつける？」と聞いてくるメソッド
    provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        
        // URIからノードを特定する
        const node = this.treeDataProvider.getNodeByUri(uri);
        if (!node) return undefined;

        if (node.type === 'file') {
            // --- ファイルの場合：直接診断情報をチェック ---
            return this.getDiagnosticDecoration(uri);
        } else {
            // --- グループの場合：子孫を再帰チェックしてエラーを吸い上げる ---
            return this.getGroupDecorationRecursive(node);
        }
    }

    // ファイル単体の診断チェック
    private getDiagnosticDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (!diagnostics || diagnostics.length === 0) return undefined;

        // エラー優先
        const hasError = diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (hasError) {
            return {
                badge: '●',
                color: new vscode.ThemeColor('list.errorForeground'),
                tooltip: 'Errors detected'
            };
        }

        const hasWarning = diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Warning);
        if (hasWarning) {
            return {
                badge: '●',
                color: new vscode.ThemeColor('list.warningForeground'),
                tooltip: 'Warnings detected'
            };
        }

        return undefined;
    }

    // グループの再帰チェック（エラーが見つかったら即座にリターンして負荷を下げる）
    private getGroupDecorationRecursive(groupNode: MyNode): vscode.FileDecoration | undefined {
        if (!groupNode.children || groupNode.children.length === 0) return undefined;

        let hasWarning = false;

        // 再帰探索関数
        // 戻り値: 'error' | 'warning' | 'none'
        const traverse = (nodes: MyNode[]): string => {
            for (const child of nodes) {
                if (child.type === 'file' && child.filePath) {
                    const uri = vscode.Uri.file(child.filePath);
                    const diags = vscode.languages.getDiagnostics(uri);
                    
                    // エラーが見つかったら、これ以上探す必要はない（最悪値が確定）
                    if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Error)) {
                        return 'error';
                    }
                    if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Warning)) {
                        hasWarning = true;
                    }
                } else if (child.type === 'group' && child.children) {
                    const childResult = traverse(child.children);
                    if (childResult === 'error') return 'error';
                }
            }
            return hasWarning ? 'warning' : 'none';
        };

        const result = traverse(groupNode.children);

        if (result === 'error') {
            return {
                badge: '●',
                color: new vscode.ThemeColor('list.errorForeground'),
                tooltip: 'Error in children'
            };
        }
        if (result === 'warning') {
            return {
                badge: '●',
                color: new vscode.ThemeColor('list.warningForeground'),
                tooltip: 'Warning in children'
            };
        }
        return undefined;
    }

    // イベント発火用ヘルパー
    // ファイルの状態が変わったとき、その親たちも「再チェック対象」としてイベントに含める
    public fireDidChangeFileDecorations(uris: ReadonlyArray<vscode.Uri>) {
        const urisToUpdate = new Set<string>();

        for (const uri of uris) {
            // 1. ファイル自身を追加
            urisToUpdate.add(uri.toString());

            // 2. そのファイルの親グループを遡ってすべて追加
            const node = this.treeDataProvider.getNodeByUri(uri);
            if (node) {
                let parent = this.treeDataProvider.getParentSync(node); 
                while (parent) {
                    const parentUri = this.treeDataProvider.getGroupUri(parent);
                    urisToUpdate.add(parentUri.toString());
                    
                    // さらに上の親へ
                    parent = this.treeDataProvider.getParentSync(parent);
                }
            }
        }

        // Setから配列に戻して通知
        const uriList = Array.from(urisToUpdate).map(u => vscode.Uri.parse(u));
        this._onDidChangeFileDecorations.fire(uriList);
    }
}

class CustomTreeDataProvider implements vscode.TreeDataProvider<MyNode>, vscode.TreeDragAndDropController<MyNode> {
    
    private _onDidChangeTreeData: vscode.EventEmitter<MyNode | undefined | null | void> = new vscode.EventEmitter<MyNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MyNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private storageKey = 'customExplorerData';
    private data: MyNode[] = [];

    // ★ パス検索用と、URI検索用のインデックス
    private pathIndex: Map<string, MyNode> = new Map();
    private uriToNodeMap: Map<string, MyNode> = new Map();

    public dropMimeTypes = ['application/vnd.code.tree.customExplorer', 'text/uri-list', 'text/plain'];
    public dragMimeTypes = ['application/vnd.code.tree.customExplorer'];

    constructor(private context: vscode.ExtensionContext) {
        this.loadData();
    }

    public findNodeByPath(targetPath: string): MyNode | undefined {
        return this.pathIndex.get(targetPath);
    }

    // ★ 追加: URIからノードを取得する（FileDecorationProviderで使用）
    public getNodeByUri(uri: vscode.Uri): MyNode | undefined {
        return this.uriToNodeMap.get(uri.toString());
    }

    // ★ 追加: グループノード用の一意なURIを生成する
    public getGroupUri(node: MyNode): vscode.Uri {
        // グループに一意なURIを持たせる（custom-explorerスキームを使用）
        return vscode.Uri.parse(`custom-explorer://group/${node.id}`);
    }

    private rebuildIndex() {
        this.pathIndex.clear();
        this.uriToNodeMap.clear();
        
        const traverse = (nodes: MyNode[]) => {
            for (const node of nodes) {
                if (node.type === 'file' && node.filePath) {
                    this.pathIndex.set(node.filePath, node);
                    // ファイルURIで引けるように
                    this.uriToNodeMap.set(vscode.Uri.file(node.filePath).toString(), node);
                }
                
                // ★ 追加: グループもURIで引けるようにする
                if (node.type === 'group') {
                    const groupUri = this.getGroupUri(node);
                    this.uriToNodeMap.set(groupUri.toString(), node);
                }

                if (node.children) {
                    traverse(node.children);
                }
            }
        };
        traverse(this.data);
    }

    getTreeItem(element: MyNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label,
            element.type === 'group' 
                ? (element.collapsibleState ?? vscode.TreeItemCollapsibleState.Expanded) 
                : vscode.TreeItemCollapsibleState.None
        );

        treeItem.contextValue = element.type;
        treeItem.id = element.id; 

        if (element.type === 'file' && element.filePath) {
            treeItem.resourceUri = vscode.Uri.file(element.filePath);
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [treeItem.resourceUri]
            };
        } else {
            // ★ グループにも resourceUri をセットする（DecorationProviderのため）
            treeItem.resourceUri = this.getGroupUri(element);
            treeItem.iconPath = vscode.ThemeIcon.Folder;
        }
        return treeItem;
    }

    getChildren(element?: MyNode): vscode.ProviderResult<MyNode[]> {
        if (!element) return this.data;
        return element.children || [];
    }

    getParent(element: MyNode): vscode.ProviderResult<MyNode> {
        return this.findParent(this.data, element);
    }

    // ★ 同期的に親を取得するメソッド（イベント発火時の高速化用）
    public getParentSync(element: MyNode): MyNode | undefined {
        return this.findParent(this.data, element);
    }

    private findParent(nodes: MyNode[], target: MyNode): MyNode | undefined {
        for (const node of nodes) {
            if (node.children && node.children.includes(target)) {
                return node;
            }
            if (node.children) {
                const found = this.findParent(node.children, target);
                if (found) return found;
            }
        }
        return undefined;
    }

    // --- D&D の実装 ---

    public handleDrag(source: readonly MyNode[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        dataTransfer.set('application/vnd.code.tree.customExplorer', new vscode.DataTransferItem(source));
    }

    public async handleDrop(target: MyNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        
        const internalDrag = dataTransfer.get('application/vnd.code.tree.customExplorer');
        if (internalDrag) {
            const sources: MyNode[] = internalDrag.value;
            this.moveNodes(sources, target);
            return;
        }

        let uriString = "";
        const uriListItem = dataTransfer.get('text/uri-list');
        const plainTextItem = dataTransfer.get('text/plain');

        if (uriListItem) {
            uriString = await uriListItem.asString();
        } else if (plainTextItem) {
            uriString = await plainTextItem.asString();
        }

        if (uriString) {
            const rawPaths = uriString.split(/\r?\n/);
            
            for (const rawPath of rawPaths) {
                const trimmedPath = rawPath.trim();
                if (!trimmedPath) continue;
                
                try {
                    let fsPath: string;
                    if (trimmedPath.startsWith('file://')) {
                        fsPath = vscode.Uri.parse(trimmedPath).fsPath;
                    } else {
                        fsPath = trimmedPath;
                    }

                    if (!fs.existsSync(fsPath)) continue;

                    const stat = fs.statSync(fsPath);

                    if (stat.isDirectory()) {
                        this.importDirectory(fsPath, target);
                    } else {
                        this.addFile(fsPath, target);
                    }
                } catch (e) {
                    console.error('Drop failed for path:', trimmedPath, e);
                }
            }
        }
    }

    // --- データ操作ロジック ---

    public importDirectory(dirPath: string, parent?: MyNode) {
        const dirName = path.basename(dirPath);

        const newGroupNode: MyNode = {
            id: this.generateId(),
            label: dirName,
            type: 'group',
            children: [],
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        };

        if (parent && parent.type === 'group') {
            parent.children = parent.children || [];
            parent.children.push(newGroupNode);
        } else {
            this.data.push(newGroupNode);
        }

        const scanRecursive = (currentPath: string, parentNode: MyNode) => {
            try {
                const items = fs.readdirSync(currentPath, { withFileTypes: true });

                for (const item of items) {
                    const fullPath = path.join(currentPath, item.name);

                    if (item.isDirectory()) {
                        const subGroup: MyNode = {
                            id: this.generateId(),
                            label: item.name,
                            type: 'group',
                            children: [],
                            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
                        };
                        parentNode.children = parentNode.children || [];
                        parentNode.children.push(subGroup);
                        scanRecursive(fullPath, subGroup);

                    } else if (item.isFile()) {
                        if (item.name === '.DS_Store') continue; 

                        const fileNode: MyNode = {
                            id: this.generateId(),
                            label: item.name,
                            type: 'file',
                            filePath: fullPath
                        };
                        parentNode.children = parentNode.children || [];
                        parentNode.children.push(fileNode);
                    }
                }
            } catch (err) {
                console.error(`Failed to read directory: ${currentPath}`, err);
            }
        };

        scanRecursive(dirPath, newGroupNode);
        this.saveAndRefresh();
    }


    public renameNode(node: MyNode, newName: string) {
        node.label = newName;
        this.saveAndRefresh();
    }

    public collapseRecursive(node?: MyNode) {
        const targets = node ? [node] : this.data;
        const resetNodeState = (targetNode: MyNode) => {
            if (targetNode.type === 'group') {
                targetNode.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                targetNode.id = this.generateId();
                if (targetNode.children) {
                    targetNode.children.forEach(child => resetNodeState(child));
                }
            }
        };
        targets.forEach(target => resetNodeState(target));
        this.saveData();
        
        if (node) {
            this.refreshParentOrRoot(node);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    public expandRecursive(node?: MyNode) {
        const targets = node ? [node] : this.data;
        const resetNodeState = (targetNode: MyNode) => {
            if (targetNode.type === 'group') {
                targetNode.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                targetNode.id = this.generateId();
                if (targetNode.children) {
                    targetNode.children.forEach(child => resetNodeState(child));
                }
            }
        };
        targets.forEach(target => resetNodeState(target));
        this.saveData();

        if (node) {
            this.refreshParentOrRoot(node);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private refreshParentOrRoot(node: MyNode) {
        const parent = this.getParent(node);
        if (parent) {
            // @ts-ignore
            this._onDidChangeTreeData.fire(parent);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private moveNodes(sources: MyNode[], target: MyNode | undefined) {
        const isValidMove = (source: MyNode, target?: MyNode): boolean => {
            if (source === target) return false;
            if (!target) return true;
            const isDescendant = (parent: MyNode, potentialChild: MyNode): boolean => {
                if (!parent.children) return false;
                for (const child of parent.children) {
                    if (child === potentialChild || isDescendant(child, potentialChild)) return true;
                }
                return false;
            };
            return !isDescendant(source, target);
        };

        let isChanged = false;
        sources.forEach(source => {
            if (!isValidMove(source, target)) return;
            const removed = this.removeNode(source, false); 

            if (removed) {
                if(target && target.type === 'group') {
                    target.children = target.children || [];
                    target.children.push(source);
                    target.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                    isChanged = true;
                } else {
                    this.data.push(source);
                    isChanged = true;
                }
            }
        });

        if (isChanged) {
            this.saveAndRefresh();
        }
    }

    public addGroup(label: string, parent?: MyNode) {
        const newNode: MyNode = {
            id: this.generateId(),
            label,
            type: 'group',
            children: [],
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        };
        if (parent && parent.type === 'group') {
            parent.children = parent.children || [];
            parent.children.push(newNode);
            parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        } else {
            this.data.push(newNode);
        }
        this.saveAndRefresh();
    }

    public addFile(filePath: string, parent?: MyNode) {
        const fileName = path.basename(filePath);
        const newNode: MyNode = {
            id: this.generateId(),
            label: fileName,
            type: 'file',
            filePath: filePath
        };

        if (parent && parent.type === 'group') {
            parent.children = parent.children || [];
            parent.children.push(newNode);
            parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        } else {
            this.data.push(newNode);
        }
        this.saveAndRefresh();
    }

    public removeNode(node: MyNode, shouldSave: boolean = true): boolean {
        const removeRecursive = (nodes: MyNode[]): boolean => {
            const index = nodes.findIndex(n => n.id === node.id);
            if (index !== -1) {
                nodes.splice(index, 1);
                return true;
            }
            for (const n of nodes) {
                if (n.children && removeRecursive(n.children)) {
                    return true;
                }
            }
            return false;
        };

        const result = removeRecursive(this.data);
        if (shouldSave && result) {
            this.saveAndRefresh();
        }
        return result;
    }

    private saveAndRefresh() {
        this.sortNodesRecursive(this.data);
        this.saveData();
        this._onDidChangeTreeData.fire();
    }

    private saveData() {
        this.rebuildIndex();
        this.sortNodesRecursive(this.data);
        this.context.workspaceState.update(this.storageKey, this.data);
    }

    private sortNodesRecursive(nodes: MyNode[]) {
        nodes.sort((a, b) => {
            if (a.type === 'group' && b.type !== 'group') { return -1; }
            if (a.type !== 'group' && b.type === 'group') { return 1; }
            return a.label.localeCompare(b.label);
        });

        nodes.forEach(node => {
            if (node.children && node.children.length > 0) {
                this.sortNodesRecursive(node.children);
            }
        });
    }

    private loadData() {
        this.data = this.context.workspaceState.get<MyNode[]>(this.storageKey) || [];
        this.rebuildIndex();
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }
}