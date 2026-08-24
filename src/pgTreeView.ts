import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';

export type NodeKind = 'connection' | 'schema' | 'folder' | 'table' | 'view' | 'routine';

export class PgNode extends vscode.TreeItem {
    constructor(
        public readonly kind: NodeKind,
        public readonly connName: string,
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        public readonly schema?: string,
        public readonly objectName?: string,
        public readonly oid?: number,
        public readonly folderType?: 'Tables' | 'Views' | 'Routines',
        public readonly routineArgs?: string,
        public readonly routineKind?: string,
    ) {
        super(label, collapsible);
        this.contextValue = kind;
        this.iconPath = new vscode.ThemeIcon(
            kind === 'connection' ? 'plug' :
            kind === 'schema' ? 'symbol-namespace' :
            kind === 'folder' ? 'folder' :
            kind === 'table' ? 'symbol-structure' :
            kind === 'view' ? 'eye' : 'symbol-method');
        if (kind === 'table' || kind === 'view' || kind === 'routine') {
            this.command = {
                command: 'pgnet.openDefinition',
                title: 'Open Definition',
                arguments: [this],
            };
        }
    }
}

export class PgTreeViewProvider implements vscode.TreeDataProvider<PgNode> {
    private readonly _onDidChange = new vscode.EventEmitter<PgNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {}

    refresh(): void { this._onDidChange.fire(undefined); }

    getTreeItem(node: PgNode): vscode.TreeItem { return node; }

    async getChildren(node?: PgNode): Promise<PgNode[]> {
        try {
            if (!node) {
                return this.store.names().map(n =>
                    new PgNode('connection', n, n, vscode.TreeItemCollapsibleState.Collapsed));
            }
            const connStr = await this.store.get(node.connName);
            if (!connStr) { return []; }

            switch (node.kind) {
                case 'connection': {
                    const schemas = await this.client.request<{ name: string }[]>('GetSchemas', connStr);
                    return schemas.map(s => new PgNode('schema', node.connName, s.name,
                        vscode.TreeItemCollapsibleState.Collapsed, s.name));
                }
                case 'schema':
                    return (['Tables', 'Views', 'Routines'] as const).map(f =>
                        new PgNode('folder', node.connName, f, vscode.TreeItemCollapsibleState.Collapsed,
                            node.schema, undefined, undefined, f));
                case 'folder': {
                    const schema = node.schema!;
                    if (node.folderType === 'Tables') {
                        const tables = await this.client.request<{ schema: string; name: string }[]>('GetTables', connStr, schema);
                        return tables.map(t => new PgNode('table', node.connName, t.name,
                            vscode.TreeItemCollapsibleState.None, schema, t.name));
                    }
                    if (node.folderType === 'Views') {
                        const views = await this.client.request<{ schema: string; name: string }[]>('GetViews', connStr, schema);
                        return views.map(v => new PgNode('view', node.connName, v.name,
                            vscode.TreeItemCollapsibleState.None, schema, v.name));
                    }
                    const routines = await this.client.request<{ schema: string; name: string; kind: string; oid: number; arguments: string }[]>(
                        'GetRoutines', connStr, schema);
                    return routines.map(r => {
                        const n = new PgNode('routine', node.connName, `${r.name}(${r.arguments})`,
                            vscode.TreeItemCollapsibleState.None, schema, r.name, r.oid,
                            undefined, r.arguments, r.kind);
                        n.description = r.kind;
                        return n;
                    });
                }
                default:
                    return [];
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`PGNet: ${e?.message ?? e}`);
            return [];
        }
    }
}
