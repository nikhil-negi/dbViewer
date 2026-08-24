import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { QueryChannel, QuerySink, QueryComplete } from './queryChannel';
import { PgNode } from './pgTreeView';
import { gridHtml } from './webview/gridHtml';
import { handleExportMessage } from './exportHelper';
import { openDefinition } from './pgDocumentProvider';
import { typeDetailSql } from './typeUtils';
import { ProviderId, quoteIdent } from './providers';
import { ColumnPreferences } from './columnPreferences';
import { pickColumns, ColumnInfo } from './columnPicker';

const PAGE_SIZE = 200;

/**
 * One webview panel per table/view/data type showing paginated rows plus a DDL tab.
 * Scrolling near the bottom asks for the next page (LIMIT/OFFSET).
 *
 * For tables and views a per-table column selection can be applied (and is remembered):
 * only the chosen columns are queried and shown. Data types show fixed catalog detail
 * columns, so the selector does not apply to them.
 */
interface PanelState {
    node: PgNode;
    panel: vscode.WebviewPanel;
    provider: ProviderId;
    connStr: string;
    /** FROM-clause source: a qualified relation, or a parenthesised subquery. */
    source: string;
    /** Selected column names to project, or undefined for all (`SELECT *`). */
    columns?: string[];
    orderBy?: string;
    dir?: 'asc' | 'desc';
}

export class TableViewer {
    private readonly panels = new Map<string, PanelState>();

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
        private readonly channel: QueryChannel,
        private readonly prefs: ColumnPreferences,
    ) {}

    async open(node: PgNode): Promise<void> {
        const key = `${node.connName}/${node.kind}/${node.schema}/${node.objectName}`;
        const existing = this.panels.get(key);
        if (existing) { existing.panel.reveal(); return; }

        const resolved = await this.store.resolve(node.connName);
        if (!resolved) {
            vscode.window.showErrorMessage(`PGNet: unknown connection ${node.connName}`);
            return;
        }
        const { provider, connStr } = resolved;
        const selectable = node.kind === 'table' || node.kind === 'view';

        // apply a saved column selection, dropping any columns that no longer exist
        let columns: string[] | undefined;
        if (selectable) {
            const saved = this.prefs.get(node.connName, node.schema!, node.objectName!);
            if (saved && saved.length) {
                const all = await this.columnsOf(provider, connStr, node);
                const live = new Set(all.map(c => c.name));
                columns = saved.filter(n => live.has(n));
                if (columns.length === 0) { columns = undefined; }
            }
        }

        const title = `${node.schema}.${node.objectName}`;
        const panel = vscode.window.createWebviewPanel(
            'pgnetTable', title,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true });
        panel.webview.html = gridHtml({ mode: 'table', tableName: title, columns: selectable });
        const state: PanelState = { node, panel, provider, connStr, source: sourceFor(node), columns };
        this.panels.set(key, state);
        panel.onDidDispose(() => this.panels.delete(key));

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'export') { await handleExportMessage(msg); }
            else if (msg.type === 'loadMore') { await this.loadPage(state, msg.offset, false); }
            else if (msg.type === 'sort') {
                state.orderBy = msg.column;
                state.dir = msg.dir === 'desc' ? 'desc' : 'asc';
                await this.loadPage(state, 0, true); // re-query from the top, sorted
            }
            else if (msg.type === 'pickColumns') { await this.chooseColumns(state); }
            // open DDL in a real editor so it gets proper SQL syntax highlighting
            else if (msg.type === 'openDdl') { await openDefinition(state.node); }
        });

        this.postColumnInfo(state);
        await this.loadPage(state, 0, true);
    }

    /** Opens the column selector, then re-queries with (and remembers) the chosen columns. */
    private async chooseColumns(state: PanelState): Promise<void> {
        const { node } = state;
        let all: ColumnInfo[];
        try {
            all = await this.columnsOf(state.provider, state.connStr, node);
        } catch (e: any) {
            vscode.window.showErrorMessage(`PGNet: could not load columns — ${e?.message ?? e}`);
            return;
        }
        if (all.length === 0) { return; }

        const current = state.columns ?? all.map(c => c.name);
        const chosen = await pickColumns(`${node.schema}.${node.objectName}`, all, current);
        if (chosen === undefined) { return; } // cancelled

        state.columns = chosen.length === all.length ? undefined : chosen;
        // a sort on a now-hidden column would fail, so drop it
        if (state.orderBy && state.columns && !state.columns.includes(state.orderBy)) {
            state.orderBy = undefined;
        }
        await this.prefs.set(node.connName, node.schema!, node.objectName!, chosen, all.map(c => c.name));
        this.postColumnInfo(state);
        await this.loadPage(state, 0, true);
    }

    private columnCache = new Map<string, ColumnInfo[]>();
    private async columnsOf(provider: ProviderId, connStr: string, node: PgNode): Promise<ColumnInfo[]> {
        const key = `${node.connName}/${node.schema}/${node.objectName}`;
        const hit = this.columnCache.get(key);
        if (hit) { return hit; }
        const cols = await this.client.request<ColumnInfo[]>(
            'GetColumns', provider, connStr, node.schema, node.objectName);
        this.columnCache.set(key, cols);
        return cols;
    }

    /** Tells the grid how many columns are shown vs total, for the toolbar label. */
    private postColumnInfo(state: PanelState): void {
        const all = this.columnCache.get(`${state.node.connName}/${state.node.schema}/${state.node.objectName}`);
        state.panel.webview.postMessage({
            type: 'columnInfo',
            selected: state.columns ? state.columns.length : (all ? all.length : undefined),
            total: all ? all.length : undefined,
        });
    }

    private async loadPage(state: PanelState, offset: number, reset: boolean): Promise<void> {
        const panel = state.panel;
        const requestId = this.channel.newRequestId('t');
        if (reset) { panel.webview.postMessage({ type: 'start', reset: true }); }

        let pageRows = 0;
        const channel = this.channel;
        const sink: QuerySink = {
            onColumns: (columns) => panel.webview.postMessage({ type: 'columns', columns }),
            onRows: (rows) => { pageRows += rows.length; panel.webview.postMessage({ type: 'rows', rows }); },
            onNotice: (message) => panel.webview.postMessage({ type: 'notice', message }),
            onComplete: (result: QueryComplete) => {
                channel.release(requestId);
                panel.webview.postMessage({ type: 'complete', ...result, pageRows, pageSize: PAGE_SIZE });
            },
        };
        const projection = state.columns
            ? state.columns.map(c => quoteIdent(state.provider, c)).join(', ')
            : '*';
        const order = state.orderBy
            ? ` ORDER BY ${quoteIdent(state.provider, state.orderBy)} ${state.dir === 'desc' ? 'DESC' : 'ASC'}`
            : '';
        const sql = `SELECT ${projection} FROM ${state.source}${order} LIMIT ${PAGE_SIZE} OFFSET ${offset};`;
        await this.channel.run(state.provider, state.connStr, sql, requestId, sink);
    }
}

function sourceFor(node: PgNode): string {
    // data types exist only on Postgres, where their "rows" come from the catalogs
    if (node.kind === 'type') {
        return `(${typeDetailSql(node.schema!, node.objectName!, node.typeKind)}\n) AS pgnet_type_detail`;
    }
    const q = (name: string) => quoteIdent(node.provider, name);
    return `${q(node.schema!)}.${q(node.objectName!)}`;
}
