import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';
import * as fs from 'fs';

// --- Constants ---
const VIEW_ID = 'custom-explorer-view';
const STORAGE_KEY = 'customExplorerData';
const CONTEXT_KEY_IS_EMPTY = 'customExplorer.isEmpty';
const MIME_INTERNAL = 'application/vnd.code.tree.customExplorer';
const URI_SCHEME = 'custom-explorer';
const DEFAULT_FOLDER_NAME = 'New Folder';

// --- Interfaces ---
interface StoredNode {
    id: string;
    label: string;
    type: 'group' | 'file' | 'linked-group';
    children?: StoredNode[];
    filePath?: string;
    linkedPath?: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
}

interface ExplorerNode extends StoredNode {
    children?: ExplorerNode[];
    cachedTreePath?: string;
}

export function activate(context: vscode.ExtensionContext) {
    const treeDataProvider = new CustomTreeDataProvider(context);

    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: treeDataProvider,
        dragAndDropController: treeDataProvider,
        canSelectMany: true
    });

    if (vscode.workspace.name) {
        treeView.title = vscode.workspace.name;
    }

    const syncTreeSelection = (editor: vscode.TextEditor | undefined) => {
        if (!editor || !editor.document || !treeView.visible) return;
        const foundNode = treeDataProvider.findNodeByPath(editor.document.uri.fsPath);
        if (foundNode) {
            treeView.reveal(foundNode, { select: true, focus: false, expand: true });
        }
    };

    syncTreeSelection(vscode.window.activeTextEditor);

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        syncTreeSelection(editor);
    }));

    const decorationProvider = new ProblemFileDecorationProvider(treeDataProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => {
        decorationProvider.fireDidChangeFileDecorations(e.uris);
    }));

    context.subscriptions.push(vscode.workspace.onDidRenameFiles(e => {
        treeDataProvider.handleFileRename(e.files);
    }));

    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(e => {
        treeDataProvider.handleFileDelete(e.files);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('files.exclude')) {
            treeDataProvider.refresh();
        }
    }));

    // --- Commands ---

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.importFromWorkspace', async () => {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: '追加',
            canSelectFiles: true,
            canSelectFolders: true
        };

        const fileUri = await vscode.window.showOpenDialog(options);

        if (fileUri && fileUri[0]) {
            const targetUri = fileUri[0];
            const stat = await vscode.workspace.fs.stat(targetUri);

            if (stat.type === vscode.FileType.Directory) {
                treeDataProvider.importDirectory(targetUri.fsPath);
            } else {
                treeDataProvider.addFile(targetUri.fsPath);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addGroup', async (node?: ExplorerNode) => {
        const label = await vscode.window.showInputBox({ prompt: 'フォルダ名を入力してください' });
        if (!label) return;
        treeDataProvider.addGroup(label, node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.addGroupToRoot', async () => {
        const label = await vscode.window.showInputBox({ prompt: 'フォルダ名を入力してください' });
        if (!label) return;
        treeDataProvider.addGroup(label, undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.createNewFolder', async (node?: ExplorerNode) => {
        treeDataProvider.addGroup(DEFAULT_FOLDER_NAME, node, vscode.TreeItemCollapsibleState.Collapsed);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.renameEntry', async (node: ExplorerNode) => {
        const newName = await vscode.window.showInputBox({
            prompt: '新しい名前を入力してください',
            value: node.label
        });
        if (!newName) return;
        treeDataProvider.renameNode(node, newName);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.removeEntry', (node?: ExplorerNode, nodes?: ExplorerNode[]) => {
        const targets: ExplorerNode[] = [];

        if (nodes && nodes.length > 0) {
            targets.push(...nodes);
        } else if (node) {
            targets.push(node);
        } else {
            if (treeView.selection.length > 0) {
                targets.push(...treeView.selection);
            }
        }

        if (targets.length === 0) return;

        targets.forEach(n => treeDataProvider.removeNode(n, false));
        treeDataProvider.saveAndRefresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.collapseRecursive', (node: ExplorerNode) => {
        treeDataProvider.collapseRecursive(node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.expandRecursive', (node: ExplorerNode) => {
        treeDataProvider.expandRecursive(node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.collapseAll', () => {
        treeDataProvider.collapseRecursive(undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.expandAll', () => {
        treeDataProvider.expandRecursive(undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('customExplorer.unlinkFolder', (node: ExplorerNode) => {
        treeDataProvider.unlinkFolder(node);
    }));

    context.subscriptions.push({ dispose: () => treeDataProvider.disposeAllWatchers() });
}

class ProblemFileDecorationProvider implements vscode.FileDecorationProvider {

    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    constructor(private treeDataProvider: CustomTreeDataProvider) { }

    provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        const node = this.treeDataProvider.getNodeByUri(uri);
        if (!node) return undefined;

        if (node.type === 'file') {
            return this.getDiagnosticDecoration(uri) ?? new vscode.FileDecoration();
        } else {
            return this.getGroupDecoration(node);
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

    private getGroupDecoration(groupNode: ExplorerNode): vscode.FileDecoration | undefined {
        if (!groupNode.children || groupNode.children.length === 0) return undefined;

        const result = this.traverseDiagnostics(groupNode.children);

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

    private traverseDiagnostics(nodes: ExplorerNode[]): 'error' | 'warning' | 'none' {
        let hasWarning = false;
        for (const child of nodes) {
            if (child.type === 'file' && child.filePath) {
                const diags = vscode.languages.getDiagnostics(vscode.Uri.file(child.filePath));
                if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Error)) return 'error';
                if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Warning)) hasWarning = true;
            } else if ((child.type === 'group' || child.type === 'linked-group') && child.children) {
                const result = this.traverseDiagnostics(child.children);
                if (result === 'error') return 'error';
                if (result === 'warning') hasWarning = true;
            }
        }
        return hasWarning ? 'warning' : 'none';
    }

    public fireDidChangeFileDecorations(uris: ReadonlyArray<vscode.Uri>) {
        const urisToUpdate = new Set<string>();

        for (const uri of uris) {
            urisToUpdate.add(uri.toString());

            const node = this.treeDataProvider.getNodeByUri(uri);
            if (node) {
                let parent = this.treeDataProvider.getParent(node);
                while (parent) {
                    const parentUri = this.treeDataProvider.getGroupUri(parent);
                    urisToUpdate.add(parentUri.toString());
                    parent = this.treeDataProvider.getParent(parent);
                }
            }
        }
        const uriList = Array.from(urisToUpdate).map(u => vscode.Uri.parse(u));
        this._onDidChangeFileDecorations.fire(uriList);
    }
}

class CustomTreeDataProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.TreeDragAndDropController<ExplorerNode> {

    private _onDidChangeTreeData: vscode.EventEmitter<ExplorerNode | undefined | null | void> = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ExplorerNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private data: ExplorerNode[] = [];
    private pathIndex: Map<string, ExplorerNode> = new Map();
    private uriToNodeMap: Map<string, ExplorerNode> = new Map();
    private watcherMap: Map<string, vscode.FileSystemWatcher> = new Map();

    public dropMimeTypes = [MIME_INTERNAL, 'text/uri-list', 'text/plain'];
    // +++ 'text/uri-list' を追加: linked-group / linked-group配下のgroupノードを外部へD&D可能にする
    public dragMimeTypes = [MIME_INTERNAL, 'text/uri-list'];

    constructor(private context: vscode.ExtensionContext) {
        this.loadData();
    }

    private isGroupLike(node: ExplorerNode): boolean {
        return node.type === 'group' || node.type === 'linked-group';
    }

    private isChildOfLinkedGroup(node: ExplorerNode): boolean {
        let current = this.getParent(node);
        while (current) {
            if (current.type === 'linked-group') {
                return true;
            }
            current = this.getParent(current);
        }
        return false;
    }

    public findNodeByPath(targetPath: string): ExplorerNode | undefined {
        return this.pathIndex.get(targetPath);
    }

    public getNodeByUri(uri: vscode.Uri): ExplorerNode | undefined {
        return this.uriToNodeMap.get(uri.toString());
    }

    public getGroupUri(node: ExplorerNode): vscode.Uri {
        return vscode.Uri.parse(`${URI_SCHEME}://group/${node.id}`);
    }

    public getCustomExplorerUri(node: ExplorerNode): vscode.Uri {
        const treePath = node.cachedTreePath || ('/' + node.label);
        return vscode.Uri.parse(`${URI_SCHEME}://tree${treePath}`);
    }

    private setupWatcher(node: ExplorerNode): void {
        if (node.type !== 'linked-group' || !node.linkedPath) {
            return;
        }

        try {
            const pattern = new vscode.RelativePattern(vscode.Uri.file(node.linkedPath), '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            watcher.onDidCreate(() => this.syncLinkedFolder(node));
            watcher.onDidDelete(() => this.syncLinkedFolder(node));
            watcher.onDidChange(() => this.syncLinkedFolder(node));

            this.watcherMap.set(node.id, watcher);
        } catch (err) {
            console.error(`Failed to setup watcher for ${node.linkedPath}:`, err);
        }
    }

    private disposeWatcher(nodeId: string): void {
        const watcher = this.watcherMap.get(nodeId);
        if (watcher) {
            watcher.dispose();
            this.watcherMap.delete(nodeId);
        }
    }

    public disposeAllWatchers(): void {
        for (const watcher of this.watcherMap.values()) {
            watcher.dispose();
        }
        this.watcherMap.clear();
    }

    private rebuildIndex() {
        this.pathIndex.clear();
        this.uriToNodeMap.clear();

        const traverse = (nodes: ExplorerNode[], parentPath: string = '') => {
            for (const node of nodes) {
                node.cachedTreePath = parentPath + '/' + node.label;

                if (node.filePath) {
                    this.pathIndex.set(node.filePath, node);
                    this.uriToNodeMap.set(vscode.Uri.file(node.filePath).toString(), node);
                }

                if (this.isGroupLike(node)) {
                    const groupUri = this.getGroupUri(node);
                    this.uriToNodeMap.set(groupUri.toString(), node);
                }

                const customUri = this.getCustomExplorerUri(node);
                this.uriToNodeMap.set(customUri.toString(), node);

                if (node.children) {
                    traverse(node.children, node.cachedTreePath);
                }
            }
        };
        traverse(this.data);
    }

    public handleFileRename(files: ReadonlyArray<{ oldUri: vscode.Uri, newUri: vscode.Uri }>) {
        let isChanged = false;

        for (const file of files) {
            const oldPath = file.oldUri.fsPath;
            const newPath = file.newUri.fsPath;
            const targetNode = this.pathIndex.get(oldPath);

            // Skip if the node is a child of a linked-group (handled by watcher)
            if (targetNode && this.isChildOfLinkedGroup(targetNode)) {
                continue;
            }

            if (targetNode) {
                targetNode.label = path.basename(newPath);
                targetNode.filePath = newPath;
                this.updatePathRecursive(targetNode, oldPath, newPath);
                isChanged = true;
            }
        }

        if (isChanged) {
            this.saveAndRefresh();
        }
    }

    private updatePathRecursive(node: ExplorerNode, oldPrefix: string, newPrefix: string) {
        if (node.children) {
            node.children.forEach(child => {
                if (child.filePath && child.filePath.startsWith(oldPrefix)) {
                    const relativePath = child.filePath.substring(oldPrefix.length);
                    child.filePath = newPrefix + relativePath;
                }
                this.updatePathRecursive(child, oldPrefix, newPrefix);
            });
        }
    }

    public handleFileDelete(files: readonly vscode.Uri[]) {
        let isChanged = false;
        for (const uri of files) {
            const node = this.pathIndex.get(uri.fsPath);
            // Skip if the node is a child of a linked-group (handled by watcher)
            if (node && !this.isChildOfLinkedGroup(node)) {
                this.removeNode(node, false);
                isChanged = true;
            }
        }
        if (isChanged) {
            this.saveAndRefresh();
        }
    }

    getTreeItem(element: ExplorerNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label,
            this.isGroupLike(element)
                ? (element.collapsibleState ?? vscode.TreeItemCollapsibleState.Expanded)
                : vscode.TreeItemCollapsibleState.None
        );

        // Determine contextValue
        if (element.type === 'linked-group') {
            treeItem.contextValue = 'linked-group';
        } else if (this.isChildOfLinkedGroup(element)) {
            treeItem.contextValue = element.type === 'file' ? 'linked-group-child-file' : 'linked-group-child';
        } else {
            treeItem.contextValue = element.type;
        }

        treeItem.id = element.id;

        if (element.type === 'file' && element.filePath) {
            treeItem.resourceUri = vscode.Uri.file(element.filePath);
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [treeItem.resourceUri]
            };
            if (!this.isChildOfLinkedGroup(element)) {
                const parentDir = path.basename(path.dirname(element.filePath));
                treeItem.description = parentDir ? `${parentDir}/` : undefined;
            }
        } else {
            treeItem.resourceUri = this.getCustomExplorerUri(element);
            treeItem.iconPath = vscode.ThemeIcon.Folder;
            if (element.type === 'linked-group') {
                const parentDir = element.linkedPath
                    ? path.basename(path.dirname(element.linkedPath))
                    : undefined;
                treeItem.description = parentDir ? `${parentDir}/` : undefined;
            }
        }
        return treeItem;
    }

    getChildren(element?: ExplorerNode): ExplorerNode[] {
        const nodes = element ? (element.children ?? []) : this.data;
        return nodes.filter(n => !n.filePath || !this.shouldExclude(n.filePath));
    }

    getParent(element: ExplorerNode): ExplorerNode | undefined {
        return this.findParent(this.data, element);
    }

    private findParent(nodes: ExplorerNode[], target: ExplorerNode): ExplorerNode | undefined {
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

    // --- Drag and Drop ---

    public handleDrag(source: readonly ExplorerNode[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
        dataTransfer.set(MIME_INTERNAL, new vscode.DataTransferItem(source));

        // +++ linked-group または linked-group配下のgroupノードを外部へD&Dできるよう
        // +++  実ファイルシステムパスを text/uri-list として追加する
        const uris: string[] = [];
        for (const node of source) {
            const fsPath = this.resolveFsPathForDrag(node);
            if (fsPath) {
                uris.push(vscode.Uri.file(fsPath).toString());
            }
        }
        if (uris.length > 0) {
            dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uris.join('\r\n')));
        }
    }

    // +++ ドラッグ対象ノードのファイルシステム上の実パスを解決する
    // +++   - linked-group            : linkedPath をそのまま返す
    // +++   - linked-group配下のgroup : 先祖のlinked-groupのlinkedPathから相対パスを算出
    // +++   - それ以外                : undefined (外部D&D不可)
    private resolveFsPathForDrag(node: ExplorerNode): string | undefined {
        if (node.type === 'linked-group' && node.linkedPath) {
            return node.linkedPath;
        }

        if (node.type === 'group' && this.isChildOfLinkedGroup(node)) {
            return this.resolveGroupFsPath(node);
        }

        return undefined;
    }

    // +++ linked-group配下のgroupノードの実パスを、先祖のlinked-groupを起点に解決する
    private resolveGroupFsPath(node: ExplorerNode): string | undefined {
        const segments: string[] = [node.label];
        let current = this.getParent(node);

        while (current) {
            if (current.type === 'linked-group' && current.linkedPath) {
                // セグメントを逆順にして linkedPath と結合
                segments.reverse();
                return path.join(current.linkedPath, ...segments);
            }
            segments.push(current.label);
            current = this.getParent(current);
        }

        return undefined;
    }

    public async handleDrop(target: ExplorerNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {

        const internalDrag = dataTransfer.get(MIME_INTERNAL);
        if (internalDrag) {
            const sources: ExplorerNode[] = internalDrag.value;
            this.moveNodes(sources, target);
            return;
        }

        // +++ 外部(OS)からのD&Dは linked-group およびその配下へのドロップを禁止する
        if (target && (target.type === 'linked-group' || this.isChildOfLinkedGroup(target))) {
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
            const paths = this.resolveDroppedPaths(uriString);
            for (const fsPath of paths) {
                const stat = fs.statSync(fsPath);
                if (stat.isDirectory()) {
                    this.addLinkedFolder(fsPath, target);
                } else {
                    this.addFile(fsPath, target);
                }
            }
        }
    }

    private resolveDroppedPaths(uriString: string): string[] {
        return uriString
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(raw => raw.startsWith('file://') ? vscode.Uri.parse(raw).fsPath : raw)
            .filter(p => fs.existsSync(p));
    }

    // --- Data Operations ---

    private shouldExclude(filePath: string): boolean {
        const config = vscode.workspace.getConfiguration('files', vscode.Uri.file(filePath));
        const excludes = config.get<{ [key: string]: boolean }>('exclude') || {};

        const relativePath = vscode.workspace.asRelativePath(filePath, false).split(path.sep).join('/');
        const fileName = path.basename(filePath);

        for (const pattern in excludes) {
            if (excludes[pattern]) {
                // Pattern without '/' matches by basename; pattern with '/' matches by relative path
                const hasSlash = pattern.includes('/');

                if (!hasSlash) {
                    if (minimatch(fileName, pattern, { dot: true })) return true;
                } else {
                    if (pattern.endsWith('/')) {
                        if (relativePath.startsWith(pattern) || relativePath === pattern.slice(0, -1)) return true;
                    }

                    if (minimatch(relativePath, pattern, { dot: true })) return true;
                }

                if (minimatch(relativePath, pattern, { dot: true, matchBase: true })) return true;
            }
        }
        return false;
    }

    public refresh() {
        this._onDidChangeTreeData.fire();
    }

    private syncLinkedFolder(node: ExplorerNode): void {
        if (node.type !== 'linked-group' || !node.linkedPath) {
            return;
        }

        if (!fs.existsSync(node.linkedPath)) {
            node.children = [];
            this.saveAndRefresh();
            return;
        }

        const scanRecursive = (currentPath: string, parentNode: ExplorerNode) => {
            try {
                const items = fs.readdirSync(currentPath, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(currentPath, item.name);

                    if (this.shouldExclude(item.name)) {
                        continue;
                    }

                    if (item.isSymbolicLink()) {
                        continue;
                    }

                    if (item.isDirectory()) {
                        const subGroup: ExplorerNode = {
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
                        if (item.name === '.DS_Store') {
                            continue;
                        }

                        const fileNode: ExplorerNode = {
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
                console.error(`Failed to sync linked folder: ${currentPath}`, err);
            }
        };

        node.children = [];
        scanRecursive(node.linkedPath, node);
        this.saveAndRefresh();
    }

    public importDirectory(dirPath: string, parent?: ExplorerNode) {
        const dirName = path.basename(dirPath);

        if (this.shouldExclude(dirName)) return;

        const newGroupNode: ExplorerNode = {
            id: this.generateId(),
            label: dirName,
            type: 'group',
            children: [],
            filePath: dirPath,
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        };

        this.appendToParent(newGroupNode, parent);

        const scanRecursive = (currentPath: string, parentNode: ExplorerNode) => {
            try {
                const items = fs.readdirSync(currentPath, { withFileTypes: true });

                for (const item of items) {
                    const fullPath = path.join(currentPath, item.name);

                    if (this.shouldExclude(item.name)) continue;

                    if (item.isDirectory()) {
                        const subGroup: ExplorerNode = {
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

                        const fileNode: ExplorerNode = {
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

    public renameNode(node: ExplorerNode, newName: string) {
        node.label = newName;
        this.saveAndRefresh();
    }

    public collapseRecursive(node?: ExplorerNode) {
        this.applyCollapsibleState(node, vscode.TreeItemCollapsibleState.Collapsed);
    }

    public expandRecursive(node?: ExplorerNode) {
        this.applyCollapsibleState(node, vscode.TreeItemCollapsibleState.Expanded);
    }

    private applyCollapsibleState(node: ExplorerNode | undefined, state: vscode.TreeItemCollapsibleState) {
        const targets = node ? [node] : this.data;
        targets.forEach(t => this.setCollapsibleStateRecursive(t, state));
        this.context.workspaceState.update(STORAGE_KEY, this.data);

        if (node) {
            this.refreshParentOrRoot(node);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private setCollapsibleStateRecursive(node: ExplorerNode, state: vscode.TreeItemCollapsibleState) {
        if (this.isGroupLike(node)) {
            node.collapsibleState = state;
            node.id = this.generateId();
            node.children?.forEach(child => this.setCollapsibleStateRecursive(child, state));
        }
    }

    private refreshParentOrRoot(node: ExplorerNode) {
        const parent = this.getParent(node);
        if (parent) {
            this._onDidChangeTreeData.fire(parent);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private moveNodes(sources: ExplorerNode[], target: ExplorerNode | undefined) {
        const isValidMove = (source: ExplorerNode, target?: ExplorerNode): boolean => {
            // Cannot move linked-group children
            if (this.isChildOfLinkedGroup(source)) {
                return false;
            }
            // Cannot move into linked-group or any node inside linked-group
            if (target && (target.type === 'linked-group' || this.isChildOfLinkedGroup(target))) {
                return false;
            }
            if (source === target) return false;
            if (!target) return true;
            const isDescendant = (parent: ExplorerNode, potentialChild: ExplorerNode): boolean => {
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
                if (target && this.isGroupLike(target)) {
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

    public addGroup(label: string, parent?: ExplorerNode, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded) {
        const newNode: ExplorerNode = {
            id: this.generateId(),
            label,
            type: 'group',
            children: [],
            collapsibleState
        };
        this.appendToParent(newNode, parent);
        this.saveAndRefresh();
    }

    public addFile(filePath: string, parent?: ExplorerNode) {
        const fileName = path.basename(filePath);

        if (this.shouldExclude(fileName)) return;

        const newNode: ExplorerNode = {
            id: this.generateId(),
            label: fileName,
            type: 'file',
            filePath: filePath
        };

        this.appendToParent(newNode, parent);
        this.saveAndRefresh();
    }

    public addLinkedFolder(dirPath: string, parent?: ExplorerNode) {
        const dirName = path.basename(dirPath);

        if (this.shouldExclude(dirName)) {
            return;
        }

        const newNode: ExplorerNode = {
            id: this.generateId(),
            label: dirName,
            type: 'linked-group',
            linkedPath: dirPath,
            children: [],
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
        };

        this.appendToParent(newNode, parent);
        this.syncLinkedFolder(newNode);
        this.setupWatcher(newNode);
    }

    public unlinkFolder(node: ExplorerNode): void {
        if (node.type !== 'linked-group') {
            return;
        }

        this.disposeWatcher(node.id);
        node.type = 'group';
        node.linkedPath = undefined;

        this.saveAndRefresh();
    }

    private appendToParent(node: ExplorerNode, parent?: ExplorerNode) {
        if (parent && this.isGroupLike(parent)) {
            parent.children = parent.children ?? [];
            parent.children.push(node);
            parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        } else {
            this.data.push(node);
        }
    }

    public removeNode(node: ExplorerNode, shouldSave: boolean = true): boolean {
        if (!node) return false;

        // Cannot remove linked-group children
        if (this.isChildOfLinkedGroup(node)) {
            return false;
        }

        // Dispose watcher if removing linked-group
        if (node.type === 'linked-group') {
            this.disposeWatcher(node.id);
        }

        const removeRecursive = (nodes: ExplorerNode[]): boolean => {
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

    public saveAndRefresh() {
        this.saveData();
        this.updateContextKey();
        this._onDidChangeTreeData.fire();
    }

    private saveData() {
        this.sortNodesRecursive(this.data);
        this.rebuildIndex();
        this.context.workspaceState.update(STORAGE_KEY, this.data);
    }

    private sortNodesRecursive(nodes: ExplorerNode[]) {
        nodes.sort((a, b) => {
            const aIsGroupLike = this.isGroupLike(a);
            const bIsGroupLike = this.isGroupLike(b);
            if (aIsGroupLike && !bIsGroupLike) { return -1; }
            if (!aIsGroupLike && bIsGroupLike) { return 1; }
            return a.label.localeCompare(b.label);
        });

        nodes.forEach(node => {
            if (node.children && node.children.length > 0) {
                this.sortNodesRecursive(node.children);
            }
        });
    }

    private loadData() {
        this.data = this.context.workspaceState.get<ExplorerNode[]>(STORAGE_KEY) || [];
        this.rebuildIndex();
        this.updateContextKey();

        // Restore watchers for linked-groups
        const restoreWatchers = (nodes: ExplorerNode[]) => {
            for (const node of nodes) {
                if (node.type === 'linked-group') {
                    this.syncLinkedFolder(node);
                    this.setupWatcher(node);
                }
                if (node.children) {
                    restoreWatchers(node.children);
                }
            }
        };
        restoreWatchers(this.data);
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }

    private updateContextKey() {
        vscode.commands.executeCommand('setContext', CONTEXT_KEY_IS_EMPTY, this.data.length === 0);
    }
}