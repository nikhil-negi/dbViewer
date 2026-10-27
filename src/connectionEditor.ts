import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import {
    PROVIDERS, ProviderId, isProviderId, providerInfo,
    fieldsFromConnectionString, connectionStringFromFields, ConnectionFields,
} from './providers';
import type { EditorForm, EditorFromWebview, EditorLoad, EditorToWebview } from './webview/protocol';
import { webviewHtml, webviewOptions } from './webview/webviewHtml';

interface TestResult {
    success: boolean;
    serverVersion?: string;
    error?: { message: string };
}

/**
 * A webview dialog (React: webview-ui/connectionEditor) for adding and editing connections: one labeled input per
 * setting (type, host, port, database, username, password, …), a paste-to-fill
 * bar for whole connection strings, and an in-place Test button.
 *
 * When editing, the saved password is shown (hidden behind a reveal toggle) so it can
 * be seen and corrected; clearing the box removes the password.
 */
export class ConnectionEditor {
    private panel: vscode.WebviewPanel | undefined;
    private ready = false;
    private pendingLoad: EditorLoad | undefined;
    private mode: 'add' | 'edit' = 'add';
    private editing: string | undefined;
    private queue: string[] = [];
    private queueTotal = 0;

    constructor(
        private readonly extensionUri: vscode.Uri,
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
        if (mode === 'edit' && name) {
            provider = this.store.provider(name);
            // the saved password is shown in the edit form (behind a reveal toggle) so it
            // can be seen and corrected; it stays out of any command/paste history
            fields = fieldsFromConnectionString(await this.store.get(name) ?? '');
        }

        const progress = this.queueTotal > 1
            ? `${this.queueTotal - this.queue.length} of ${this.queueTotal}`
            : '';
        this.panel!.title = mode === 'add'
            ? 'New Connection'
            : `Edit Connection — ${name}${progress ? ` (${progress})` : ''}`;

        const load: EditorLoad = {
            type: 'load', mode, name: name ?? '', provider, fields,
            existingNames: this.store.names(),
            inQueue: this.queue.length > 0 || this.queueTotal > 1,
            progress,
            providers: Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label })),
        };
        if (this.ready) { this.post(load); } else { this.pendingLoad = load; }
        this.panel!.reveal();
    }

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.ready = false;
        this.panel = vscode.window.createWebviewPanel(
            'dbviewerConnectionEditor', 'Connection',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            webviewOptions(this.extensionUri));
        this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'connectionEditor');
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queue = [];
        });
        this.panel.webview.onDidReceiveMessage(async (msg: EditorFromWebview) => {
            switch (msg.type) {
                case 'ready':
                    this.ready = true;
                    if (this.pendingLoad) { this.post(this.pendingLoad); this.pendingLoad = undefined; }
                    break;
                case 'parse': this.fillFromString(String(msg.text ?? '')); break;
                // live preview: assemble the exact string that would be saved
                case 'preview': this.post({ type: 'connstr', value: this.assemble(msg.form).connStr }); break;
                case 'test': await this.test(msg.form); break;
                case 'save': await this.save(msg.form); break;
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
    private assemble(form: EditorForm): { provider: ProviderId; connStr: string } {
        const provider: ProviderId = isProviderId(form.provider) ? form.provider : 'postgres';
        // the form shows the real password when editing, so its value is authoritative —
        // an empty box means "no password"
        return { provider, connStr: connectionStringFromFields({ ...form }) };
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
            const { provider, connStr } = this.assemble(form);
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
            const { provider, connStr } = this.assemble(form);
            await this.store.add(name, connStr, provider);
            this.onSaved();
            vscode.window.showInformationMessage(`DBViewer: connection "${name}" saved.`);
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

    private post(message: EditorToWebview): void {
        void this.panel?.webview.postMessage(message);
    }
}
