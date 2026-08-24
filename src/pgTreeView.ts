import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { FolderKind, ProviderId, providerInfo } from './providers';

export type NodeKind = 'connection' | 'schema' | 'folder' | 'table' | 'view' | 'routine' | 'type';
/** pg_type sub-kinds we surface; mirrors PostgresProvider's TypeKindExpr. */
export type TypeKind = 'enum' | 'composite' | 'domain' | 'range' | 'base';

/** Optional per-node payload; leaf kinds use the subset that applies to them. */
export interface PgNodeProps {
    schema?: string;
    objectName?: string;
    oid?: number;
    folderKind?: FolderKind;
    routineArgs?: string;
    routineKind?: string;
    typeKind?: TypeKind;
}

const TYPE_ICONS: Record<string, string> = {
    enum: 'symbol-enum',
    composite: 'symbol-class',
    domain: 'symbol-ruler',
    range: 'symbol-numeric',
    base: 'symbol-parameter',
};

function iconFor(kind: NodeKind, typeKind?: string): string {
    switch (kind) {
        case 'connection': return 'plug';
        case 'schema': return 'symbol-namespace';
        case 'folder': return 'folder';
        case 'table': return 'symbol-structure';
        case 'view': return 'eye';
        case 'type': return TYPE_ICONS[typeKind ?? ''] ?? 'symbol-parameter';
        default: return 'symbol-method';
    }
}

/** Leaf kinds whose click opens something (data grid or DDL). */
const OPENABLE: readonly NodeKind[] = ['table', 'view', 'routine', 'type'];

export class PgNode extends vscode.TreeItem {
    readonly schema?: string;
    readonly objectName?: string;
    readonly oid?: number;
    readonly folderKind?: FolderKind;
    readonly routineArgs?: string;
    readonly routineKind?: string;
    readonly typeKind?: TypeKind;

    constructor(
        public readonly kind: NodeKind,
        public readonly connName: string,
        public readonly provider: ProviderId,
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        props: PgNodeProps = {},
    ) {
        super(label, collapsible);
        this.schema = props.schema;
        this.objectName = props.objectName;
        this.oid = props.oid;
        this.folderKind = props.folderKind;
        this.routineArgs = props.routineArgs;
        this.routineKind = props.routineKind;
        this.typeKind = props.typeKind;

        // routines only get the Run/Debug buttons on engines that can invoke them
        this.contextValue = kind === 'routine' && !providerInfo(provider).supportsRunRoutine
            ? 'routineReadOnly'
            : kind;
        this.iconPath = new vscode.ThemeIcon(iconFor(kind, props.typeKind));
        if (OPENABLE.includes(kind)) {
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
                return this.store.list().map(c => {
                    const n = new PgNode('connection', c.name, c.provider, c.name,
                        vscode.TreeItemCollapsibleState.Collapsed);
                    n.description = providerInfo(c.provider).label;
                    return n;
                });
            }
            const connStr = await this.store.get(node.connName);
            if (!connStr) { return []; }
            const provider = node.provider;

            switch (node.kind) {
                case 'connection': {
                    const schemas = await this.client.request<{ name: string }[]>(
                        'GetSchemas', provider, connStr);
                    return schemas.map(s => new PgNode('schema', node.connName, provider, s.name,
                        vscode.TreeItemCollapsibleState.Collapsed, { schema: s.name }));
                }
                case 'schema':
                    return providerInfo(provider).folders.map(f =>
                        new PgNode('folder', node.connName, provider, f.label,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            { schema: node.schema, folderKind: f.kind }));
                case 'folder':
                    return this.folderChildren(node, connStr);
                default:
                    return [];
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`PGNet: ${e?.message ?? e}`);
            return [];
        }
    }

    private async folderChildren(node: PgNode, connStr: string): Promise<PgNode[]> {
        const schema = node.schema!;
        const provider = node.provider;
        switch (node.folderKind) {
            case 'tables': {
                const tables = await this.client.request<{ schema: string; name: string }[]>(
                    'GetTables', provider, connStr, schema);
                return tables.map(t => new PgNode('table', node.connName, provider, t.name,
                    vscode.TreeItemCollapsibleState.None, { schema, objectName: t.name }));
            }
            case 'views': {
                const views = await this.client.request<{ schema: string; name: string }[]>(
                    'GetViews', provider, connStr, schema);
                return views.map(v => new PgNode('view', node.connName, provider, v.name,
                    vscode.TreeItemCollapsibleState.None, { schema, objectName: v.name }));
            }
            case 'types': {
                const types = await this.client.request<{ schema: string; name: string; kind: TypeKind; oid: number }[]>(
                    'GetTypes', provider, connStr, schema);
                return types.map(t => {
                    const n = new PgNode('type', node.connName, provider, t.name,
                        vscode.TreeItemCollapsibleState.None,
                        { schema, objectName: t.name, oid: t.oid, typeKind: t.kind });
                    n.description = t.kind;
                    return n;
                });
            }
            default: {
                const routines = await this.client.request<
                    { schema: string; name: string; kind: string; oid: number; arguments: string }[]>(
                    'GetRoutines', provider, connStr, schema);
                return routines.map(r => {
                    const label = r.arguments ? `${r.name}(${r.arguments})` : r.name;
                    const n = new PgNode('routine', node.connName, provider, label,
                        vscode.TreeItemCollapsibleState.None,
                        { schema, objectName: r.name, oid: r.oid, routineArgs: r.arguments, routineKind: r.kind });
                    n.description = r.kind;
                    return n;
                });
            }
        }
    }
}
