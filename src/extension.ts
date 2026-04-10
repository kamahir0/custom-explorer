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
const DEFAULT_FOLDER_NAME = 'New Group';

// 診断レベルに対応するデコレーション定義（起動時に1度だけ生成）
const SEVERITY_DECORATION = {
    error: {
        badge: '●',
        color: new vscode.ThemeColor('list.errorForeground'),
        tooltip: 'Errors detected',
    },
    warning: {
        badge: '●',
        color: new vscode.ThemeColor('list.warningForeground'),
        tooltip: 'Warnings detected',
    },
} as const;

const GROUP_SEVERITY_DECORATION = {
    error: {
        badge: '●',
        color: new vscode.ThemeColor('list.errorForeground'),
        tooltip: 'Error in children',
    },
    warning: {
        badge: '●',
        color: new vscode.ThemeColor('list.warningForeground'),
        tooltip: 'Warning in children',
    },
} as const;

// --- Interfaces ---
interface StoredNode {
    id: string;
    label: string;
    type: 'group' | 'file-ref' | 'folder-ref';
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
        canSelectMany: true,
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

    const decorationProvider = new ProblemFileDecorationProvider(treeDataProvider);

    // --- イベント購読 ---
    const eventSubscriptions = [
        vscode.window.onDidChangeActiveTextEditor(editor => syncTreeSelection(editor)),
        vscode.window.registerFileDecorationProvider(decorationProvider),
        vscode.languages.onDidChangeDiagnostics(e => decorationProvider.fireDidChangeFileDecorations(e.uris)),
        vscode.workspace.onDidRenameFiles(e => treeDataProvider.handleFileRename(e.files)),
        vscode.workspace.onDidDeleteFiles(e => treeDataProvider.handleFileDelete(e.files)),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('files.exclude')) treeDataProvider.refresh();
            if (
                e.affectsConfiguration('explorer.sortOrder') ||
                e.affectsConfiguration('explorer.sortOrderLexicographicOptions')
            ) treeDataProvider.saveAndRefresh();
        }),
        { dispose: () => treeDataProvider.disposeAllWatchers() },
    ];

    // --- コマンド定義テーブル ---
    const commandTable: [string, (...args: any[]) => any][] = [
        ['customExplorer.importFromWorkspace', async () => {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: '追加',
                canSelectFiles: true,
                canSelectFolders: true,
            });
            if (!fileUri?.[0]) return;
            const targetUri = fileUri[0];
            const stat = await vscode.workspace.fs.stat(targetUri);
            if (stat.type === vscode.FileType.Directory) {
                treeDataProvider.importDirectory(targetUri.fsPath);
            } else {
                treeDataProvider.addFile(targetUri.fsPath);
            }
        }],

        ['customExplorer.addGroup', async (node?: ExplorerNode) => {
            const label = await vscode.window.showInputBox({ prompt: 'グループ名を入力してください' });
            if (!label) return;
            treeDataProvider.addGroup(label, node);
        }],

        ['customExplorer.addGroupToRoot', async () => {
            const label = await vscode.window.showInputBox({ prompt: 'グループ名を入力してください' });
            if (!label) return;
            treeDataProvider.addGroup(label, undefined);
        }],

        ['customExplorer.createNewFolder', (node?: ExplorerNode) => {
            treeDataProvider.addGroup(DEFAULT_FOLDER_NAME, node, vscode.TreeItemCollapsibleState.Collapsed);
        }],

        ['customExplorer.renameEntry', async (node: ExplorerNode) => {
            // folder-ref などの名前変更をブロックし、group のみに限定する
            if (node.type !== 'group') return;

            const newName = await vscode.window.showInputBox({
                prompt: '新しい名前を入力してください',
                value: node.label,
            });
            if (!newName) return;
            treeDataProvider.renameNode(node, newName);
        }],

        ['customExplorer.removeEntry', (node?: ExplorerNode, nodes?: ExplorerNode[]) => {
            const targets = nodes?.length ? nodes
                : node ? [node]
                    : [...treeView.selection];
            if (targets.length === 0) return;
            targets.forEach(n => treeDataProvider.removeNode(n, false));
            treeDataProvider.saveAndRefresh();
        }],

        ['customExplorer.collapseRecursive', (node: ExplorerNode) => treeDataProvider.collapseRecursive(node)],
        ['customExplorer.expandRecursive', (node: ExplorerNode) => treeDataProvider.expandRecursive(node)],
        ['customExplorer.collapseAll', () => treeDataProvider.collapseRecursive(undefined)],
        ['customExplorer.expandAll', () => treeDataProvider.expandRecursive(undefined)],
        ['customExplorer.convertToGroup', (node: ExplorerNode) => treeDataProvider.convertToGroup(node)],
    ];

    context.subscriptions.push(
        ...eventSubscriptions,
        ...commandTable.map(([id, handler]) => vscode.commands.registerCommand(id, handler)),
    );
}

