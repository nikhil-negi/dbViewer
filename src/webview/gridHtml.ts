/**
 * Shared results-grid webview HTML used by the query results panel and the
 * table data viewer. Features: tabbed UI (Data / DDL / Messages / Metrics),
 * row + column selection, CSV/SQL export, and (table mode) infinite-scroll
 * pagination via 'loadMore' messages to the extension.
 */
export function gridHtml(opts: { mode: 'query' | 'table'; tableName?: string }): string {
    const cfg = JSON.stringify({ mode: opts.mode, tableName: opts.tableName ?? 'query_result' });
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; }
  .bar { display: flex; align-items: center; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--vscode-panel-border);
         position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
  .tab { padding: 4px 12px; cursor: pointer; border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; }
  .tab.active { background: var(--vscode-tab-activeBackground); border-color: var(--vscode-panel-border); }
  .spacer { flex: 1; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; border-radius: 3px; padding: 3px 10px; margin: 0 2px 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .pane { display: none; padding: 8px; }
  .pane.active { display: block; }
  table { border-collapse: collapse; font-size: 12px; font-family: var(--vscode-editor-font-family); user-select: text; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; text-align: left; white-space: nowrap;
           max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; cursor: pointer; }
  th.rownum, td.rownum { background: var(--vscode-editor-inactiveSelectionBackground); cursor: pointer;
                         text-align: right; opacity: 0.7; user-select: none; }
  td.null { opacity: 0.5; font-style: italic; }
  tbody tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
  .t-num  { color: var(--vscode-charts-blue,   #569cd6); }
  .t-date { color: var(--vscode-charts-purple, #c586c0); }
  .t-bool { color: var(--vscode-charts-green,  #4ec9b0); }
  .t-uuid { color: var(--vscode-charts-yellow, #d7ba7d); }
  .t-json { color: var(--vscode-charts-orange, #ce9178); }
  th.sorted { text-decoration: underline; }
  tr.selrow td, th.selcol, td.selcol { background: var(--vscode-editor-selectionBackground) !important;
                                        color: var(--vscode-editor-selectionForeground, inherit); }
  #messages, #metrics { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); }
  #gridwrap { overflow: auto; max-height: calc(100vh - 80px); }
  #ddl { font-family: var(--vscode-editor-font-family); font-size: 13px; white-space: pre; overflow: auto; }
  #status { font-size: 11px; opacity: 0.8; padding: 0 8px 4px; }
</style>
</head>
<body>
  <div class="bar">
    <div class="tab active" data-pane="grid">Data</div>
    <div class="tab" id="ddltab" style="display:none" title="Open DDL in an editor">DDL ↗</div>
    <div class="tab" data-pane="messages">Messages</div>
    <div class="tab" data-pane="metrics">Metrics</div>
    <div class="spacer"></div>
    <button id="exportCsv">Export CSV</button>
    <button id="exportSql">Export SQL</button>
    <button id="clearSel">Clear selection</button>
  </div>
  <div id="grid" class="pane active"><div id="gridwrap"><table id="tbl" style="display:none"></table></div></div>
  <div id="messages" class="pane"></div>
  <div id="metrics" class="pane"></div>
  <div id="status"></div>
<script>
  const CFG = ${cfg};
  const vscode = acquireVsCodeApi();
  const wrap = document.getElementById('gridwrap');
  const tbl = document.getElementById('tbl');
  const messages = document.getElementById('messages');
  const metrics = document.getElementById('metrics');
  const status = document.getElementById('status');
  const MAX_RENDER_ROWS = 5000;

  let columns = [];          // [{name,type}]
  let data = [];             // full row data (arrays), kept for export
  let tbody = null;
  let selRows = new Set(), selCols = new Set();
  let loading = false, exhausted = false, running = false;
  let sortCol = null, sortDir = 'asc', rowAnchor = null;

  function typeClass(t) {
    t = (t || '').toLowerCase();
    if (/int|numeric|float|double|real|money|serial|decimal/.test(t)) return 't-num';
    if (/timestamp|date|time|interval/.test(t)) return 't-date';
    if (/bool/.test(t)) return 't-bool';
    if (/uuid/.test(t)) return 't-uuid';
    if (/json/.test(t)) return 't-json';
    return '';
  }

  if (CFG.mode === 'table') {
    const ddltab = document.getElementById('ddltab');
    ddltab.style.display = '';
    ddltab.addEventListener('click', () => vscode.postMessage({ type: 'openDdl' }));
  }

  document.querySelectorAll('.tab[data-pane]').forEach(t => t.addEventListener('click', () => {
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

  function resetGrid() {
    tbl.innerHTML = ''; tbl.style.display = 'none';
    data = []; columns = []; tbody = null;
    selRows.clear(); selCols.clear(); rowAnchor = null;
    exhausted = false;
    if (CFG.mode === 'query') { sortCol = null; }
  }

  // sort: plain click on a header sorts (toggles asc/desc);
  // cmd/ctrl-click selects the column instead
  function onHeaderClick(ci, e) {
    if (e.metaKey || e.ctrlKey) {
      selCols.has(ci) ? selCols.delete(ci) : selCols.add(ci);
      paintSelection();
      return;
    }
    sortDir = (sortCol === ci && sortDir === 'asc') ? 'desc' : 'asc';
    sortCol = ci;
    if (CFG.mode === 'table') {
      vscode.postMessage({ type: 'sort', column: columns[ci].name, dir: sortDir });
    } else {
      localSort();
    }
    updateSortIndicators();
  }

  function localSort() {
    const ci = sortCol, dir = sortDir === 'asc' ? 1 : -1;
    const isNum = v => v !== null && /^-?\\d+(\\.\\d+)?$/.test(String(v));
    data.sort((a, b) => {
      const x = a[ci], y = b[ci];
      if (x === null) return 1;               // nulls last
      if (y === null) return -1;
      if (isNum(x) && isNum(y)) return (Number(x) - Number(y)) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
    selRows.clear(); rowAnchor = null;
    renderBody();
  }

  function updateSortIndicators() {
    tbl.querySelectorAll('th[data-col]').forEach(th => {
      const ci = Number(th.dataset.col);
      th.classList.toggle('sorted', ci === sortCol);
      th.textContent = th.dataset.label + (ci === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    });
  }

  function buildHeader() {
    tbl.style.display = '';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'rownum'; corner.textContent = '#';
    tr.appendChild(corner);
    columns.forEach((c, ci) => {
      const th = document.createElement('th');
      th.dataset.label = c.name + ' (' + c.type + ')';
      th.textContent = th.dataset.label;
      th.dataset.col = ci;
      const thCls = typeClass(c.type);
      if (thCls) th.classList.add(thCls); // classList.add('') throws
      th.title = 'Click to sort · Cmd/Ctrl-click to select column';
      th.addEventListener('click', (e) => onHeaderClick(ci, e));
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    tbl.appendChild(thead);
    tbody = document.createElement('tbody');
    tbl.appendChild(tbody);
    updateSortIndicators();
  }

  function onRowNumClick(ri, e) {
    if (e.shiftKey && rowAnchor !== null) {
      // shift-click: select the range from the anchor, like a text editor
      if (!e.metaKey && !e.ctrlKey) { selRows.clear(); }
      const [lo, hi] = [Math.min(rowAnchor, ri), Math.max(rowAnchor, ri)];
      for (let i = lo; i <= hi; i++) selRows.add(i);
    } else if (e.metaKey || e.ctrlKey) {
      selRows.has(ri) ? selRows.delete(ri) : selRows.add(ri);
      rowAnchor = ri;
    } else {
      selRows.clear(); selCols.clear();
      selRows.add(ri);
      rowAnchor = ri;
    }
    paintSelection();
  }

  function renderRow(ri) {
    const row = data[ri];
    const tr = document.createElement('tr');
    tr.dataset.row = ri;
    const num = document.createElement('td');
    num.className = 'rownum'; num.textContent = ri + 1;
    num.addEventListener('click', (e) => onRowNumClick(ri, e));
    tr.appendChild(num);
    row.forEach((cell, ci) => {
      const td = document.createElement('td');
      td.dataset.col = ci;
      if (cell === null) { td.textContent = 'NULL'; td.className = 'null'; }
      else {
        td.textContent = String(cell);
        const cls = typeClass(columns[ci].type);
        if (cls) td.classList.add(cls);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  function renderBody() {
    tbody.innerHTML = '';
    const n = Math.min(data.length, MAX_RENDER_ROWS);
    for (let i = 0; i < n; i++) renderRow(i);
    paintSelection();
  }

  function appendRows(rows) {
    for (const row of rows) {
      const ri = data.length;
      data.push(row);
      if (ri < MAX_RENDER_ROWS) renderRow(ri);
    }
    status.textContent = data.length + ' row(s) loaded' + (exhausted ? ' (all)' : '');
  }

  function paintSelection() {
    tbody.querySelectorAll('tr').forEach(tr => {
      const ri = Number(tr.dataset.row);
      tr.classList.toggle('selrow', selRows.has(ri));
      tr.querySelectorAll('td[data-col]').forEach(td =>
        td.classList.toggle('selcol', selCols.has(Number(td.dataset.col))));
    });
    tbl.querySelectorAll('th[data-col]').forEach(th =>
      th.classList.toggle('selcol', selCols.has(Number(th.dataset.col))));
  }

  document.getElementById('clearSel').addEventListener('click', () => {
    selRows.clear(); selCols.clear(); paintSelection();
  });

  // --- export ---
  function exportSet() {
    const rowIdx = selRows.size ? [...selRows].sort((a,b)=>a-b) : data.map((_, i) => i);
    const colIdx = selCols.size ? [...selCols].sort((a,b)=>a-b) : columns.map((_, i) => i);
    return { rowIdx, colIdx };
  }
  function csvEscape(v) {
    if (v === null) return '';
    v = String(v);
    return /[",\\n\\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function sqlLit(v) {
    return v === null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  }
  document.getElementById('exportCsv').addEventListener('click', () => {
    const { rowIdx, colIdx } = exportSet();
    const lines = [colIdx.map(ci => csvEscape(columns[ci].name)).join(',')];
    for (const ri of rowIdx) lines.push(colIdx.map(ci => csvEscape(data[ri][ci])).join(','));
    vscode.postMessage({ type: 'export', format: 'csv', content: lines.join('\\n'), name: CFG.tableName });
  });
  document.getElementById('exportSql').addEventListener('click', () => {
    const { rowIdx, colIdx } = exportSet();
    const cols = colIdx.map(ci => '"' + columns[ci].name + '"').join(', ');
    const stmts = rowIdx.map(ri =>
      'INSERT INTO ' + CFG.tableName + ' (' + cols + ') VALUES (' +
      colIdx.map(ci => sqlLit(data[ri][ci])).join(', ') + ');');
    vscode.postMessage({ type: 'export', format: 'sql', content: stmts.join('\\n'), name: CFG.tableName });
  });

  // --- infinite scroll (table mode) ---
  wrap.addEventListener('scroll', () => {
    if (CFG.mode !== 'table' || loading || exhausted || running) return;
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 100) {
      loading = true;
      vscode.postMessage({ type: 'loadMore', offset: data.length });
    }
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'start') {
      running = true;
      if (m.reset !== false) { resetGrid(); messages.innerHTML = ''; metrics.innerHTML = ''; }
      if (m.connection) log('Running on ' + m.connection + '...');
    } else if (m.type === 'columns') {
      if (!tbody) { columns = m.columns; buildHeader(); }
    } else if (m.type === 'rows') {
      appendRows(m.rows);
    } else if (m.type === 'notice') {
      log(m.message);
    } else if (m.type === 'complete') {
      running = false; loading = false;
      if (m.success) {
        if (m.pageRows !== undefined && m.pageSize !== undefined && m.pageRows < m.pageSize) exhausted = true;
        log('Done. ' + m.rowCount + ' row(s) in ' + m.elapsedMs + ' ms.');
      } else {
        exhausted = true;
        log((m.error && m.error.code || 'ERROR') + ': ' + (m.error && m.error.message || 'unknown error'), 'error');
      }
      metrics.textContent = 'Rows loaded: ' + data.length + '\\nLast batch: ' + m.rowCount +
        ' row(s), ' + m.elapsedMs + ' ms\\nStatus: ' + (m.success ? 'success' : 'failed');
      status.textContent = data.length + ' row(s) loaded' + (exhausted ? ' (all)' : '');
      if (data.length > MAX_RENDER_ROWS) log('Grid render capped at ' + MAX_RENDER_ROWS + ' rows (' + data.length + ' held for export).');
    }
  });
</script>
</body>
</html>`;
}
