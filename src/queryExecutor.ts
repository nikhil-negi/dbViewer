import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { ConnectionContext } from './connectionContext';
import { QueryChannel, QuerySink, QueryComplete } from './queryChannel';
import { gridHtml } from './webview/gridHtml';
import { handleExportMessage } from './exportHelper';
import { providerInfo } from './providers';

/**
 * Runs editor SQL through the .NET worker and streams rows into a webview grid.
 * Which server a query lands on comes from the file's connection context, so several
 * connections can be in play at once without a hidden global "current" connection.
 */
export class QueryExecutor {
    private panel: vscode.WebviewPanel | undefined;
    private activeRequestId: string | undefined;

    constructor(
        private readonly store: ConnectionStore,
        private readonly channel: QueryChannel,
        private readonly context: ConnectionContext,
    ) {}

    async runFromActiveEditor(): Promise<void> {
        // fall back to a visible SQL editor when focus is elsewhere (e.g. the results panel)
        const editor = vscode.window.activeTextEditor
            ?? vscode.window.visibleTextEditors.find(e =>
                e.document.languageId === 'sql' || e.document.uri.scheme === 'pg-schema');
        if (!editor) {
            vscode.window.showWarningMessage('PGNet: no active editor.');
            return;
        }
        // run only the selected text; supports multi-cursor (selections joined in
        // document order); whole file only when nothing at all is selected
        const selections = editor.selections
            .filter(s => !s.isEmpty)
            .sort((a, b) => a.start.compareTo(b.start));
        const sql = selections.length
            ? selections.map(s => editor.document.getText(s)).join('\n')
            : editor.document.getText();
        if (!sql.trim()) { return; }

        const connName = await this.context.ensureForDocument(editor.document);
        if (!connName) { return; }
        await this.runSql(sql, connName);
    }

    /** Runs arbitrary SQL on a named connection, streaming into the results panel. */
    async runSql(sql: string, connectionName: string): Promise<void> {
        const resolved = await this.store.resolve(connectionName);
        if (!resolved) {
            vscode.window.showErrorMessage(`PGNet: no stored connection string for "${connectionName}".`);
            return;
        }
        const { provider, connStr } = resolved;

        this.ensurePanel();
        this.panel!.title = `PGNet Results — ${connectionName}`;
        const requestId = this.channel.newRequestId('q');
        if (this.activeRequestId) { this.channel.release(this.activeRequestId); }
        this.activeRequestId = requestId;
        this.post({
            type: 'start',
            reset: true,
            connection: `${connectionName} (${providerInfo(provider).label})`,
        });

        const sink: QuerySink = {
            onColumns: (columns) => this.post({ type: 'columns', columns }),
            onRows: (rows) => this.post({ type: 'rows', rows }),
            onNotice: (message) => this.post({ type: 'notice', message }),
            onComplete: (result: QueryComplete) => {
                this.channel.release(requestId);
                if (this.activeRequestId === requestId) { this.activeRequestId = undefined; }
                this.post({ type: 'complete', ...result });
            },
        };
        await this.channel.run(provider, connStr, sql, requestId, sink);
    }

    async cancel(): Promise<void> {
        if (this.activeRequestId) {
            await this.channel.cancel(this.activeRequestId);
        }
    }

    private post(message: unknown): void {
        this.panel?.webview.postMessage(message);
    }

    private ensurePanel(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'pgnetResults', 'PGNet Results', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true });
        this.panel.onDidDispose(() => { this.panel = undefined; });
        this.panel.webview.html = gridHtml({ mode: 'query' });
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'export') { await handleExportMessage(msg); }
        });
    }
}