// ---------------------------------------------------------------------------
// ProblemFileDecorationProvider
// ---------------------------------------------------------------------------

class ProblemFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(private treeDataProvider: CustomTreeDataProvider) { }

    provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        const node = this.treeDataProvider.getNodeByUri(uri);
        if (!node) return undefined;

        return node.type === 'file-ref'
            ? (this.getDiagnosticDecoration(uri) ?? new vscode.FileDecoration())
            : this.getGroupDecoration(node);
    }

    private getDiagnosticDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (!diagnostics.length) return undefined;

        const severity =
            diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error) ? 'error' :
                diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Warning) ? 'warning' : null;

        return severity ? SEVERITY_DECORATION[severity] : undefined;
    }

    private getGroupDecoration(groupNode: ExplorerNode): vscode.FileDecoration | undefined {
        if (!groupNode.children?.length) return undefined;

        const result = this.traverseDiagnostics(groupNode.children);
        if (result === 'none') return undefined;
        return GROUP_SEVERITY_DECORATION[result];
    }

    private traverseDiagnostics(nodes: ExplorerNode[]): 'error' | 'warning' | 'none' {
        let hasWarning = false;
        for (const child of nodes) {
            if (child.type === 'file-ref' && child.filePath) {
                const diags = vscode.languages.getDiagnostics(vscode.Uri.file(child.filePath));
                if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Error)) return 'error';
                if (diags.some(d => d.severity === vscode.DiagnosticSeverity.Warning)) hasWarning = true;
            } else if (this.isGroupLike(child) && child.children) {
                const result = this.traverseDiagnostics(child.children);
                if (result === 'error') return 'error';
                if (result === 'warning') hasWarning = true;
            }
        }
        return hasWarning ? 'warning' : 'none';
    }

    private isGroupLike(node: ExplorerNode): boolean {
        return node.type === 'group' || node.type === 'folder-ref';
    }

    public fireDidChangeFileDecorations(uris: ReadonlyArray<vscode.Uri>) {
        const urisToUpdate = new Set<string>();

        for (const uri of uris) {
            urisToUpdate.add(uri.toString());

            const node = this.treeDataProvider.getNodeByUri(uri);
            if (node) {
                let parent = this.treeDataProvider.getParent(node);
                while (parent) {
                    urisToUpdate.add(this.treeDataProvider.getGroupUri(parent).toString());
                    parent = this.treeDataProvider.getParent(parent);
                }
            }
        }

        this._onDidChangeFileDecorations.fire(
            Array.from(urisToUpdate).map(u => vscode.Uri.parse(u))
        );
    }
}

// ---------------------------------------------------------------------------
// CustomTreeDataProvider
// ---------------------------------------------------------------------------

