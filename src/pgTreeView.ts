import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { FolderKind, ProviderId, providerInfo } from './providers';
import { score } from './fuzzy';

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

interface CompletionObject { schema: string; name: string; kind: string; }
interface CompletionCatalog { schemas: string[]; objects: CompletionObject[]; }

/** Ceiling on filtered leaves shown at once, so a broad query stays responsive. */
const MAX_FILTER_RESULTS = 500;

export class PgTreeViewProvider implements vscode.TreeDataProvider<PgNode> {
    private readonly _onDidChange = new vscode.EventEmitter<PgNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private filter = '';
    private readonly _onFilter = new vscode.EventEmitter<string>();
    /** Fires whenever the live filter text changes, so the view message can track it. */
    readonly onDidChangeFilterText = this._onFilter.event;
    /** One catalog per connection, fetched on first filter and reused for later keystrokes. */
    private readonly catalogCache = new Map<string, CompletionCatalog>();
    /** The connection the user is working in, auto-expanded while filtering. */
    private activeConn: string | undefined;

    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {}

    /** Current filter text (for seeding the filter input box). */
    filterText(): string { return this.filter; }

    /** Remembers which connection is selected, so a filter can expand just that one. */
    setActiveConnection(name: string | undefined): void {
        if (name === this.activeConn) { return; }
        this.activeConn = name;
        if (this.hasFilter()) { this._onDidChange.fire(undefined); }
    }

    refresh(): void {
        this.catalogCache.clear(); // pick up new/renamed objects
        this._onDidChange.fire(undefined);
    }

    /** Sets the whole filter text (from the input box or a clear). */
    setFilter(text: string): void {
        if (text === this.filter) { return; }
        this.filter = text;
        this.afterFilterChange();
    }

    /** Type-to-filter: append one typed character. */
    appendToFilter(ch: string): void {
        this.filter += ch;
        this.afterFilterChange();
    }

    /** Type-to-filter: delete the last character (no-op when empty). */
    backspaceFilter(): void {
        if (!this.filter) { return; }
        this.filter = this.filter.slice(0, -1);
        this.afterFilterChange();
    }

    hasFilter(): boolean { return this.filter.trim().length > 0; }

    private afterFilterChange(): void {
        void vscode.commands.executeCommand('setContext', 'pgnet.filtered', this.hasFilter());
        this._onFilter.fire(this.filter);
        this._onDidChange.fire(undefined);
    }

    getTreeItem(node: PgNode): vscode.TreeItem { return node; }

    async getChildren(node?: PgNode): Promise<PgNode[]> {
        try {
            if (!node) {
                return this.store.list().map(c => {
                    // while filtering, expand the connection in focus so matches are visible at once
                    const expand = this.hasFilter() &&
                        (c.name === this.activeConn || this.store.list().length === 1);
                    const n = new PgNode('connection', c.name, c.provider, c.name,
                        expand ? vscode.TreeItemCollapsibleState.Expanded
                               : vscode.TreeItemCollapsibleState.Collapsed);
                    n.description = providerInfo(c.provider).label;
                    n.id = `conn:${c.name}`; // stable id keeps expansion state across filter refreshes
                    return n;
                });
            }
            const connStr = await this.store.get(node.connName);
            if (!connStr) { return []; }
            const provider = node.provider;

            switch (node.kind) {
                case 'connection': {
                    if (this.hasFilter()) { return this.filteredChildren(node, connStr); }
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

    /**
     * Flattened, fuzzy-filtered objects under a connection: every table/view/routine/type
     * (and objects of a matching schema), ranked by match quality. Uses one completion-catalog
     * round trip per connection, cached, so typing filters instantly after the first fetch.
     */
    private async filteredChildren(node: PgNode, connStr: string): Promise<PgNode[]> {
        const catalog = await this.catalogFor(node.connName, node.provider, connStr);
        const q = this.filter.trim();

        const scored: { node: PgNode; score: number }[] = [];
        for (const o of catalog.objects) {
            const byName = score(q, o.name);
            const bySchema = score(q, o.schema);
            const byQualified = score(q, `${o.schema}.${o.name}`);
            const best = Math.max(byName, byQualified, bySchema >= 0 ? bySchema - 50 : -1);
            if (best < 0) { continue; }
            scored.push({ node: this.leafFor(node, o), score: best });
        }
        scored.sort((a, b) => b.score - a.score || a.node.label!.toString().localeCompare(b.node.label!.toString()));

        const shown = scored.slice(0, MAX_FILTER_RESULTS).map(x => x.node);
        if (scored.length > MAX_FILTER_RESULTS) {
            const more = new PgNode('folder', node.connName, node.provider,
                `… ${scored.length - MAX_FILTER_RESULTS} more match — refine the filter`,
                vscode.TreeItemCollapsibleState.None);
            more.command = undefined;
            more.contextValue = 'info';
            more.iconPath = new vscode.ThemeIcon('ellipsis');
            shown.push(more);
        }
        if (shown.length === 0) {
            const empty = new PgNode('folder', node.connName, node.provider,
                `No objects match “${q}”`, vscode.TreeItemCollapsibleState.None);
            empty.contextValue = 'info';
            empty.iconPath = new vscode.ThemeIcon('search-stop');
            return [empty];
        }
        return shown;
    }

    /** Builds a clickable leaf from a catalog object; description shows where it lives. */
    private leafFor(conn: PgNode, o: CompletionObject): PgNode {
        const provider = conn.provider;
        const props = { schema: o.schema, objectName: o.name };
        let leaf: PgNode;
        switch (o.kind) {
            case 'view':
                leaf = new PgNode('view', conn.connName, provider, o.name, vscode.TreeItemCollapsibleState.None, props);
                break;
            case 'function':
            case 'procedure':
                leaf = new PgNode('routine', conn.connName, provider, o.name,
                    vscode.TreeItemCollapsibleState.None, { ...props, routineKind: o.kind });
                // filtered routines carry no oid/args, so no Run/Debug — the DDL still opens (resolved by name)
                leaf.contextValue = 'routineReadOnly';
                break;
            case 'enum': case 'composite': case 'domain': case 'range': case 'base':
                leaf = new PgNode('type', conn.connName, provider, o.name,
                    vscode.TreeItemCollapsibleState.None, { ...props, typeKind: o.kind as any });
                break;
            default:
                leaf = new PgNode('table', conn.connName, provider, o.name, vscode.TreeItemCollapsibleState.None, props);
        }
        leaf.description = `${o.schema} · ${o.kind}`;
        return leaf;
    }

    private async catalogFor(connName: string, provider: ProviderId, connStr: string): Promise<CompletionCatalog> {
        const hit = this.catalogCache.get(connName);
        if (hit) { return hit; }
        const catalog = await this.client.request<CompletionCatalog>('GetCompletionCatalog', provider, connStr);
        this.catalogCache.set(connName, catalog);
        return catalog;
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
