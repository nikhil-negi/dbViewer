import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { PgNode } from './pgTreeView';

export const PG_SCHEME = 'pg-schema';

/**
 * Serves object DDL as read-only virtual documents:
 *   pg-schema://<connection>/<schema>/<name>.sql
 *       ?kind=<table|view|routine|type>&oid=<oid>&conn=<connection>&provider=<provider>
 */
export class PgDocumentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params = new URLSearchParams(uri.query);
        const connName = params.get('conn') ?? uri.authority;
        const resolved = await this.store.resolve(connName);
        if (!resolved) { return `-- unknown connection: ${connName}`; }
        const { provider, connStr } = resolved;

        const kind = params.get('kind');
        const [, schema, file] = uri.path.split('/');
        const name = file.replace(/\.sql$/, '');
        try {
            switch (kind) {
                case 'routine':
                    return await this.client.request<string>('GetRoutineDefinition',
                        provider, connStr, schema, name, Number(params.get('oid') ?? 0));
                case 'view':
                    return await this.client.request<string>('GetViewDefinition', provider, connStr, schema, name);
                case 'type':
                    return await this.client.request<string>('GetTypeDefinition', provider, connStr, schema, name);
                default:
                    return await this.client.request<string>('GetTableDefinition', provider, connStr, schema, name);
            }
        } catch (e: any) {
            return `-- failed to load definition: ${e?.message ?? e}`;
        }
    }

    static uriFor(node: PgNode): vscode.Uri {
        const q = new URLSearchParams({
            kind: node.kind,
            oid: String(node.oid ?? ''),
            conn: node.connName,
            provider: node.provider,
        });
        return vscode.Uri.parse(
            `${PG_SCHEME}://${node.connName}/${node.schema}/${node.objectName}.sql?${q.toString()}`);
    }
}

export async function openDefinition(node: PgNode): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(PgDocumentProvider.uriFor(node));
    await vscode.languages.setTextDocumentLanguage(doc, 'sql');
    await vscode.window.showTextDocument(doc, { preview: true });
}
