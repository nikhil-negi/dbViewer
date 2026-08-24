import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { providerInfo } from './providers';

const FILE_MAP_KEY = 'dbviewer.fileBindings';
const LEGACY_MAP_KEY = 'dbviewer.fileConnections';

/** A file's execution context: which server, and (optionally) which schema to default to. */
export interface FileBinding {
    connection: string;
    schema?: string;
}

/** Documents that run SQL, and so have a connection context. */
function isSqlDocument(doc: vscode.TextDocument | undefined): boolean {
    return !!doc && (doc.languageId === 'sql' || doc.uri.scheme === 'pg-schema');
}

/**
 * A DDL document opened from the explorer already names its connection in the URI, so
 * queries run inside it belong to that server.
 */
function bindingFromUri(uri: vscode.Uri): FileBinding | undefined {
    if (uri.scheme !== 'pg-schema') { return undefined; }
    const params = new URLSearchParams(uri.query);
    const connection = params.get('conn') ?? uri.authority;
    if (!connection) { return undefined; }
    const schema = uri.path.split('/')[1] || undefined; // pg-schema://conn/<schema>/<obj>.sql
    return { connection, schema };
}

/**
 * Remembers, per SQL file, which connection its queries run on and which schema they
 * default to — so several servers can be open at once with no hidden "current"
 * connection, and unqualified table names resolve against the file's schema.
 *
 * Each binding is explicit and pinned to the document URI; there is deliberately no
 * moving workspace-wide default, so opening or binding one file never changes where an
 * already-open file runs.
 */
