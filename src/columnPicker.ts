import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface ColumnInfo { name: string; type: string; }

/**
 * A webview dialog for choosing which columns of a table to show. Lists every column
 * with a checkbox, a search box that fuzzy-matches names (tolerant of `_`/spaces, word
 * position and typos — the same matcher as src/fuzzy.ts, inlined so search is instant),
 * and a select-all toggle scoped to the current search. Resolves to the chosen column
 * names in table order, or undefined if cancelled.
 */
export function pickColumns(
    title: string, columns: ColumnInfo[], selected: string[],
): Promise<string[] | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'pgnetColumnPicker', `Columns — ${title}`,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true });

        let settled = false;
        const finish = (result: string[] | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(result);
            panel.dispose();
        };

        panel.webview.html = html(title, columns, new Set(selected));
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'apply') {
                const checked = new Set<string>(msg.columns ?? []);
                finish(columns.map(c => c.name).filter(n => checked.has(n)));
            } else if (msg.type === 'cancel') {
                finish(undefined);
            }
        });
        panel.onDidDispose(() => finish(undefined));
    });
}

function html(title: string, columns: ColumnInfo[], selected: Set<string>): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const data = JSON.stringify({
        columns: columns.map(c => ({
            name: c.name,
            type: c.type,
            checked: selected.size === 0 || selected.has(c.name),
        })),
    });
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; }
  .wrap { display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
  .controls { display: flex; gap: 10px; align-items: center; }
  #search { flex: 1; font-size: 13px; padding: 6px 8px; border-radius: 3px;
            color: var(--vscode-input-foreground); background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent); outline: none; }
  #search:focus { border-color: var(--vscode-focusBorder); }
  .selall { display: flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; cursor: pointer; user-select: none; }
  #count { font-size: 11px; opacity: 0.7; margin-top: 6px; }
  .list { flex: 1; overflow: auto; padding: 6px 8px; }
  .row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 3px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row input { margin: 0; align-self: center; }
  .name { font-family: var(--vscode-editor-font-family); font-size: 13px; }
  .name b { color: var(--vscode-textLink-foreground); font-weight: 700; }
  .type { font-size: 11px; opacity: 0.6; margin-left: auto; padding-left: 12px; font-family: var(--vscode-editor-font-family); }
  .none { opacity: 0.6; font-size: 12px; padding: 12px; }
  footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border); }
  .spacer { flex: 1; }
  button { font-size: 13px; padding: 6px 16px; border: none; border-radius: 3px; cursor: pointer; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h2>Show columns of ${escapeHtml(title)}</h2>
    <div class="controls">
      <label class="selall"><input type="checkbox" id="selectAll"> Select all</label>
      <input id="search" placeholder="Search columns… (ignores _/spaces, tolerates typos)" autofocus>
    </div>
    <div id="count"></div>
  </header>
  <div class="list" id="list"></div>
  <footer>
    <button class="secondary" id="reset">Reset to all</button>
    <div class="spacer"></div>
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="apply">Apply</button>
  </footer>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${data};
  const checked = new Map(DATA.columns.map(c => [c.name, c.checked]));
  const listEl = document.getElementById('list');
  const search = document.getElementById('search');
  const selectAll = document.getElementById('selectAll');
  const countEl = document.getElementById('count');
  let visible = DATA.columns.map(c => c.name);

  // separator test via characters (not a regex) to avoid escaping pitfalls in the inlined script
  const isSep = c => c === '_' || c === ' ' || c === '-' || c === '.';
  const norm = s => { let r = ''; for (const ch of s.toLowerCase()) if (!isSep(ch)) r += ch; return r; };
  const words = s => {
    const out = []; let cur = '';
    for (const ch of s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()) {
      if (isSep(ch)) { if (cur) { out.push(cur); cur = ''; } } else { cur += ch; }
    }
    if (cur) out.push(cur);
    return out;
  };
  function subseq(q, t) { let i = 0; for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++; return i === q.length; }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i-1] === b[j-1] ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + cost);
        cur.push(v); if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1; prev = cur;
    }
    return prev[b.length];
  }
  const maxEdits = n => n <= 3 ? 1 : n <= 6 ? 2 : 3;
  function score(query, target) {
    const q = norm(query); if (!q) return 0;
    const t = norm(target); if (!t) return -1;
    if (t === q) return 1000;
    if (t.startsWith(q)) return 900 - (t.length - q.length);
    const idx = t.indexOf(q); if (idx >= 0) return 800 - idx;
    for (const w of words(target)) if (w.startsWith(q)) return 700 - w.length;
    if (subseq(q, t)) return 500 - (t.length - q.length);
    const budget = maxEdits(q.length);
    let best = lev(q, t, budget);
    for (const w of words(target)) { best = Math.min(best, lev(q, w, budget)); if (best === 0) break; }
    if (best <= budget) return 300 - best * 50;
    return -1;
  }

  function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function highlight(name, query) {
    const q = norm(query); if (!q) return escapeHtml(name);
    const at = norm(name).indexOf(q); if (at < 0) return escapeHtml(name);
    let ni = 0, start = -1, end = -1;
    for (let i = 0; i < name.length; i++) {
      if (isSep(name[i])) continue;
      if (ni === at) start = i;
      if (ni === at + q.length - 1) { end = i; break; }
      ni++;
    }
    if (start < 0 || end < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, start)) + '<b>' + escapeHtml(name.slice(start, end + 1)) + '</b>' + escapeHtml(name.slice(end + 1));
  }

  function render() {
    const q = search.value.trim();
    const ranked = q
      ? DATA.columns.map(c => ({ c, s: score(q, c.name) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.c)
      : DATA.columns;
    visible = ranked.map(c => c.name);
    listEl.innerHTML = '';
    if (ranked.length === 0) { listEl.innerHTML = '<div class="none">No columns match “' + escapeHtml(q) + '”.</div>'; }
    for (const c of ranked) {
      const row = document.createElement('label');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked.get(c.name);
      cb.addEventListener('change', () => { checked.set(c.name, cb.checked); syncSelectAll(); updateCount(); });
      const nm = document.createElement('span');
      nm.className = 'name'; nm.innerHTML = highlight(c.name, q);
      const ty = document.createElement('span');
      ty.className = 'type'; ty.textContent = c.type;
      row.append(cb, nm, ty);
      listEl.appendChild(row);
    }
    syncSelectAll(); updateCount();
  }

  function syncSelectAll() {
    const on = visible.filter(n => checked.get(n)).length;
    selectAll.checked = visible.length > 0 && on === visible.length;
    selectAll.indeterminate = on > 0 && on < visible.length;
  }
  function updateCount() {
    const total = DATA.columns.length;
    const on = DATA.columns.filter(c => checked.get(c.name)).length;
    countEl.textContent = on + ' of ' + total + ' column(s) selected'
      + (search.value.trim() ? ' · ' + visible.length + ' shown' : '');
  }

  selectAll.addEventListener('change', () => {
    for (const n of visible) checked.set(n, selectAll.checked);
    render();
  });
  search.addEventListener('input', render);
  document.getElementById('reset').addEventListener('click', () => {
    for (const c of DATA.columns) checked.set(c.name, true);
    search.value = ''; render();
  });
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('apply').addEventListener('click', () => {
    vscode.postMessage({ type: 'apply', columns: DATA.columns.map(c => c.name).filter(n => checked.get(n)) });
  });
  search.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('apply').click(); });

  render();
  search.focus();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
