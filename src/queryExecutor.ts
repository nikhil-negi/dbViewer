import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { ConnectionContext, FileBinding } from './connectionContext';
import { QueryChannel, QuerySink, QueryComplete } from './queryChannel';
import { gridHtml } from './webview/gridHtml';
import { handleExportMessage } from './exportHelper';
import { ProviderId, providerInfo, quoteIdent, withDatabase } from './providers';
import { paginableSelect } from './sqlText';

const PAGE_SIZE = 200;

/** Live state for the results panel while a single SELECT is being paged through. */
interface PageState {
    provider: ProviderId;
    connStr: string;
    /** The user's SELECT, wrapped in a subquery so LIMIT/OFFSET (and sort) can be layered on. */
    base: string;
    schema?: string;
    label: string;
    orderBy?: string;
    dir?: 'asc' | 'desc';
}

/**
 * Runs editor SQL through the .NET worker and streams rows into a webview grid.
 *
 * Which server (and schema) a query lands on comes from the file's connection context,
 * so several connections can be in play at once. A single read-only SELECT is capped at
 * {@link PAGE_SIZE} rows and paged in on scroll — the same guard other DB viewers give
 * you against accidentally pulling a whole huge table; writes, DDL and multi-statement
 * scripts run in full.
 */
export class QueryExecutor {
    private panel: vscode.WebviewPanel | undefined;
    private activeRequestId: string | undefined;
    private page: PageState | undefined;

    constructor(
        private readonly store: ConnectionStore,
        private readonly channel: QueryChannel,
        private readonly context: ConnectionContext,
    ) {}

    async runFromActiveEditor(): Promise<void> {
        const editor = this.context.activeSqlEditor();
        if (!editor) {
            vscode.window.showWarningMessage('DBViewer: open a SQL file to run a query.');
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

        const binding = await this.context.ensureForDocument(editor.document);
        if (!binding) { return; }
        await this.run(sql, binding);
    }

    /** Runs SQL using a file binding (connection + optional schema). */
    async run(sql: string, binding: FileBinding): Promise<void> {
        const resolved = await this.store.resolve(binding.connection);
        if (!resolved) {
            vscode.window.showErrorMessage(`DBViewer: no stored connection string for "${binding.connection}".`);
            return;
        }
        const { provider, connStr } = resolved;
        const base = paginableSelect(sql);

        if (base) {
            // paginated: cap the result and page in the rest on scroll
            this.page = {
                provider, connStr, base, schema: binding.schema,
                label: `${binding.connection}${binding.schema ? ' · ' + binding.schema : ''}`,
            };
            this.ensurePanel(true);
            this.panel!.title = `DBViewer Results — ${this.page.label}`;
            await this.loadPage(0, true);
        } else {
            // full run: writes, DDL, multi-statement scripts
            this.page = undefined;
            const applied = this.applySchema(provider, connStr, binding.schema, sql);
            this.ensurePanel(false);
            this.panel!.title = `DBViewer Results — ${binding.connection}`;
            await this.stream(provider, applied.connStr, applied.sql, {
                banner: `${binding.connection} (${providerInfo(provider).label})`,
            });
        }
    }

    /** Backwards-compatible entry used by "run routine": a connection name, no schema. */
    async runSql(sql: string, connectionName: string): Promise<void> {
        await this.run(sql, { connection: connectionName });
    }

    async cancel(): Promise<void> {
        if (this.activeRequestId) { await this.channel.cancel(this.activeRequestId); }
    }

    /** Applies the file's schema so unqualified table names resolve there. */
    private applySchema(
        provider: ProviderId, connStr: string, schema: string | undefined, sql: string,
    ): { connStr: string; sql: string } {
        if (!schema) { return { connStr, sql }; }
        if (provider === 'clickhouse') {
            // ClickHouse resolves unqualified names against the connection's default database
            return { connStr: withDatabase(connStr, schema), sql };
        }
        // Postgres: put the chosen schema first on the search path, public as a fallback
        const preamble = `SET search_path TO ${quoteIdent(provider, schema)}, public;\n`;
        return { connStr, sql: preamble + sql };
    }

    /** Builds and runs one page of the wrapped SELECT. */
    private async loadPage(offset: number, reset: boolean): Promise<void> {
        const p = this.page;
        if (!p) { return; }
        const order = p.orderBy
            ? ` ORDER BY ${quoteIdent(p.provider, p.orderBy)} ${p.dir === 'desc' ? 'DESC' : 'ASC'}`
            : '';
        const wrapped = `SELECT * FROM (\n${p.base}\n) AS dbviewer_q${order} LIMIT ${PAGE_SIZE} OFFSET ${offset};`;
        const applied = this.applySchema(p.provider, p.connStr, p.schema, wrapped);
        await this.stream(p.provider, applied.connStr, applied.sql, {
            reset,
            paged: true,
            banner: reset ? `${p.label} — first ${PAGE_SIZE} rows, scroll for more` : undefined,
        });
    }

    /** Streams a query into the results panel, wiring completion back to the grid. */
    private async stream(
        provider: ProviderId, connStr: string, sql: string,
        opts: { reset?: boolean; paged?: boolean; banner?: string },
    ): Promise<void> {
        const requestId = this.channel.newRequestId('q');
        if (this.activeRequestId) { this.channel.release(this.activeRequestId); }
        this.activeRequestId = requestId;
        this.post({ type: 'start', reset: opts.reset !== false, connection: opts.banner });

        let pageRows = 0;
        const sink: QuerySink = {
            onColumns: (columns) => this.post({ type: 'columns', columns }),
            onRows: (rows) => { pageRows += (rows as unknown[]).length; this.post({ type: 'rows', rows }); },
            onNotice: (message) => this.post({ type: 'notice', message }),
            onComplete: (result: QueryComplete) => {
                this.channel.release(requestId);
                if (this.activeRequestId === requestId) { this.activeRequestId = undefined; }
                this.post(opts.paged
                    ? { type: 'complete', ...result, pageRows, pageSize: PAGE_SIZE }
                    : { type: 'complete', ...result });
            },
        };
        await this.channel.run(provider, connStr, sql, requestId, sink);
    }

    private post(message: unknown): void {
        this.panel?.webview.postMessage(message);
    }

    /**
     * Ensures the results panel exists in the right mode: a table-style grid with
     * scroll-to-page for paginated SELECTs, or the plain streaming grid otherwise. The
     * panel is recreated when the mode changes so the webview script matches.
     */
    private ensurePanel(paged: boolean): void {
        const wantMode = paged ? 'table' : 'query';
        if (this.panel && this.panelMode !== wantMode) {
            this.panel.dispose();
            this.panel = undefined;
        }
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panelMode = wantMode;
        this.panel = vscode.window.createWebviewPanel(
            'dbviewerResults', 'DBViewer Results', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true });
        this.panel.onDidDispose(() => { this.panel = undefined; this.panelMode = undefined; });
        // paginated results reuse the table grid (infinite scroll + sort) but have no DDL tab
        this.panel.webview.html = gridHtml({ mode: wantMode, ddl: false });
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'export') { await handleExportMessage(msg); }
            else if (msg.type === 'loadMore' && this.page) { await this.loadPage(msg.offset, false); }
            else if (msg.type === 'sort' && this.page) {
                this.page.orderBy = msg.column;
                this.page.dir = msg.dir === 'desc' ? 'desc' : 'asc';
                await this.loadPage(0, true);
            }
        });
    }

    private panelMode: 'query' | 'table' | undefined;
}
