import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';

interface CompletionObject { schema: string; name: string; kind: string; }
interface CompletionColumn { schema: string; table: string; name: string; type: string; }
interface CompletionCatalog { schemas: string[]; objects: CompletionObject[]; columns: CompletionColumn[]; }

const CACHE_TTL_MS = 60_000;

const KIND_MAP: Record<string, vscode.CompletionItemKind> = {
    table: vscode.CompletionItemKind.Struct,
    view: vscode.CompletionItemKind.Interface,
    function: vscode.CompletionItemKind.Function,
    procedure: vscode.CompletionItemKind.Method,
};

/**
 * SQL autocomplete backed by the database catalog of the active connection:
 * schemas, tables, views, routines everywhere; columns after `table.`,
 * `schema.table.`, or a FROM/JOIN alias.
 */
export class PgCompletionProvider implements vscode.CompletionItemProvider {
    private readonly cache = new Map<string, { catalog: CompletionCatalog; ts: number }>();

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
        private readonly activeConnection: () => string | undefined,
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument, position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | undefined> {
        const connName = this.activeConnection() ?? this.store.names()[0];
        if (!connName) { return undefined; }
        const catalog = await this.getCatalog(connName);
        if (!catalog) { return undefined; }

        // what's immediately before the cursor: "qualifier." ?
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const dotted = /([\w"]+)\.(?:[\w"]*)$/.exec(line);

        if (dotted) {
            const qualifier = dotted[1].replace(/"/g, '');
            return this.afterDot(qualifier, catalog, document);
        }
        return this.topLevel(catalog);
    }

    /** schemas + object names + column names of tables referenced in the document */
    private topLevel(catalog: CompletionCatalog): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        for (const s of catalog.schemas) {
            const it = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
            it.detail = 'schema';
            items.push(it);
        }
        for (const o of catalog.objects) {
            const it = new vscode.CompletionItem(o.name, KIND_MAP[o.kind] ?? vscode.CompletionItemKind.Value);
            it.detail = `${o.kind} · ${o.schema}`;
            it.sortText = `1${o.name}`;
            items.push(it);
        }
        return items;
    }

    private afterDot(
        qualifier: string, catalog: CompletionCatalog, document: vscode.TextDocument,
    ): vscode.CompletionItem[] {
        const q = qualifier.toLowerCase();

        // 1. schema. -> objects in that schema
        if (catalog.schemas.some(s => s.toLowerCase() === q)) {
            return catalog.objects
                .filter(o => o.schema.toLowerCase() === q)
                .map(o => {
                    const it = new vscode.CompletionItem(o.name, KIND_MAP[o.kind] ?? vscode.CompletionItemKind.Value);
                    it.detail = o.kind;
                    return it;
                });
        }

        // 2. table./view. (bare name) -> its columns
        let target = catalog.objects.find(o =>
            o.name.toLowerCase() === q && (o.kind === 'table' || o.kind === 'view'));

        // 3. alias. -> resolve via FROM/JOIN clauses in the document
        if (!target) {
            const aliasTable = this.resolveAlias(document.getText(), q);
            if (aliasTable) {
                target = catalog.objects.find(o =>
                    o.name.toLowerCase() === aliasTable && (o.kind === 'table' || o.kind === 'view'));
            }
        }
        if (!target) { return []; }

        return catalog.columns
            .filter(c => c.schema === target.schema && c.table === target.name)
            .map(c => {
                const it = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
                it.detail = c.type;
                return it;
            });
    }

    /** Finds `FROM/JOIN <table> [AS] <alias>` and returns the table name for an alias. */
    private resolveAlias(text: string, alias: string): string | undefined {
        const re = /\b(?:from|join)\s+(?:"?[\w]+"?\.)?"?(\w+)"?\s+(?:as\s+)?"?(\w+)"?/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            if (m[2].toLowerCase() === alias &&
                !/^(on|where|group|order|left|right|inner|outer|cross|join|using|limit|having)$/i.test(m[2])) {
                return m[1].toLowerCase();
            }
        }
        return undefined;
    }

    private async getCatalog(connName: string): Promise<CompletionCatalog | undefined> {
        const cached = this.cache.get(connName);
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS) { return cached.catalog; }
        const connStr = await this.store.get(connName);
        if (!connStr) { return undefined; }
        try {
            const catalog = await this.client.request<CompletionCatalog>('GetCompletionCatalog', connStr);
            this.cache.set(connName, { catalog, ts: Date.now() });
            return catalog;
        } catch {
            return cached?.catalog; // stale is better than nothing
        }
    }
}