export class ConnectionContext implements vscode.Disposable {
    private readonly connItem: vscode.StatusBarItem;
    private readonly schemaItem: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    /** The SQL editor most recently focused; the target for "run" when focus is elsewhere. */
    private lastSqlEditor: vscode.TextEditor | undefined;

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly store: ConnectionStore,
        /** Lists the schemas of a connection (hits the worker); used to populate the schema picker. */
        private readonly listSchemas: (connName: string) => Promise<string[]>,
    ) {
        this.connItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
        this.connItem.command = 'dbviewer.setFileConnection';
        this.connItem.name = 'DBViewer Connection';
        this.schemaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.schemaItem.command = 'dbviewer.setFileSchema';
        this.schemaItem.name = 'DBViewer Schema';

        this.disposables.push(
            this.connItem, this.schemaItem, this._onDidChange,
            vscode.window.onDidChangeActiveTextEditor(e => { this.trackEditor(e); this.render(); }),
            vscode.workspace.onDidOpenTextDocument(() => this.render()),
        );
        this.trackEditor(vscode.window.activeTextEditor);
        this.render();
    }

    private trackEditor(editor: vscode.TextEditor | undefined): void {
        if (editor && isSqlDocument(editor.document)) { this.lastSqlEditor = editor; }
    }

    /**
     * The SQL editor a "run" should target: the active one if it is SQL, otherwise the
     * last SQL editor that had focus (so running from the results webview still hits the
     * file the user was last editing, not an arbitrary visible one).
     */
    activeSqlEditor(): vscode.TextEditor | undefined {
        const active = vscode.window.activeTextEditor;
        if (active && isSqlDocument(active.document)) { return active; }
        if (this.lastSqlEditor) {
            // make sure it is still open
            const stillOpen = vscode.window.visibleTextEditors.includes(this.lastSqlEditor)
                || vscode.workspace.textDocuments.includes(this.lastSqlEditor.document);
            if (stillOpen) { return this.lastSqlEditor; }
        }
        return vscode.window.visibleTextEditors.find(e => isSqlDocument(e.document));
    }

    /** The binding for a document, from its explicit pin or inferred from a pg-schema URI. */
    forDocument(doc: vscode.TextDocument | undefined): FileBinding | undefined {
        if (!doc) { return undefined; }
        const stored = this.bindings()[doc.uri.toString()];
        const binding = stored ?? bindingFromUri(doc.uri);
        if (!binding || !this.store.has(binding.connection)) { return undefined; }
        return binding;
    }

    /**
     * Returns the document's binding, prompting for a connection (and offering a schema)
     * the first time. The choice is pinned to that document.
     */
    async ensureForDocument(doc: vscode.TextDocument | undefined): Promise<FileBinding | undefined> {
        const existing = this.forDocument(doc);
        if (existing) { return existing; }

        const names = this.store.names();
        if (names.length === 0) {
            vscode.window.showWarningMessage('DBViewer: add a connection first (DBViewer: Add Connection).');
            return undefined;
        }
        const connection = names.length === 1 ? names[0] : await this.pickConnection(doc);
        if (!connection) { return undefined; }
        const schema = await this.pickSchema(connection, undefined);
        const binding: FileBinding = { connection, schema };
        await this.bind(doc, binding);
        return binding;
    }

    /** Status-bar command: change the active file's connection (then offer a schema). */
    async setConnectionForActiveEditor(): Promise<void> {
        const doc = this.activeSqlEditor()?.document;
        if (!isSqlDocument(doc)) {
            vscode.window.showWarningMessage('DBViewer: open a SQL file to set its connection.');
            return;
        }
        const connection = await this.pickConnection(doc);
        if (!connection) { return; }
        // schema belongs to a connection, so a connection change re-picks the schema
        const schema = await this.pickSchema(connection, undefined);
        await this.bind(doc, { connection, schema });
    }

    /** Status-bar command: change only the schema, keeping the file's connection. */
    async setSchemaForActiveEditor(): Promise<void> {
        const doc = this.activeSqlEditor()?.document;
        if (!isSqlDocument(doc)) {
            vscode.window.showWarningMessage('DBViewer: open a SQL file to set its schema.');
            return;
        }
        const binding = this.forDocument(doc);
        if (!binding) {
            // no connection yet — fall back to the full flow
            await this.setConnectionForActiveEditor();
            return;
        }
        const schema = await this.pickSchema(binding.connection, binding.schema);
        await this.bind(doc, { connection: binding.connection, schema });
    }

    async bind(doc: vscode.TextDocument | undefined, binding: FileBinding): Promise<void> {
        if (!doc) { return; }
        const map = { ...this.bindings(), [doc.uri.toString()]: binding };
        await this.ctx.workspaceState.update(FILE_MAP_KEY, map);
        this.changed();
    }

    /**
     * Binds several files at once (connection only) — used when importing DBeaver's
     * per-script bindings. Returns how many were applied.
     */
    async bindFiles(entries: { file: string; connection: string }[]): Promise<number> {
        const map = { ...this.bindings() };
        let applied = 0;
        for (const { file, connection } of entries) {
            if (!this.store.has(connection)) { continue; }
            map[vscode.Uri.file(file).toString()] = { connection };
            applied++;
        }
        if (applied > 0) {
            await this.ctx.workspaceState.update(FILE_MAP_KEY, map);
            this.changed();
        }
        return applied;
    }

    /** Drops bindings for connections that no longer exist. */
    async prune(): Promise<void> {
        const kept = Object.fromEntries(
            Object.entries(this.bindings()).filter(([, b]) => this.store.has(b.connection)));
        await this.ctx.workspaceState.update(FILE_MAP_KEY, kept);
        this.changed();
    }

    private async pickConnection(doc: vscode.TextDocument | undefined): Promise<string | undefined> {
        const connections = this.store.list();
        if (connections.length === 0) {
            vscode.window.showWarningMessage('DBViewer: add a connection first (DBViewer: Add Connection).');
            return undefined;
        }
        const current = this.forDocument(doc)?.connection;
        const items = connections.map(c => ({
            label: c.name,
            description: providerInfo(c.provider).label + (c.name === current ? ' · current' : ''),
        }));
        const target = doc ? shortName(doc.uri) : 'this file';
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Run queries in ${target} on which connection?`,
            matchOnDescription: true,
        });
        return picked?.label;
    }

    /**
     * Picks a schema for the connection. The list is fetched from the server; a
     * "no default schema" choice clears it (queries then need qualified names).
     */
    private async pickSchema(connName: string, current: string | undefined): Promise<string | undefined> {
        let schemas: string[] = [];
        try {
            schemas = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `DBViewer: loading schemas for ${connName}…` },
                () => this.listSchemas(connName));
        } catch {
            // can't reach the server — let the user type one instead of blocking
            const typed = await vscode.window.showInputBox({
                prompt: `Default schema for queries on "${connName}" (optional)`,
                value: current ?? '',
            });
            return typed?.trim() || undefined;
        }
        if (schemas.length === 0) { return current; }

        const none = { label: '$(circle-slash) No default schema', description: 'use fully-qualified names', schema: undefined as string | undefined };
        const items = [
            none,
            ...schemas.map(s => ({
                label: s,
                description: s === current ? 'current' : '',
                schema: s as string | undefined,
            })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Default schema for "${connName}" (unqualified tables resolve here)`,
        });
        return picked ? picked.schema : current; // Escape keeps the current schema
    }

    private bindings(): Record<string, FileBinding> {
        const current = this.ctx.workspaceState.get<Record<string, FileBinding | string>>(FILE_MAP_KEY);
        if (current) {
            // tolerate an older shape where the value was a bare connection name
            return Object.fromEntries(Object.entries(current).map(([k, v]) =>
                [k, typeof v === 'string' ? { connection: v } : v]));
        }
        const legacy = this.ctx.workspaceState.get<Record<string, string>>(LEGACY_MAP_KEY, {});
        return Object.fromEntries(Object.entries(legacy).map(([k, v]) => [k, { connection: v }]));
    }

    private changed(): void {
        this.render();
        this._onDidChange.fire();
    }

    /**
     * Renders the connection and schema indicators for the active SQL file. Two adjacent
     * items read as "🗄 conn ▸ schema"; clicking each changes that facet. Focus moving to
     * the results webview keeps the last SQL editor's indicator rather than hiding it.
     */
    private render(): void {
        const doc = this.activeSqlEditor()?.document;
        if (!isSqlDocument(doc)) { this.connItem.hide(); this.schemaItem.hide(); return; }

        const binding = this.forDocument(doc);
        const file = shortName(doc!.uri);

        if (!binding) {
            this.connItem.text = '$(database) Select connection';
            this.connItem.tooltip = `DBViewer: no connection bound to ${file} — click to choose one`;
            this.connItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.connItem.show();
            this.schemaItem.hide();
            return;
        }

        const info = providerInfo(this.store.provider(binding.connection));
        this.connItem.text = `$(database) ${binding.connection}`;
        this.connItem.tooltip = new vscode.MarkdownString(
            `Queries in **${file}** run on **${binding.connection}** — ${info.label}.\n\nClick to change the connection.`);
        this.connItem.backgroundColor = undefined;
        this.connItem.show();

        const schemaWord = info.id === 'clickhouse' ? 'database' : 'schema';
        this.schemaItem.text = binding.schema
            ? `$(symbol-namespace) ${binding.schema}`
            : `$(symbol-namespace) no ${schemaWord}`;
        this.schemaItem.tooltip = new vscode.MarkdownString(
            binding.schema
                ? `Unqualified tables in **${file}** resolve in **${binding.schema}**.\n\nClick to change the ${schemaWord}.`
                : `No default ${schemaWord} set for **${file}** — use fully-qualified names, or click to pick one.`);
        this.schemaItem.show();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function shortName(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    return parts[parts.length - 1] || uri.toString();
}