class CustomTreeDataProvider implements
    vscode.TreeDataProvider<ExplorerNode>,
    vscode.TreeDragAndDropController<ExplorerNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private data: ExplorerNode[] = [];
    private pathIndex: Map<string, ExplorerNode> = new Map();
    private uriToNodeMap: Map<string, ExplorerNode> = new Map();
    private parentMap: Map<ExplorerNode, ExplorerNode> = new Map();
    private watcherMap: Map<string, vscode.FileSystemWatcher> = new Map();

    public dropMimeTypes = [MIME_INTERNAL, 'text/uri-list', 'text/plain'];
    // 'text/uri-list' を追加: folder-ref / folder-ref配下のgroupノードを外部へD&D可能にする
    public dragMimeTypes = [MIME_INTERNAL, 'text/uri-list'];

    constructor(private context: vscode.ExtensionContext) {
        this.loadData();
    }

    // --- ノード判定ヘルパー ---

    private isGroupLike(node: ExplorerNode): boolean {
        return node.type === 'group' || node.type === 'folder-ref';
    }

    private isChildOfFolderRef(node: ExplorerNode): boolean {
        let current = this.parentMap.get(node);
        while (current) {
            if (current.type === 'folder-ref') return true;
            current = this.parentMap.get(current);
        }
        return false;
    }

    // --- ノード生成ファクトリ ---

    private createFileNode(label: string, filePath: string): ExplorerNode {
        return { id: this.generateId(), label, type: 'file-ref', filePath };
    }

    private createGroupNode(
        label: string,
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded
    ): ExplorerNode {
        return { id: this.generateId(), label, type: 'group', children: [], collapsibleState };
    }

    private createFolderRefNode(label: string, linkedPath: string): ExplorerNode {
        return {
            id: this.generateId(),
            label,
            type: 'folder-ref',
            linkedPath,
            children: [],
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        };
    }

    // --- 公開ルックアップAPI ---

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

    // --- ファイルシステムウォッチャー ---

    private setupWatcher(node: ExplorerNode): void {
        if (node.type !== 'folder-ref' || !node.linkedPath) return;
        try {
            const pattern = new vscode.RelativePattern(vscode.Uri.file(node.linkedPath), '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            const sync = () => this.syncFolderRef(node);
            watcher.onDidCreate(sync);
            watcher.onDidDelete(sync);
            watcher.onDidChange(sync);
            this.watcherMap.set(node.id, watcher);
        } catch (err) {
            console.error(`Failed to setup watcher for ${node.linkedPath}:`, err);
        }
    }

    private disposeWatcher(nodeId: string): void {
        const watcher = this.watcherMap.get(nodeId);
        if (!watcher) return;
        watcher.dispose();
        this.watcherMap.delete(nodeId);
    }

    public disposeAllWatchers(): void {
        for (const watcher of this.watcherMap.values()) watcher.dispose();
        this.watcherMap.clear();
    }

    // --- インデックス管理 ---

    private rebuildIndex() {
        this.pathIndex.clear();
        this.uriToNodeMap.clear();
        this.parentMap.clear();

        const traverse = (nodes: ExplorerNode[], parentPath = '', parent?: ExplorerNode) => {
            for (const node of nodes) {
                node.cachedTreePath = `${parentPath}/${node.label}`;

                if (parent) this.parentMap.set(node, parent);

                if (node.filePath) {
                    this.pathIndex.set(node.filePath, node);
                    this.uriToNodeMap.set(vscode.Uri.file(node.filePath).toString(), node);
                }

                if (this.isGroupLike(node)) {
                    this.uriToNodeMap.set(this.getGroupUri(node).toString(), node);
                }

                this.uriToNodeMap.set(this.getCustomExplorerUri(node).toString(), node);

                if (node.children) traverse(node.children, node.cachedTreePath, node);
            }
        };
        traverse(this.data);
    }

    // --- ファイル変更ハンドラ ---

    public handleFileRename(files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>) {
        let isChanged = false;

        for (const file of files) {
            const oldPath = file.oldUri.fsPath;
            const newPath = file.newUri.fsPath;
            const targetNode = this.pathIndex.get(oldPath);

            // folder-ref配下のノードはウォッチャーが処理するためスキップ
            if (!targetNode || this.isChildOfFolderRef(targetNode)) continue;

            targetNode.label = path.basename(newPath);
            targetNode.filePath = newPath;
            this.updatePathRecursive(targetNode, oldPath, newPath);
            isChanged = true;
        }

        if (isChanged) this.saveAndRefresh();
    }

    private updatePathRecursive(node: ExplorerNode, oldPrefix: string, newPrefix: string) {
        node.children?.forEach(child => {
            if (child.filePath?.startsWith(oldPrefix)) {
                child.filePath = newPrefix + child.filePath.substring(oldPrefix.length);
            }
            this.updatePathRecursive(child, oldPrefix, newPrefix);
        });
    }

    public handleFileDelete(files: readonly vscode.Uri[]) {
        let isChanged = false;
        for (const uri of files) {
            const node = this.pathIndex.get(uri.fsPath);
            // folder-ref配下のノードはウォッチャーが処理するためスキップ
            if (node && !this.isChildOfFolderRef(node)) {
                this.removeNode(node, false);
                isChanged = true;
            }
        }
        if (isChanged) this.saveAndRefresh();
    }

    // --- TreeDataProvider実装 ---

    getTreeItem(element: ExplorerNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label,
            this.isGroupLike(element)
                ? (element.collapsibleState ?? vscode.TreeItemCollapsibleState.Expanded)
                : vscode.TreeItemCollapsibleState.None
        );

        treeItem.id = element.id;
        treeItem.contextValue = this.resolveContextValue(element);

        if (element.type === 'file-ref' && element.filePath) {
            treeItem.resourceUri = vscode.Uri.file(element.filePath);
            treeItem.command = { command: 'vscode.open', title: 'Open File', arguments: [treeItem.resourceUri] };
            if (!this.isChildOfFolderRef(element)) {
                const parentDir = path.basename(path.dirname(element.filePath));
                treeItem.description = parentDir ? `${parentDir}/` : undefined;
            }
        } else {
            treeItem.resourceUri = this.getCustomExplorerUri(element);
            treeItem.iconPath = vscode.ThemeIcon.Folder;
            if (element.type === 'folder-ref' && element.linkedPath) {
                const parentDir = path.basename(path.dirname(element.linkedPath));
                treeItem.description = parentDir ? `${parentDir}/` : undefined;
            }
        }

        return treeItem;
    }

    private resolveContextValue(element: ExplorerNode): string {
        if (element.type === 'folder-ref') return 'folder-ref';
        if (this.isChildOfFolderRef(element)) {
            return element.type === 'file-ref' ? 'folder-ref-child-file' : 'folder-ref-child-folder';
        }
        return element.type; // 'group' or 'file-ref'
    }

    getChildren(element?: ExplorerNode): ExplorerNode[] {
        const nodes = element ? (element.children ?? []) : this.data;
        return nodes.filter(n => !n.filePath || !this.shouldExclude(n.filePath));
    }

    getParent(element: ExplorerNode): ExplorerNode | undefined {
        return this.parentMap.get(element);
    }

    // --- ドラッグ＆ドロップ ---

    public handleDrag(source: readonly ExplorerNode[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
        dataTransfer.set(MIME_INTERNAL, new vscode.DataTransferItem(source));

        // folder-ref または folder-ref配下のgroupノードを外部へD&DできるようURIを追加
        const uris = source
            .map(node => this.resolveFsPathForDrag(node))
            .filter((p): p is string => p !== undefined)
            .map(p => vscode.Uri.file(p).toString());

        if (uris.length > 0) {
            dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uris.join('\r\n')));
        }
    }

    // ドラッグ対象ノードのファイルシステム上の実パスを解決する
    //   - folder-ref            : linkedPath をそのまま返す
    //   - folder-ref配下のgroup : 先祖のfolder-refのlinkedPathから相対パスを算出
    //   - それ以外              : undefined（外部D&D不可）
    private resolveFsPathForDrag(node: ExplorerNode): string | undefined {
        if (node.type === 'folder-ref' && node.linkedPath) return node.linkedPath;
        if (node.type === 'group' && this.isChildOfFolderRef(node)) return this.resolveGroupFsPath(node);
        return undefined;
    }

    // folder-ref配下のgroupノードの実パスを、先祖のfolder-refを起点に解決する
    private resolveGroupFsPath(node: ExplorerNode): string | undefined {
        const segments: string[] = [node.label];
        let current = this.getParent(node);

        while (current) {
            if (current.type === 'folder-ref' && current.linkedPath) {
                return path.join(current.linkedPath, ...segments.reverse());
            }
            segments.push(current.label);
            current = this.getParent(current);
        }

        return undefined;
    }

    public async handleDrop(target: ExplorerNode | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
        const internalDrag = dataTransfer.get(MIME_INTERNAL);
        if (internalDrag) {
            const sources: ExplorerNode[] = internalDrag.value;
            this.moveNodes(sources, target);
            return;
        }

        // 外部(OS)からのD&Dは folder-ref およびその配下へのドロップを禁止する
        if (target && (target.type === 'folder-ref' || this.isChildOfFolderRef(target))) return;

        const uriListItem = dataTransfer.get('text/uri-list');
        const plainTextItem = dataTransfer.get('text/plain');
        const uriString = uriListItem ? await uriListItem.asString()
            : plainTextItem ? await plainTextItem.asString()
                : '';

        if (!uriString) return;

        const paths = this.resolveDroppedPaths(uriString);
        for (const fsPath of paths) {
            if (fs.statSync(fsPath).isDirectory()) {
                this.addFolderRef(fsPath, target);
            } else {
                this.addFile(fsPath, target);
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

    // --- データ操作 ---

    private shouldExclude(filePath: string): boolean {
        const config = vscode.workspace.getConfiguration('files', vscode.Uri.file(filePath));
        const excludes = config.get<{ [key: string]: boolean }>('exclude') || {};

        const relativePath = vscode.workspace.asRelativePath(filePath, false).split(path.sep).join('/');
        const fileName = path.basename(filePath);

        for (const pattern in excludes) {
            if (!excludes[pattern]) continue;

            const hasSlash = pattern.includes('/');
            if (!hasSlash && minimatch(fileName, pattern, { dot: true })) return true;

            if (hasSlash) {
                if (pattern.endsWith('/') && (relativePath.startsWith(pattern) || relativePath === pattern.slice(0, -1))) return true;
                if (minimatch(relativePath, pattern, { dot: true })) return true;
            }

            if (minimatch(relativePath, pattern, { dot: true, matchBase: true })) return true;
        }
        return false;
    }

    public refresh() {
        this._onDidChangeTreeData.fire();
    }

    // ディレクトリを再帰的にスキャンしてノードを生成する共通処理
    // skipSymlinks: folder-ref同期時のみ true（シンボリックリンクをスキップ）
    private scanDirectory(currentPath: string, parentNode: ExplorerNode, options: { skipSymlinks: boolean }): void {
        try {
            const items = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const item of items) {
                if (this.shouldExclude(item.name)) continue;
                if (options.skipSymlinks && item.isSymbolicLink()) continue;
                if (item.name === '.DS_Store') continue;

                const fullPath = path.join(currentPath, item.name);

                if (item.isDirectory()) {
                    const subGroup = this.createGroupNode(item.name, vscode.TreeItemCollapsibleState.Collapsed);
                    (parentNode.children ??= []).push(subGroup);
                    this.scanDirectory(fullPath, subGroup, options);
                } else if (item.isFile()) {
                    (parentNode.children ??= []).push(this.createFileNode(item.name, fullPath));
                }
            }
        } catch (err) {
            console.error(`Failed to scan directory: ${currentPath}`, err);
        }
    }

    private syncFolderRef(node: ExplorerNode): void {
        if (node.type !== 'folder-ref' || !node.linkedPath) return;

        if (!fs.existsSync(node.linkedPath)) {
            node.children = [];
            this.saveAndRefresh();
            return;
        }

        node.children = [];
        this.scanDirectory(node.linkedPath, node, { skipSymlinks: true });
        this.saveAndRefresh();
    }

    public importDirectory(dirPath: string, parent?: ExplorerNode) {
        const dirName = path.basename(dirPath);
        if (this.shouldExclude(dirName)) return;

        const newGroupNode: ExplorerNode = {
            ...this.createGroupNode(dirName),
            filePath: dirPath,
        };

        this.appendToParent(newGroupNode, parent);
        this.scanDirectory(dirPath, newGroupNode, { skipSymlinks: false });
        this.saveAndRefresh();
    }

    public addGroup(
        label: string,
        parent?: ExplorerNode,
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded
    ) {
        this.appendToParent(this.createGroupNode(label, collapsibleState), parent);
        this.saveAndRefresh();
    }

    public addFile(filePath: string, parent?: ExplorerNode) {
        const fileName = path.basename(filePath);
        if (this.shouldExclude(fileName)) return;
        this.appendToParent(this.createFileNode(fileName, filePath), parent);
        this.saveAndRefresh();
    }

    public addFolderRef(dirPath: string, parent?: ExplorerNode) {
        const dirName = path.basename(dirPath);
        if (this.shouldExclude(dirName)) return;

        const newNode = this.createFolderRefNode(dirName, dirPath);
        this.appendToParent(newNode, parent);
        this.syncFolderRef(newNode);
        this.setupWatcher(newNode);
    }

    public convertToGroup(node: ExplorerNode): void {
        if (node.type !== 'folder-ref') return;
        this.disposeWatcher(node.id);
        node.type = 'group';
        node.linkedPath = undefined;
        this.saveAndRefresh();
    }

    private appendToParent(node: ExplorerNode, parent?: ExplorerNode) {
        if (parent && this.isGroupLike(parent)) {
            (parent.children ??= []).push(node);
            parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        } else {
            this.data.push(node);
        }
    }

    public removeNode(node: ExplorerNode, shouldSave = true): boolean {
        if (!node) return false;
        if (this.isChildOfFolderRef(node)) return false;
        if (node.type === 'folder-ref') this.disposeWatcher(node.id);

        const removeRecursive = (nodes: ExplorerNode[]): boolean => {
            const index = nodes.findIndex(n => n.id === node.id);
            if (index !== -1) {
                nodes.splice(index, 1);
                return true;
            }
            return nodes.some(n => n.children && removeRecursive(n.children));
        };

        const result = removeRecursive(this.data);
        if (shouldSave && result) this.saveAndRefresh();
        return result;
    }

    private moveNodes(sources: ExplorerNode[], target: ExplorerNode | undefined) {
        const isDescendant = (parent: ExplorerNode, potentialChild: ExplorerNode): boolean =>
            parent.children?.some(child => child === potentialChild || isDescendant(child, potentialChild)) ?? false;

        const isValidMove = (source: ExplorerNode, target?: ExplorerNode): boolean => {
            if (this.isChildOfFolderRef(source)) return false;
            if (target && (target.type === 'folder-ref' || this.isChildOfFolderRef(target))) return false;
            if (source === target) return false;
            if (!target) return true;
            return !isDescendant(source, target);
        };

        let isChanged = false;
        for (const source of sources) {
            if (!isValidMove(source, target)) continue;
            if (!this.removeNode(source, false)) continue;

            if (target && this.isGroupLike(target)) {
                (target.children ??= []).push(source);
                target.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            } else {
                this.data.push(source);
            }
            isChanged = true;
        }

        if (isChanged) this.saveAndRefresh();
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
        // setCollapsibleStateRecursive でIDが再生成されるため、インデックスを再構築する
        this.rebuildIndex();
        this.context.workspaceState.update(STORAGE_KEY, this.data);

        if (node) {
            this.refreshParentOrRoot(node);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private setCollapsibleStateRecursive(node: ExplorerNode, state: vscode.TreeItemCollapsibleState) {
        if (!this.isGroupLike(node)) return;
        node.collapsibleState = state;
        node.id = this.generateId();
        node.children?.forEach(child => this.setCollapsibleStateRecursive(child, state));
    }

    private refreshParentOrRoot(node: ExplorerNode) {
        const parent = this.getParent(node);
        this._onDidChangeTreeData.fire(parent ?? undefined);
    }

    // --- 永続化 ---

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

    // ---------------------------------------------------------------------------
    // VSCode標準エクスプローラと同等のソート
    // ---------------------------------------------------------------------------

    /**
     * explorer.sortOrder / explorer.sortOrderLexicographicOptions を読み取り、
     * 標準エクスプローラと同等のソート順でノードを再帰的に並べ替える。
     *
     * sortOrder の対応状況:
     *   default         : フォルダ優先 → 名前の自然順 (localeCompare)
     *   mixed           : 型混在で名前順
     *   filesFirst      : ファイル優先 → 名前順
     *   type            : 拡張子順 → 名前順
     *   modified        : 更新日時降順（groupは先頭固定、取得失敗時は名前順にフォールバック）
     *   foldersNestsFiles: ツリー構造変更を伴うため非対応。defaultと同じ挙動にフォールバック
     *
     * group/folder-ref の優先度:
     *   フォルダ優先系  : group(0) > folder-ref(1) > file-ref(2)
     *   ファイル優先系  : file-ref(0) > folder-ref(1) > group(2)
     *   mixed          : 型による優先度なし（名前のみで比較）
     */
    private sortNodesRecursive(nodes: ExplorerNode[]): void {
        const explorerConfig = vscode.workspace.getConfiguration('explorer');
        const sortOrder = explorerConfig.get<string>('sortOrder') ?? 'default';
        const lexOption = explorerConfig.get<string>('sortOrderLexicographicOptions') ?? 'default';

        const collator = this.buildCollator(lexOption);
        const compareFn = this.buildCompareFn(sortOrder, collator);

        this.sortNodesRecursiveWith(nodes, compareFn);
    }

    private sortNodesRecursiveWith(
        nodes: ExplorerNode[],
        compareFn: (a: ExplorerNode, b: ExplorerNode) => number
    ): void {
        nodes.sort(compareFn);
        nodes.forEach(node => {
            if (node.children?.length) this.sortNodesRecursiveWith(node.children, compareFn);
        });
    }

    /**
     * lexicographicOptions に基づいた Intl.Collator を生成する。
     * 'default' は VSCode の挙動に合わせて numeric: true で自然順ソート。
     */
    private buildCollator(lexOption: string): Intl.Collator {
        switch (lexOption) {
            case 'upper':
                // 大文字優先 (A < a)
                return new Intl.Collator(undefined, { numeric: true, caseFirst: 'upper' });
            case 'lower':
                // 小文字優先 (a < A)
                return new Intl.Collator(undefined, { numeric: true, caseFirst: 'lower' });
            case 'unicode':
                // Unicodeコードポイント順（大文字 < 小文字）
                return new Intl.Collator('en', { numeric: false, sensitivity: 'variant', caseFirst: 'upper' });
            case 'default':
            default:
                // 大文字小文字を区別しない自然順（VSCode既定）
                return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        }
    }

    /**
     * sortOrder に応じた比較関数を返す。
     * group/folder-ref の型優先度はここで制御する。
     */
    private buildCompareFn(
        sortOrder: string,
        collator: Intl.Collator
    ): (a: ExplorerNode, b: ExplorerNode) => number {
        switch (sortOrder) {
            case 'mixed':
                // 型による優先度なし: 名前のみで比較
                return (a, b) => collator.compare(a.label, b.label);

            case 'filesFirst':
                // ファイル優先: file-ref(0) > folder-ref(1) > group(2)
                return (a, b) => {
                    const pa = this.getFilesFirstPriority(a);
                    const pb = this.getFilesFirstPriority(b);
                    if (pa !== pb) return pa - pb;
                    return collator.compare(a.label, b.label);
                };

            case 'type':
                // 拡張子順: 同拡張子内はフォルダ優先 → 名前順
                return (a, b) => {
                    const aGroup = this.isGroupLike(a);
                    const bGroup = this.isGroupLike(b);
                    // フォルダ同士 or ファイル同士でない場合はフォルダを先に
                    if (aGroup !== bGroup) return aGroup ? -1 : 1;
                    // 同種なら拡張子で比較（フォルダは拡張子なしとして扱う）
                    const extA = aGroup ? '' : this.getExtension(a.label);
                    const extB = bGroup ? '' : this.getExtension(b.label);
                    const extCmp = collator.compare(extA, extB);
                    if (extCmp !== 0) return extCmp;
                    return collator.compare(a.label, b.label);
                };

            case 'modified':
                // 更新日時降順: groupは常に先頭、取得失敗時は名前順フォールバック
                return (a, b) => {
                    const aGroup = this.isGroupLike(a);
                    const bGroup = this.isGroupLike(b);
                    if (aGroup && bGroup) return collator.compare(a.label, b.label);
                    if (aGroup) return -1;
                    if (bGroup) return 1;
                    // どちらもファイル系: mtime降順
                    const mtimeA = this.getMtime(a);
                    const mtimeB = this.getMtime(b);
                    if (mtimeA !== undefined && mtimeB !== undefined) return mtimeB - mtimeA;
                    if (mtimeA !== undefined) return -1;
                    if (mtimeB !== undefined) return 1;
                    return collator.compare(a.label, b.label);
                };

            case 'foldersNestsFiles':
            // ツリー構造変更を伴うため非対応: defaultと同等にフォールバック
            case 'default':
            default:
                // フォルダ優先: group(0) > folder-ref(1) > file-ref(2)
                return (a, b) => {
                    const pa = this.getDefaultPriority(a);
                    const pb = this.getDefaultPriority(b);
                    if (pa !== pb) return pa - pb;
                    return collator.compare(a.label, b.label);
                };
        }
    }

    /** default / foldersNestsFiles: group優先、次にfolder-ref、最後にfile-ref */
    private getDefaultPriority(node: ExplorerNode): number {
        if (node.type === 'group') return 0;
        if (node.type === 'folder-ref') return 1;
        return 2; // file-ref
    }

    /** filesFirst: file-ref優先、次にfolder-ref、最後にgroup */
    private getFilesFirstPriority(node: ExplorerNode): number {
        if (node.type === 'file-ref') return 0;
        if (node.type === 'folder-ref') return 1;
        return 2; // group
    }

    /** ファイル名から拡張子を取得（ドットファイルは拡張子なし扱い） */
    private getExtension(label: string): string {
        const dotIndex = label.lastIndexOf('.');
        if (dotIndex <= 0) return ''; // "." や拡張子なし
        return label.substring(dotIndex + 1).toLowerCase();
    }

    /** file-ref / folder-ref の更新日時(ms)を取得。取得失敗時は undefined */
    private getMtime(node: ExplorerNode): number | undefined {
        const fsPath = node.filePath ?? node.linkedPath;
        if (!fsPath) return undefined;
        try {
            return fs.statSync(fsPath).mtimeMs;
        } catch {
            return undefined;
        }
    }

    private migrateData(nodes: ExplorerNode[]): void {
        for (const node of nodes) {
            if ((node.type as string) === 'file') node.type = 'file-ref';
            if ((node.type as string) === 'linked-group') node.type = 'folder-ref';
            if (node.children) this.migrateData(node.children);
        }
    }

    private loadData() {
        this.data = this.context.workspaceState.get<ExplorerNode[]>(STORAGE_KEY) || [];
        this.migrateData(this.data);
        this.context.workspaceState.update(STORAGE_KEY, this.data);
        this.rebuildIndex();
        this.updateContextKey();

        const restoreWatchers = (nodes: ExplorerNode[]) => {
            for (const node of nodes) {
                if (node.type === 'folder-ref') {
                    this.syncFolderRef(node);
                    this.setupWatcher(node);
                }
                if (node.children) restoreWatchers(node.children);
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