import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { QueryChannel, QuerySink, QueryComplete } from './queryChannel';
import { gridHtml } from './webview/gridHtml';
import { handleExportMessage } from './exportHelper';

/** Runs editor SQL through the .NET worker and streams rows into a webview grid. */
export class QueryExecutor {
    private panel: vscode.WebviewPanel | undefined;
    private activeRequestId: string | undefined;
    private activeConnection: string | undefined;
    private readonly statusBar: vscode.StatusBarItem;

    constructor(private readonly store: ConnectionStore, private readonly channel: QueryChannel) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'pgnet.selectConnection';
        this.statusBar.tooltip = 'PGNet: click to switch the active connection';
        this.updateStatusBar();
    }

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
        await this.runSql(sql);
    }

    /** Runs arbitrary SQL on the given (or sticky) connection, streaming into the results panel. */
    async runSql(sql: string, connectionName?: string): Promise<void> {
        const connName = connectionName ?? await this.pickConnection();
        if (!connName) { return; }
        const connStr = await this.store.get(connName);
        if (!connStr) { return; }

        this.ensurePanel();
        const requestId = this.channel.newRequestId('q');
        if (this.activeRequestId) { this.channel.release(this.activeRequestId); }
        this.activeRequestId = requestId;
        this.post({ type: 'start', reset: true, connection: connName });

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
        await this.channel.run(connStr, sql, requestId, sink);
    }

    async cancel(): Promise<void> {
        if (this.activeRequestId) {
            await this.channel.cancel(this.activeRequestId);
        }
    }

    /** Returns the sticky session connection, prompting only the first time. */
    private async pickConnection(): Promise<string | undefined> {
        const names = this.store.names();
        if (names.length === 0) {
            vscode.window.showWarningMessage('PGNet: add a connection first (PGNet: Add Connection).');
            return undefined;
        }
        if (this.activeConnection && names.includes(this.activeConnection)) {
            return this.activeConnection;
        }
        const picked = names.length === 1
            ? names[0]
            : await vscode.window.showQuickPick(names, { placeHolder: 'Run query on which connection?' });
        if (picked) {
            this.activeConnection = picked;
            this.updateStatusBar();
        }
        return picked;
    }

    /** Name of the sticky session connection, if one has been chosen. */
    getActiveConnection(): string | undefined {
        return this.activeConnection;
    }

    /** Manually switch the active connection for this session. */
    async selectConnection(): Promise<void> {
        const names = this.store.names();
        if (names.length === 0) {
            vscode.window.showWarningMessage('PGNet: add a connection first (PGNet: Add Connection).');
            return;
        }
        const picked = await vscode.window.showQuickPick(names, {
            placeHolder: 'Set active PGNet connection',
        });
        if (picked) {
            this.activeConnection = picked;
            this.updateStatusBar();
        }
    }

    private updateStatusBar(): void {
        this.statusBar.text = `$(database) ${this.activeConnection ?? 'PGNet: no connection'}`;
        this.statusBar.show();
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
