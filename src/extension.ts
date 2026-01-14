import * as vscode from 'vscode';
import * as path from 'path';

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

    const treeView = vscode.window.createTreeView('my-favorites-view', {
        treeDataProvider: treeDataProvider,
        dragAndDropController: treeDataProvider, 
        canSelectMany: true
    });

	context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addRootGroup', async () => {
        const label = await vscode.window.showInputBox({ prompt: 'Enter root group name' });
        if (!label) return;
        treeDataProvider.addGroup(label, undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addGroup', async (node?: MyNode) => {
        const label = await vscode.window.showInputBox({ prompt: 'Enter group name' });
        if (!label) return;
        treeDataProvider.addGroup(label, node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.removeEntry', (node: MyNode) => {
        treeDataProvider.removeNode(node);
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

class CustomTreeDataProvider implements vscode.TreeDataProvider<MyNode>, vscode.TreeDragAndDropController<MyNode> {
    
    private _onDidChangeTreeData: vscode.EventEmitter<MyNode | undefined | null | void> = new vscode.EventEmitter<MyNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MyNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private storageKey = 'customExplorerData';
    private data: MyNode[] = [];

    public dropMimeTypes = ['application/vnd.code.tree.customExplorer', 'text/uri-list'];
    public dragMimeTypes = ['application/vnd.code.tree.customExplorer'];

    constructor(private context: vscode.ExtensionContext) {
        this.loadData();
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

        const uriList = dataTransfer.get('text/uri-list');
        if (uriList) {
            const uriListString = await uriList.asString();
            const paths = uriListString.split('\r\n');
            for (const filePathUri of paths) {
                if (!filePathUri) continue;
                const uri = vscode.Uri.parse(filePathUri);
                this.addFile(uri.fsPath, target); 
            }
        }
    }

    // --- データ操作ロジック ---

    // ★ 修正: node が undefined ならルート直下の全アイテムを対象にする
    public collapseRecursive(node?: MyNode) {
        const targets = node ? [node] : this.data; // 対象リストを作成

        const resetNodeState = (targetNode: MyNode) => {
            if (targetNode.type === 'group') {
                targetNode.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                targetNode.id = this.generateId();
                
                if (targetNode.children) {
                    targetNode.children.forEach(child => resetNodeState(child));
                }
            }
        };

        // 対象すべてに適用
        targets.forEach(target => resetNodeState(target));
        
        this.saveData();

        if (node) {
            this.refreshParentOrRoot(node);
        } else {
            // 全体の場合はルートからリフレッシュ
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    // ★ 修正: node が undefined ならルート直下の全アイテムを対象にする
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
            this._onDidChangeTreeData.fire(parent as MyNode);
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
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }
}