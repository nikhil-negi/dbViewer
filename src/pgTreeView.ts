import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';

export type NodeKind = 'connection' | 'schema' | 'folder' | 'table' | 'view' | 'routine' | 'type';
export type FolderType = 'Tables' | 'Views' | 'Routines' | 'Data Types';
/** pg_type sub-kinds we surface; mirrors CatalogHandler's TypeKindExpr. */
export type TypeKind = 'enum' | 'composite' | 'domain' | 'range' | 'base';

const FOLDERS: readonly FolderType[] = ['Tables', 'Views', 'Routines', 'Data Types'];

/** Optional per-node payload; leaf kinds use the subset that applies to them. */
export interface PgNodeProps {
    schema?: string;
    objectName?: string;
    oid?: number;
    folderType?: FolderType;
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
    readonly folderType?: FolderType;
    readonly routineArgs?: string;
    readonly routineKind?: string;
    readonly typeKind?: TypeKind;

    constructor(
        public readonly kind: NodeKind,
        public readonly connName: string,
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        props: PgNodeProps = {},
    ) {
        super(label, collapsible);
        this.schema = props.schema;
        this.objectName = props.objectName;
        this.oid = props.oid;
        this.folderType = props.folderType;
        this.routineArgs = props.routineArgs;
        this.routineKind = props.routineKind;
        this.typeKind = props.typeKind;

        this.contextValue = kind;
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
                return this.store.names().map(n =>
                    new PgNode('connection', n, n, vscode.TreeItemCollapsibleState.Collapsed));
            }
            const connStr = await this.store.get(node.connName);
            if (!connStr) { return []; }

            switch (node.kind) {
                case 'connection': {
                    const schemas = await this.client.request<{ name: string }[]>('GetSchemas', connStr);
                    return schemas.map(s => new PgNode('schema', node.connName, s.name,
                        vscode.TreeItemCollapsibleState.Collapsed, { schema: s.name }));
                }
                case 'schema':
                    return FOLDERS.map(f =>
                        new PgNode('folder', node.connName, f, vscode.TreeItemCollapsibleState.Collapsed,
                            { schema: node.schema, folderType: f }));
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
        switch (node.folderType) {
            case 'Tables': {
                const tables = await this.client.request<{ schema: string; name: string }[]>('GetTables', connStr, schema);
                return tables.map(t => new PgNode('table', node.connName, t.name,
                    vscode.TreeItemCollapsibleState.None, { schema, objectName: t.name }));
            }
            case 'Views': {
                const views = await this.client.request<{ schema: string; name: string }[]>('GetViews', connStr, schema);
                return views.map(v => new PgNode('view', node.connName, v.name,
                    vscode.TreeItemCollapsibleState.None, { schema, objectName: v.name }));
            }
            case 'Data Types': {
                const types = await this.client.request<{ schema: string; name: string; kind: TypeKind; oid: number }[]>(
                    'GetTypes', connStr, schema);
                return types.map(t => {
                    const n = new PgNode('type', node.connName, t.name,
                        vscode.TreeItemCollapsibleState.None,
                        { schema, objectName: t.name, oid: t.oid, typeKind: t.kind });
                    n.description = t.kind;
                    return n;
                });
            }
            default: {
                const routines = await this.client.request<{ schema: string; name: string; kind: string; oid: number; arguments: string }[]>(
                    'GetRoutines', connStr, schema);
                return routines.map(r => {
                    const n = new PgNode('routine', node.connName, `${r.name}(${r.arguments})`,
                        vscode.TreeItemCollapsibleState.None,
                        { schema, objectName: r.name, oid: r.oid, routineArgs: r.arguments, routineKind: r.kind });
                    n.description = r.kind;
                    return n;
                });
            }
        }
    }
}
