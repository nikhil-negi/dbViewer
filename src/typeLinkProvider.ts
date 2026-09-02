import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { PG_SCHEME, PgDocumentProvider } from './pgDocumentProvider';

interface CompletionObject { schema: string; name: string; kind: string; }
interface CompletionCatalog { schemas: string[]; objects: CompletionObject[]; }

const TYPE_KINDS = new Set(['enum', 'composite', 'domain', 'range', 'base']);
const CACHE_TTL_MS = 60_000;

/**
 * Makes user-defined type names inside a DDL document (the `pg-schema://` virtual docs)
 * Ctrl/Cmd-clickable: each resolves to that type's own definition. Only user-defined
 * types are linked — built-in types like `uuid` or `text` are left alone — and both the
 * schema-qualified form (`paylink.asset_type`) and the bare form (`asset_type`) are matched.
 */
export class TypeLinkProvider implements vscode.DocumentLinkProvider {
    private readonly cache = new Map<string, { catalog: CompletionCatalog; ts: number }>();

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
    ) {}

    async provideDocumentLinks(
        document: vscode.TextDocument, _token: vscode.CancellationToken,
    ): Promise<vscode.DocumentLink[]> {
        if (document.uri.scheme !== PG_SCHEME) { return []; }
        const params = new URLSearchParams(document.uri.query);
        const connName = params.get('conn') ?? document.uri.authority;
        const provider = params.get('provider') ?? 'postgres';
        if (provider !== 'postgres') { return []; } // only Postgres has user-defined named types

        const catalog = await this.getCatalog(connName);
        if (!catalog) { return []; }

        const docSchema = document.uri.path.split('/')[1] || 'public';
        const types = catalog.objects.filter(o => TYPE_KINDS.has(o.kind));
        if (types.length === 0) { return []; }

        // name -> schemas that define a type of that name (for resolving bare references)
        const byName = new Map<string, string[]>();
        for (const t of types) {
            const list = byName.get(t.name) ?? [];
            list.push(t.schema);
            byName.set(t.name, list);
        }

        const text = document.getText();
        const links: vscode.DocumentLink[] = [];
        const taken: [number, number][] = []; // char ranges already linked, to avoid overlaps

        const overlaps = (start: number, end: number) =>
            taken.some(([s, e]) => start < e && end > s);
        const add = (start: number, end: number, schema: string, name: string) => {
            if (overlaps(start, end)) { return; }
            taken.push([start, end]);
            const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
            const link = new vscode.DocumentLink(range, PgDocumentProvider.typeUri(connName, provider, schema, name));
            link.tooltip = `Open definition of ${schema}.${name}`;
            links.push(link);
        };

        // 1. schema-qualified references first (unambiguous), so bare matching can't shadow them
        for (const t of new Map(types.map(t => [`${t.schema}.${t.name}`, t])).values()) {
            for (const m of matchAll(text, `${t.schema}.${t.name}`)) {
                add(m, m + t.schema.length + 1 + t.name.length, t.schema, t.name);
            }
        }
        // 2. bare type names, but only where a type belongs — in "type position", i.e. preceded
        //    by another identifier on the same line (the column/attribute name). This avoids
        //    linking a column whose *name* happens to equal a type name.
        for (const [name, schemas] of byName) {
            const schema = schemas.includes(docSchema) ? docSchema : schemas[0];
            for (const m of matchAll(text, name)) {
                const lineStart = text.lastIndexOf('\n', m - 1) + 1;
                if (!/[A-Za-z0-9_$]/.test(text.slice(lineStart, m))) { continue; } // first token on the line
                add(m, m + name.length, schema, name);
            }
        }

        return links;
    }

    private async getCatalog(connName: string): Promise<CompletionCatalog | undefined> {
        const cached = this.cache.get(connName);
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS) { return cached.catalog; }
        const resolved = await this.store.resolve(connName);
        if (!resolved) { return undefined; }
        try {
            const catalog = await this.client.request<CompletionCatalog>(
                'GetCompletionCatalog', resolved.provider, resolved.connStr);
            this.cache.set(connName, { catalog, ts: Date.now() });
            return catalog;
        } catch {
            return cached?.catalog;
        }
    }
}

/** Start offsets of every whole-word occurrence of `token` in `text` (identifier boundaries). */
function matchAll(text: string, token: string): number[] {
    const out: number[] = [];
    const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
    let from = 0;
    for (;;) {
        const i = text.indexOf(token, from);
        if (i < 0) { break; }
        const before = text[i - 1];
        const after = text[i + token.length];
        // the '.' in a qualified name is fine as a boundary; reject other adjacent word chars
        if (!isWord(before) && !isWord(after)) { out.push(i); }
        from = i + token.length;
    }
    return out;
}
