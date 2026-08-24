import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { QueryChannel, QuerySink, QueryComplete } from './queryChannel';
import { PgNode } from './pgTreeView';
import { gridHtml } from './webview/gridHtml';
import { handleExportMessage } from './exportHelper';
import { openDefinition } from './pgDocumentProvider';

const PAGE_SIZE = 200;

/**
 * One webview panel per table/view showing paginated data plus a DDL tab.
 * Scrolling near the bottom asks for the next page (LIMIT/OFFSET).
 */
interface PanelState {
    panel: vscode.WebviewPanel;
    orderBy?: string;
    dir?: 'asc' | 'desc';
}

export class TableViewer {
    private readonly panels = new Map<string, PanelState>();

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
        private readonly channel: QueryChannel,
    ) {}

    async open(node: PgNode): Promise<void> {
        const key = `${node.connName}/${node.schema}/${node.objectName}`;
        const existing = this.panels.get(key);
        if (existing) { existing.panel.reveal(); return; }

        const connStr = await this.store.get(node.connName);
        if (!connStr) {
            vscode.window.showErrorMessage(`PGNet: unknown connection ${node.connName}`);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pgnetTable', `${node.schema}.${node.objectName}`,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true });
        panel.webview.html = gridHtml({ mode: 'table', tableName: `${node.schema}.${node.objectName}` });
        const state: PanelState = { panel };
        this.panels.set(key, state);
        panel.onDidDispose(() => this.panels.delete(key));

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'export') { await handleExportMessage(msg); }
            else if (msg.type === 'loadMore') { await this.loadPage(state, connStr, node, msg.offset, false); }
            else if (msg.type === 'sort') {
                state.orderBy = msg.column;
                state.dir = msg.dir === 'desc' ? 'desc' : 'asc';
                await this.loadPage(state, connStr, node, 0, true); // re-query from the top, sorted
            }
            // open DDL in a real editor so it gets proper SQL syntax highlighting
            else if (msg.type === 'openDdl') { await openDefinition(node); }
        });

        await this.loadPage(state, connStr, node, 0, true);
    }

    private async loadPage(
        state: PanelState, connStr: string, node: PgNode, offset: number, reset: boolean,
    ): Promise<void> {
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
        const order = state.orderBy
            ? ` ORDER BY "${state.orderBy.replace(/"/g, '""')}" ${state.dir === 'desc' ? 'DESC' : 'ASC'}`
            : '';
        const sql = `SELECT * FROM "${node.schema}"."${node.objectName}"${order} LIMIT ${PAGE_SIZE} OFFSET ${offset};`;
        await this.channel.run(connStr, sql, requestId, sink);
    }
}
