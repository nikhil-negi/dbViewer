import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import {
    PROVIDERS, ProviderId, isProviderId, providerInfo,
    fieldsFromConnectionString, connectionStringFromFields, connectionValue, ConnectionFields,
} from './providers';

/** What the webview form posts back on Test / Save. */
interface EditorForm extends ConnectionFields {
    name: string;
    provider: string;
}

interface TestResult {
    success: boolean;
    serverVersion?: string;
    error?: { message: string };
}

/**
 * A webview dialog for adding and editing connections: one labeled input per
 * setting (type, host, port, database, username, password, …), a paste-to-fill
 * bar for whole connection strings, and an in-place Test button.
 *
 * The stored password never travels to the webview — editing shows an empty
 * password box meaning "keep what is saved"; only a typed value replaces it.
 */
export class ConnectionEditor {
    private panel: vscode.WebviewPanel | undefined;
    private ready = false;
    private pendingLoad: unknown;
    private mode: 'add' | 'edit' = 'add';
    private editing: string | undefined;
    private hasStoredPassword = false;
    private queue: string[] = [];
    private queueTotal = 0;

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
        private readonly onSaved: () => void,
    ) {}

    openAdd(): void {
        this.queue = []; this.queueTotal = 0;
        void this.show('add');
    }

    openEdit(name: string): void {
        this.queue = []; this.queueTotal = 0;
        void this.show('edit', name);
    }

    /** Walks several connections in one panel — used after a DBeaver import. */
    openEditQueue(names: string[]): void {
        if (names.length === 0) { return; }
        this.queue = names.slice(1);
        this.queueTotal = names.length;
        void this.show('edit', names[0]);
    }

    private async show(mode: 'add' | 'edit', name?: string): Promise<void> {
        this.mode = mode;
        this.editing = name;
        this.ensurePanel();

        let provider: ProviderId = 'postgres';
        let fields: ConnectionFields = {
            host: '', port: '', database: '', username: '', password: '',
            protocol: '', sslMode: '', others: '',
        };
        this.hasStoredPassword = false;
        if (mode === 'edit' && name) {
            provider = this.store.provider(name);
            fields = fieldsFromConnectionString(await this.store.get(name) ?? '');
            this.hasStoredPassword = fields.password.length > 0;
            fields.password = ''; // never sent to the webview
        }

        const progress = this.queueTotal > 1
            ? `${this.queueTotal - this.queue.length} of ${this.queueTotal}`
            : '';
        this.panel!.title = mode === 'add'
            ? 'New Connection'
            : `Edit Connection — ${name}${progress ? ` (${progress})` : ''}`;

        const load = {
            type: 'load', mode, name: name ?? '', provider, fields,
            hasPassword: this.hasStoredPassword,
            existingNames: this.store.names(),
            inQueue: this.queue.length > 0 || this.queueTotal > 1,
            progress,
        };
        if (this.ready) { this.post(load); } else { this.pendingLoad = load; }
        this.panel!.reveal();
    }

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.ready = false;
        this.panel = vscode.window.createWebviewPanel(
            'pgnetConnectionEditor', 'Connection',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true });
        this.panel.webview.html = editorHtml();
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queue = [];
        });
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this.ready = true;
                    if (this.pendingLoad) { this.post(this.pendingLoad); this.pendingLoad = undefined; }
                    break;
                case 'parse': this.fillFromString(String(msg.text ?? '')); break;
                case 'test': await this.test(msg.form as EditorForm); break;
                case 'save': await this.save(msg.form as EditorForm); break;
                case 'cancel': this.advanceOrClose(); break;
            }
        });
    }

    /** Paste bar: parse a whole connection string and populate the fields. */
    private fillFromString(text: string): void {
        if (!text.trim()) { return; }
        const fields = fieldsFromConnectionString(text);
        // a filled password came from the user's own paste, so it may go back in
        const proto = fields.protocol.toLowerCase();
        const provider = proto === 'http' || proto === 'https' || ['8123', '8443'].includes(fields.port)
            ? 'clickhouse' : undefined;
        this.post({ type: 'fill', fields, provider });
    }

    /**
     * Builds the final connection string. An empty password box while editing
     * means "keep the saved one", so it is re-read from SecretStorage here.
     */
    private async assemble(form: EditorForm): Promise<{ provider: ProviderId; connStr: string }> {
        const provider: ProviderId = isProviderId(form.provider) ? form.provider : 'postgres';
        const fields: ConnectionFields = { ...form };
        if (!fields.password && this.mode === 'edit' && this.hasStoredPassword && this.editing) {
            const stored = await this.store.get(this.editing);
            fields.password = (stored && connectionValue(stored, 'Password', 'Pwd')) || '';
        }
        return { provider, connStr: connectionStringFromFields(fields) };
    }

    private validate(form: EditorForm): string | undefined {
        if (this.mode === 'add' && !form.name.trim()) { return 'Connection name is required.'; }
        if (!form.host.trim()) { return 'Host is required.'; }
        if (form.port.trim() && !/^\d+$/.test(form.port.trim())) { return 'Port must be a number.'; }
        return undefined;
    }

    private async test(form: EditorForm): Promise<void> {
        const invalid = this.validate(form);
        if (invalid) { this.post({ type: 'testResult', success: false, message: invalid }); return; }
        try {
            const { provider, connStr } = await this.assemble(form);
            const result = await this.client.request<TestResult>('TestConnection', provider, connStr);
            this.post({
                type: 'testResult',
                success: result.success,
                message: result.success
                    ? `Connected — ${providerInfo(provider).label} ${result.serverVersion ?? ''}`.trim()
                    : result.error?.message ?? 'Connection failed.',
            });
        } catch (e: any) {
            this.post({ type: 'testResult', success: false, message: e?.message ?? String(e) });
        }
    }

    private async save(form: EditorForm): Promise<void> {
        const invalid = this.validate(form);
        if (invalid) { this.post({ type: 'saveResult', success: false, message: invalid }); return; }
        const name = this.mode === 'edit' ? this.editing! : form.name.trim();
        try {
            const { provider, connStr } = await this.assemble(form);
            await this.store.add(name, connStr, provider);
            this.onSaved();
            vscode.window.showInformationMessage(`PGNet: connection "${name}" saved.`);
            this.advanceOrClose();
        } catch (e: any) {
            this.post({ type: 'saveResult', success: false, message: e?.message ?? String(e) });
        }
    }

    /** After Save (or Skip in a queue): next queued connection, else close the dialog. */
    private advanceOrClose(): void {
        const next = this.queue.shift();
        if (next) { void this.show('edit', next); }
        else { this.panel?.dispose(); }
    }

    private post(message: unknown): void {
        void this.panel?.webview.postMessage(message);
    }
}

function editorHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const providerOptions = Object.values(PROVIDERS)
        .map(p => `<option value="${p.id}">${p.label}</option>`)
        .join('');
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; display: flex; justify-content: center; }
  .card { width: min(560px, 92vw); padding: 20px 24px 28px; }
  h2 { font-size: 16px; font-weight: 600; margin: 0 0 2px; }
  .subtitle { font-size: 12px; opacity: 0.75; margin-bottom: 16px; }

  .pastebar { display: flex; gap: 6px; margin-bottom: 18px; }
  .pastebar input { flex: 1; }
  .hint { font-size: 11px; opacity: 0.6; margin: 4px 0 0; }

  .grid { display: grid; grid-template-columns: 130px 1fr; gap: 10px 12px; align-items: center; }
  label { font-size: 12px; text-align: right; opacity: 0.9; }
  label .req { color: var(--vscode-errorForeground); }
  input, select {
    font-family: inherit; font-size: 13px; padding: 5px 8px; border-radius: 3px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); outline: none; width: 100%;
    box-sizing: border-box;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  select { appearance: auto; }

  .rule { grid-column: 1 / -1; border-top: 1px solid var(--vscode-panel-border);
          margin: 6px 0 2px; }

  .actions { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
  button { font-size: 13px; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .spacer { flex: 1; }

  #status { margin-top: 14px; font-size: 12px; min-height: 18px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-testing-iconPassed, #4ec9b0); }
  #status.err { color: var(--vscode-errorForeground); }
  #nameWarn { grid-column: 2; font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700);
              display: none; margin-top: -6px; }
</style>
</head>
<body>
<div class="card">
  <h2 id="title">New Connection</h2>
  <div class="subtitle" id="subtitle">Fill in the server details, or paste a connection string below.</div>

  <div class="pastebar">
    <input id="paste" placeholder="host=...;port=...;database=...;uid=...;pwd=...   (paste to fill the form)">
    <button class="secondary" id="fillBtn">Fill</button>
  </div>

  <div class="grid">
    <label for="name">Name <span class="req">*</span></label>
    <input id="name" placeholder="local-dev">
    <div id="nameWarn">A connection with this name exists — saving will overwrite it.</div>

    <label for="provider">Database type</label>
    <select id="provider">${providerOptions}</select>

    <div class="rule"></div>

    <label for="host">Host <span class="req">*</span></label>
    <input id="host" placeholder="localhost">

    <label for="port">Port</label>
    <input id="port" placeholder="5432">

    <label for="database">Database</label>
    <input id="database" placeholder="postgres">

    <label for="username">Username</label>
    <input id="username" placeholder="postgres">

    <label for="password">Password</label>
    <input id="password" type="password">

    <label for="protocol" class="ch-only">Protocol</label>
    <select id="protocol" class="ch-only">
      <option value="">http (default)</option>
      <option value="https">https</option>
    </select>

    <label for="sslMode" class="pg-only">SSL mode</label>
    <select id="sslMode" class="pg-only">
      <option value="">server default</option>
      <option value="Require">Require</option>
      <option value="Prefer">Prefer</option>
      <option value="Disable">Disable</option>
    </select>

    <label for="others">Other options</label>
    <input id="others" placeholder="key=value;key2=value2  (optional)">
  </div>

  <div class="actions">
    <button class="secondary" id="test">Test Connection</button>
    <div class="spacer"></div>
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="save">Save</button>
  </div>
  <div id="status"></div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const FIELDS = ['host', 'port', 'database', 'username', 'password', 'protocol', 'sslMode', 'others'];
  let existingNames = [];
  let mode = 'add';

  function form() {
    const f = { name: $('name').value, provider: $('provider').value };
    for (const k of FIELDS) f[k] = $(k).value;
    return f;
  }

  function applyProvider() {
    const ch = $('provider').value === 'clickhouse';
    document.querySelectorAll('.ch-only').forEach(e => e.style.display = ch ? '' : 'none');
    document.querySelectorAll('.pg-only').forEach(e => e.style.display = ch ? 'none' : '');
    $('port').placeholder = ch ? '8123' : '5432';
    $('database').placeholder = ch ? 'default' : 'postgres';
    $('username').placeholder = ch ? 'default' : 'postgres';
  }

  function status(text, cls) {
    const el = $('status');
    el.textContent = text || '';
    el.className = cls || '';
  }

  function updateNameWarn() {
    $('nameWarn').style.display =
      mode === 'add' && existingNames.includes($('name').value.trim()) ? '' : 'none';
  }

  $('provider').addEventListener('change', applyProvider);
  $('name').addEventListener('input', updateNameWarn);
  $('fillBtn').addEventListener('click', () => vscode.postMessage({ type: 'parse', text: $('paste').value }));
  $('paste').addEventListener('keydown', e => {
    if (e.key === 'Enter') vscode.postMessage({ type: 'parse', text: $('paste').value });
  });
  $('test').addEventListener('click', () => {
    status('Testing connection…');
    $('test').disabled = true;
    vscode.postMessage({ type: 'test', form: form() });
  });
  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', form: form() }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'load') {
      mode = m.mode;
      existingNames = m.existingNames || [];
      $('title').textContent = m.mode === 'add' ? 'New Connection'
        : 'Edit Connection — ' + m.name + (m.progress ? '  (' + m.progress + ')' : '');
      $('subtitle').textContent = m.mode === 'add'
        ? 'Fill in the server details, or paste a connection string below.'
        : 'Update the details for this connection, or paste a connection string below.';
      $('name').value = m.name;
      $('name').disabled = m.mode === 'edit';
      $('provider').value = m.provider;
      for (const k of FIELDS) $(k).value = m.fields[k] || '';
      $('password').value = '';
      $('password').placeholder = m.hasPassword
        ? '••••••••  (leave blank to keep the saved password)' : '';
      $('cancel').textContent = m.inQueue ? 'Skip' : 'Cancel';
      $('paste').value = '';
      applyProvider();
      updateNameWarn();
      status('');
      ($('name').disabled ? $('host') : $('name')).focus();
    } else if (m.type === 'fill') {
      for (const k of FIELDS) { if (m.fields[k]) $(k).value = m.fields[k]; }
      if (m.provider) $('provider').value = m.provider;
      applyProvider();
      status('Form filled from the pasted string.', 'ok');
    } else if (m.type === 'testResult') {
      $('test').disabled = false;
      status(m.message, m.success ? 'ok' : 'err');
    } else if (m.type === 'saveResult') {
      status(m.message, m.success ? 'ok' : 'err');
    }
  });

  applyProvider();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
