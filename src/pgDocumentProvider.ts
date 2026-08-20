import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { PgNode } from './pgTreeView';

export const PG_SCHEME = 'pg-schema';

/**
 * Serves object DDL as read-only virtual documents:
 *   pg-schema://<connection>/<schema>/<name>.sql?kind=<table|view|routine>&oid=<oid>
 */
export class PgDocumentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params0 = new URLSearchParams(uri.query);
        const connName = params0.get('conn') ?? uri.authority;
        const connStr = await this.store.get(connName);
        if (!connStr) { return `-- unknown connection: ${connName}`; }

        const params = new URLSearchParams(uri.query);
        const kind = params.get('kind');
        const [, schema, file] = uri.path.split('/');
        const name = file.replace(/\.sql$/, '');
        try {
            if (kind === 'routine') {
                return await this.client.request<string>('GetRoutineDefinition', connStr, Number(params.get('oid')));
            }
            if (kind === 'view') {
                return await this.client.request<string>('GetViewDefinition', connStr, schema, name);
            }
            return await this.client.request<string>('GetTableDefinition', connStr, schema, name);
        } catch (e: any) {
            return `-- failed to load definition: ${e?.message ?? e}`;
        }
    }

    static uriFor(node: PgNode): vscode.Uri {
        const q = new URLSearchParams({ kind: node.kind, oid: String(node.oid ?? ''), conn: node.connName });
        return vscode.Uri.parse(
            `${PG_SCHEME}://${node.connName}/${node.schema}/${node.objectName}.sql?${q.toString()}`);
    }
}

export async function openDefinition(node: PgNode): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(PgDocumentProvider.uriFor(node));
    await vscode.languages.setTextDocumentLanguage(doc, 'sql');
    await vscode.window.showTextDocument(doc, { preview: true });
}
