import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';

interface QueryComplete {
    requestId: string;
    success: boolean;
    rowCount: number;
    elapsedMs: number;
    error?: { code: string; message: string; severity: string } | null;
}

/** Runs editor SQL through the .NET worker and streams rows into a webview grid. */
export class QueryExecutor {
    private panel: vscode.WebviewPanel | undefined;
    private activeRequestId: string | undefined;
    private seq = 0;
    private activeConnection: string | undefined;
    private readonly statusBar: vscode.StatusBarItem;

    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'pgnet.selectConnection';
        this.statusBar.tooltip = 'PGNet: click to switch the active connection';
        this.updateStatusBar();
        client.onNotification('onColumns', (requestId: string, columns: unknown) =>
            this.post({ type: 'columns', requestId, columns }));
        client.onNotification('onDataChunk', (requestId: string, rows: unknown) =>
            this.post({ type: 'rows', requestId, rows }));
        client.onNotification('onNotice', (requestId: string, message: string) =>
            this.post({ type: 'notice', requestId, message }));
        client.onNotification('onQueryComplete', (result: QueryComplete) => {
            this.post({ type: 'complete', ...result });
            if (result.requestId === this.activeRequestId) { this.activeRequestId = undefined; }
        });
    }

    async runFromActiveEditor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('PGNet: no active editor.');
            return;
        }
        const sql = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);
        if (!sql.trim()) { return; }

        const connName = await this.pickConnection();
        if (!connName) { return; }
        const connStr = await this.store.get(connName);
        if (!connStr) { return; }

        this.ensurePanel();
        const requestId = `q${++this.seq}`;
        this.activeRequestId = requestId;
        this.post({ type: 'start', requestId, connection: connName });
        await this.client.requestNoWait('ExecuteQueryStream', connStr, sql, requestId);
    }

    async cancel(): Promise<void> {
        if (this.activeRequestId) {
            await this.client.request('CancelQuery', this.activeRequestId);
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
        this.panel.webview.html = RESULTS_HTML;
    }
}

const RESULTS_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; }
  .tabs { display: flex; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); }
  .tab { padding: 4px 12px; cursor: pointer; border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; }
  .tab.active { background: var(--vscode-tab-activeBackground); border-color: var(--vscode-panel-border); }
  .pane { display: none; padding: 8px; }
  .pane.active { display: block; }
  table { border-collapse: collapse; font-size: 12px; font-family: var(--vscode-editor-font-family); }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; text-align: left; white-space: nowrap; max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 30px; }
  td.null { opacity: 0.5; font-style: italic; }
  #messages, #metrics { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); }
  #gridwrap { overflow: auto; }
</style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-pane="grid">Data Grid</div>
    <div class="tab" data-pane="messages">Messages</div>
    <div class="tab" data-pane="metrics">Metrics</div>
  </div>
  <div id="grid" class="pane active"><div id="gridwrap"></div></div>
  <div id="messages" class="pane"></div>
  <div id="metrics" class="pane"></div>
<script>
  const wrap = document.getElementById('gridwrap');
  const messages = document.getElementById('messages');
  const metrics = document.getElementById('metrics');
  let table = null, tbody = null, rowCount = 0;
  const MAX_RENDER_ROWS = 5000;

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.pane).classList.add('active');
  }));

  function log(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    messages.appendChild(div);
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'start') {
      wrap.innerHTML = ''; messages.innerHTML = ''; metrics.innerHTML = '';
      table = null; tbody = null; rowCount = 0;
      log('Running on ' + m.connection + '...');
    } else if (m.type === 'columns') {
      table = document.createElement('table');
      const tr = document.createElement('tr');
      for (const c of m.columns) {
        const th = document.createElement('th');
        th.textContent = c.name + ' (' + c.type + ')';
        tr.appendChild(th);
      }
      const thead = document.createElement('thead');
      thead.appendChild(tr);
      table.appendChild(thead);
      tbody = document.createElement('tbody');
      table.appendChild(tbody);
      wrap.appendChild(table);
    } else if (m.type === 'rows' && tbody) {
      for (const row of m.rows) {
        rowCount++;
        if (rowCount > MAX_RENDER_ROWS) continue; // still counted, not rendered
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          if (cell === null) { td.textContent = 'NULL'; td.className = 'null'; }
          else td.textContent = String(cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    } else if (m.type === 'notice') {
      log(m.message);
    } else if (m.type === 'complete') {
      if (m.success) {
        log('Done. ' + m.rowCount + ' row(s) in ' + m.elapsedMs + ' ms.');
      } else {
        log((m.error?.code || 'ERROR') + ': ' + (m.error?.message || 'unknown error'), 'error');
      }
      metrics.textContent = 'Rows: ' + m.rowCount + '\\nElapsed: ' + m.elapsedMs + ' ms\\nStatus: ' + (m.success ? 'success' : 'failed');
      if (rowCount > MAX_RENDER_ROWS) log('Grid truncated to ' + MAX_RENDER_ROWS + ' rows (' + rowCount + ' received).');
    }
  });
</script>
</body>
</html>`;
