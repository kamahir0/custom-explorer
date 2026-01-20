import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ■ データ構造の定義
interface MyNode {
    id: string;
    label: string;
    type: 'group' | 'file';
    children?: MyNode[];
    filePath?: string; // ファイルだけでなく、インポートしたフォルダの場合もパスを持つ
    collapsibleState?: vscode.TreeItemCollapsibleState;
    cachedTreePath?: string; // ★ ツリー内の論理パスのキャッシュ（パフォーマンス最適化）
}

export function activate(context: vscode.ExtensionContext) {
    const treeDataProvider = new CustomTreeDataProvider(context);

    // ビューの作成
    const treeView = vscode.window.createTreeView('custom-explorer-view', {
        treeDataProvider: treeDataProvider,
        dragAndDropController: treeDataProvider,
        canSelectMany: true // ★ これがtrueなので複数選択可能です
    });

    if (vscode.workspace.name) {
        treeView.title = vscode.workspace.name;
    }

    // ★ 同期機能
    const syncTreeSelection = (editor: vscode.TextEditor | undefined) => {
        if (!editor || !editor.document) return;
        if (!treeView.visible) return;

        const activeFilePath = editor.document.uri.fsPath;
        const foundNode = treeDataProvider.findNodeByPath(activeFilePath);

        if (foundNode) {
            treeView.reveal(foundNode, { select: true, focus: false, expand: true });
        }
    };

    // 1. 起動時同期
    syncTreeSelection(vscode.window.activeTextEditor);

    // 2. タブ切り替え時同期
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        syncTreeSelection(editor);
    }));

    // ★ エラー装飾プロバイダの登録
    const decorationProvider = new ProblemFileDecorationProvider(treeDataProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    // 診断情報の監視（エラー伝播用）
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => {
        decorationProvider.fireDidChangeFileDecorations(e.uris);
    }));

    // ★ 追加: ファイルリネームの監視
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(e => {
        treeDataProvider.handleFileRename(e.files);
    }));

    // ★ 追加: ファイル削除の監視
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(e => {
        treeDataProvider.handleFileDelete(e.files);
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

    // ★ 修正: 複数選択削除 & キーボードショートカット対応
    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.removeEntry', (node?: MyNode, nodes?: MyNode[]) => {
        // 削除対象リストを作成
        const targets: MyNode[] = [];

        if (nodes && nodes.length > 0) {
            // ケース1: 右クリック等で複数選択の配列が渡された場合
            targets.push(...nodes);
        } else if (node) {
            // ケース2: 単一のアイテムが指定された場合
            targets.push(node);
        } else {
            // ケース3: 引数がない場合 (Deleteキーなどのショートカット経由)
            // 現在のツリービューの選択状態を使用する
            if (treeView.selection.length > 0) {
                targets.push(...treeView.selection);
            }
        }

        if (targets.length === 0) return;

        // まとめて削除実行
        targets.forEach(n => treeDataProvider.removeNode(n, false)); // 個別の保存はスキップ
        treeDataProvider.saveAndRefresh(); // 最後に一回保存して更新
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

// ★ エラー装飾用クラス（親への伝播機能付き）
class ProblemFileDecorationProvider implements vscode.FileDecorationProvider {

    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    constructor(private treeDataProvider: CustomTreeDataProvider) { }

    provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        const node = this.treeDataProvider.getNodeByUri(uri);
        if (!node) return undefined;

        if (node.type === 'file') {
            return this.getDiagnosticDecoration(uri);
        } else {
            return this.getGroupDecorationRecursive(node);
        }
    }

    private getDiagnosticDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (!diagnostics || diagnostics.length === 0) return undefined;

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

    private getGroupDecorationRecursive(groupNode: MyNode): vscode.FileDecoration | undefined {
        if (!groupNode.children || groupNode.children.length === 0) return undefined;

        let hasWarning = false;

        const traverse = (nodes: MyNode[]): string => {
            for (const child of nodes) {
                if (child.type === 'file' && child.filePath) {
                    const uri = vscode.Uri.file(child.filePath);
                    const diags = vscode.languages.getDiagnostics(uri);

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

    public fireDidChangeFileDecorations(uris: ReadonlyArray<vscode.Uri>) {
        const urisToUpdate = new Set<string>();

        for (const uri of uris) {
            urisToUpdate.add(uri.toString());

            const node = this.treeDataProvider.getNodeByUri(uri);
            if (node) {
                let parent = this.treeDataProvider.getParentSync(node);
                while (parent) {
                    const parentUri = this.treeDataProvider.getGroupUri(parent);
                    urisToUpdate.add(parentUri.toString());
                    parent = this.treeDataProvider.getParentSync(parent);
                }
            }
        }
        const uriList = Array.from(urisToUpdate).map(u => vscode.Uri.parse(u));
        this._onDidChangeFileDecorations.fire(uriList);
    }
}

class CustomTreeDataProvider implements vscode.TreeDataProvider<MyNode>, vscode.TreeDragAndDropController<MyNode> {

    private _onDidChangeTreeData: vscode.EventEmitter<MyNode | undefined | null | void> = new vscode.EventEmitter<MyNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MyNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private storageKey = 'customExplorerData';
    private data: MyNode[] = [];

    // インデックス
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

    public getNodeByUri(uri: vscode.Uri): MyNode | undefined {
        return this.uriToNodeMap.get(uri.toString());
    }

    public getGroupUri(node: MyNode): vscode.Uri {
        return vscode.Uri.parse(`custom-explorer://group/${node.id}`);
    }

    // ★ カスタムエクスプローラー用のURIを生成（キャッシュされた論理パスを使用）
    public getCustomExplorerUri(node: MyNode): vscode.Uri {
        const treePath = node.cachedTreePath || ('/' + node.label); // キャッシュがあればそれを使用
        return vscode.Uri.parse(`custom-explorer://tree${treePath}`);
    }

    private rebuildIndex() {
        this.pathIndex.clear();
        this.uriToNodeMap.clear();

        const traverse = (nodes: MyNode[], parentPath: string = '') => {
            for (const node of nodes) {
                // ★ 論理パスをキャッシュ（パフォーマンス最適化）
                node.cachedTreePath = parentPath + '/' + node.label;

                // filePathを持つ要素（ファイル または インポートされたフォルダ）をインデックス化
                if (node.filePath) {
                    this.pathIndex.set(node.filePath, node);
                    this.uriToNodeMap.set(vscode.Uri.file(node.filePath).toString(), node);
                }

                // グループの場合は専用URIでも引けるようにする
                if (node.type === 'group') {
                    const groupUri = this.getGroupUri(node);
                    this.uriToNodeMap.set(groupUri.toString(), node);
                }

                // ★ 全てのノードでカスタムエクスプローラーURIでも引けるようにする
                const customUri = this.getCustomExplorerUri(node);
                this.uriToNodeMap.set(customUri.toString(), node);

                if (node.children) {
                    traverse(node.children, node.cachedTreePath);
                }
            }
        };
        traverse(this.data);
    }

    // ★ リネーム同期機能
    public handleFileRename(files: ReadonlyArray<{ oldUri: vscode.Uri, newUri: vscode.Uri }>) {
        let isChanged = false;

        for (const file of files) {
            const oldPath = file.oldUri.fsPath;
            const newPath = file.newUri.fsPath;

            // 古いパスに一致するノードを探す
            const targetNode = this.pathIndex.get(oldPath);

            if (targetNode) {
                // ラベルと自身のパスを更新
                targetNode.label = path.basename(newPath);
                targetNode.filePath = newPath;

                // 子孫要素のパスも更新（フォルダリネームの場合）
                this.updatePathRecursive(targetNode, oldPath, newPath);

                isChanged = true;
            }
        }

        if (isChanged) {
            this.saveAndRefresh();
        }
    }

    private updatePathRecursive(node: MyNode, oldPrefix: string, newPrefix: string) {
        // 子供がいる場合、再帰的にパスを置換
        if (node.children) {
            node.children.forEach(child => {
                if (child.filePath && child.filePath.startsWith(oldPrefix)) {
                    // パスの前方一致部分を置換
                    // 例: /old/dir/file.txt -> /new/dir/file.txt
                    // substringで正確に切り取る
                    const relativePath = child.filePath.substring(oldPrefix.length);
                    child.filePath = newPrefix + relativePath;
                }
                this.updatePathRecursive(child, oldPrefix, newPrefix);
            });
        }
    }

    // ★ 削除同期機能
    public handleFileDelete(files: readonly vscode.Uri[]) {
        let isChanged = false;
        for (const uri of files) {
            const node = this.pathIndex.get(uri.fsPath);
            if (node) {
                // 保存は最後にまとめて行うため false
                this.removeNode(node, false);
                isChanged = true;
            }
        }
        if (isChanged) {
            this.saveAndRefresh();
        }
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
            // ★ ファイルの場合は実際のファイルパスを表示
            treeItem.resourceUri = vscode.Uri.file(element.filePath);
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [treeItem.resourceUri]
            };
        } else {
            // ★ フォルダの場合はカスタムエクスプローラー内の論理パスを表示
            treeItem.resourceUri = this.getCustomExplorerUri(element);
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

    // ★ 設定から除外リストを読み取って判定するメソッド
    private shouldExclude(filePath: string): boolean {
        const config = vscode.workspace.getConfiguration('customExplorer');
        const excludes = config.get<string[]>('excludeExtensions') || [];

        const fileName = path.basename(filePath);

        // 拡張子またはファイル名の後方一致でチェック
        // 例: ".meta" が設定にある場合、"file.meta" は除外される
        return excludes.some(ext => fileName.endsWith(ext));
    }

    public importDirectory(dirPath: string, parent?: MyNode) {
        const dirName = path.basename(dirPath);

        // ★ ディレクトリ自体の名前も除外チェック
        if (this.shouldExclude(dirName)) return;

        const newGroupNode: MyNode = {
            id: this.generateId(),
            label: dirName,
            type: 'group',
            children: [],
            filePath: dirPath, // ★ 重要: フォルダの場合もパスを保存（リネーム追跡のため）
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

                    // ★ 除外設定にマッチしたらスキップ
                    if (this.shouldExclude(item.name)) continue;

                    if (item.isDirectory()) {
                        const subGroup: MyNode = {
                            id: this.generateId(),
                            label: item.name,
                            type: 'group',
                            children: [],
                            filePath: fullPath, // ★ サブフォルダもパス保持
                            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
                        };
                        parentNode.children = parentNode.children || [];
                        parentNode.children.push(subGroup);
                        scanRecursive(fullPath, subGroup);

                    } else if (item.isFile()) {
                        // .DS_Store はハードコードで除外しつつ、設定も見る
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

        // ★ 展開/折りたたみは論理パスに影響しないため、rebuildIndex()は不要
        this.sortNodesRecursive(this.data);
        this.context.workspaceState.update(this.storageKey, this.data);

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

        // ★ 展開/折りたたみは論理パスに影響しないため、rebuildIndex()は不要
        this.sortNodesRecursive(this.data);
        this.context.workspaceState.update(this.storageKey, this.data);

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
                if (target && target.type === 'group') {
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

        // ★ 設定チェック
        if (this.shouldExclude(fileName)) return;

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
        // ★ 修正: nodeがundefinedの場合のガードを追加
        if (!node) return false;

        const removeRecursive = (nodes: MyNode[]): boolean => {
            // node.id が undefined でないことを確認
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
            // 削除時はインデックス再構築が必要なためsaveAndRefreshを呼ぶ
        }
        return result;
    }

    public saveAndRefresh() {
        this.sortNodesRecursive(this.data);
        this.saveData();
        // コンテキストの更新
        this.updateContextKey();
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
        // コンテキストの初期化
        this.updateContextKey();
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }

    // ★ 追加: 空かどうかのコンテキストを更新するメソッド
    private updateContextKey() {
        // データが空なら true
        vscode.commands.executeCommand('setContext', 'customExplorer.isEmpty', this.data.length === 0);
    }
}