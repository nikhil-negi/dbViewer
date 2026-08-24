import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { providerInfo } from './providers';

const FILE_MAP_KEY = 'pgnet.fileConnections';
const DEFAULT_KEY = 'pgnet.defaultConnection';

/** Documents that run SQL, and so have a connection context. */
function isSqlDocument(doc: vscode.TextDocument | undefined): boolean {
    return !!doc && (doc.languageId === 'sql' || doc.uri.scheme === 'pg-schema');
}

/**
 * A DDL document opened from the explorer already names its connection, so queries
 * run inside it belong to that server rather than to the workspace default.
 */
function connectionFromUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'pg-schema') { return undefined; }
    return new URLSearchParams(uri.query).get('conn') ?? uri.authority ?? undefined;
}

/**
 * Remembers which connection each SQL file runs against, so several servers can be
 * open at once without the "which database am I on?" guessing game. The binding is
 * per document URI and persists in workspace state; files with no binding of their
 * own fall back to the workspace default (the last connection explicitly chosen).
 */
export class ConnectionContext implements vscode.Disposable {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    /** Keeps the indicator alive while focus sits in the results webview. */
    private lastSqlDoc: vscode.TextDocument | undefined;

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly store: ConnectionStore,
    ) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'pgnet.setFileConnection';
        this.statusBar.name = 'PGNet Connection';
        this.disposables.push(
            this.statusBar,
            this._onDidChange,
            vscode.window.onDidChangeActiveTextEditor(() => this.render()),
            vscode.workspace.onDidOpenTextDocument(() => this.render()),
        );
        this.render();
    }

    /** The connection a document's queries run on, or undefined if nothing is bound yet. */
    forDocument(doc: vscode.TextDocument | undefined): string | undefined {
        const own = this.explicitFor(doc);
        const name = own ?? this.defaultConnection();
        return name && this.store.has(name) ? name : undefined;
    }

    /** Whether the document has a connection of its own rather than inheriting the default. */
    isExplicit(doc: vscode.TextDocument | undefined): boolean {
        return this.explicitFor(doc) !== undefined;
    }

    private explicitFor(doc: vscode.TextDocument | undefined): string | undefined {
        if (!doc) { return undefined; }
        const bound = this.bindings()[doc.uri.toString()] ?? connectionFromUri(doc.uri);
        return bound && this.store.has(bound) ? bound : undefined;
    }

    defaultConnection(): string | undefined {
        const name = this.ctx.workspaceState.get<string>(DEFAULT_KEY);
        return name && this.store.has(name) ? name : undefined;
    }

    /**
     * Returns the document's connection, asking the user once if it has none.
     * The answer is remembered for that document.
     */
    async ensureForDocument(doc: vscode.TextDocument | undefined): Promise<string | undefined> {
        const existing = this.forDocument(doc);
        if (existing) { return existing; }

        const names = this.store.names();
        if (names.length === 0) {
            vscode.window.showWarningMessage('PGNet: add a connection first (PGNet: Add Connection).');
            return undefined;
        }
        const picked = names.length === 1 ? names[0] : await this.promptFor(doc);
        if (!picked) { return undefined; }
        await this.bind(doc, picked);
        return picked;
    }

    /** Status-bar / command entry point: rebind the active SQL editor. */
    async setForActiveEditor(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document ?? this.lastSqlDoc;
        if (!isSqlDocument(doc)) {
            await this.setDefault();
            return;
        }
        const picked = await this.promptFor(doc);
        if (picked) { await this.bind(doc!, picked); }
    }

    /** Sets the fallback used by files with no binding of their own. */
    async setDefault(): Promise<void> {
        const picked = await this.promptFor(undefined);
        if (!picked) { return; }
        await this.ctx.workspaceState.update(DEFAULT_KEY, picked);
        this.changed();
    }

    async bind(doc: vscode.TextDocument | undefined, connName: string): Promise<void> {
        if (doc) {
            await this.ctx.workspaceState.update(FILE_MAP_KEY, {
                ...this.bindings(),
                [doc.uri.toString()]: connName,
            });
        }
        // the most recent explicit choice also becomes the default for unbound files
        await this.ctx.workspaceState.update(DEFAULT_KEY, connName);
        this.changed();
    }

    /**
     * Binds several files at once without touching the workspace default — used when
     * importing DBeaver's own per-script bindings. Returns how many were applied.
     */
    async bindFiles(entries: { file: string; connection: string }[]): Promise<number> {
        const map = { ...this.bindings() };
        let applied = 0;
        for (const { file, connection } of entries) {
            if (!this.store.has(connection)) { continue; }
            map[vscode.Uri.file(file).toString()] = connection;
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
            Object.entries(this.bindings()).filter(([, name]) => this.store.has(name)));
        await this.ctx.workspaceState.update(FILE_MAP_KEY, kept);
        this.changed();
    }

    private async promptFor(doc: vscode.TextDocument | undefined): Promise<string | undefined> {
        const connections = this.store.list();
        if (connections.length === 0) {
            vscode.window.showWarningMessage('PGNet: add a connection first (PGNet: Add Connection).');
            return undefined;
        }
        const current = this.forDocument(doc);
        const items = connections.map(c => ({
            label: c.name,
            description: providerInfo(c.provider).label + (c.name === current ? ' · current' : ''),
        }));
        const target = doc ? shortName(doc.uri) : 'files without their own connection';
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Run queries in ${target} on which connection?`,
            matchOnDescription: true,
        });
        return picked?.label;
    }

    private bindings(): Record<string, string> {
        return this.ctx.workspaceState.get<Record<string, string>>(FILE_MAP_KEY, {});
    }

    private changed(): void {
        this.render();
        this._onDidChange.fire();
    }

    /**
     * Shows the active file's connection in the status bar. Inherited bindings are
     * marked so it is obvious when a file is only following the default. Focus moving
     * to a webview (the results grid) leaves no active text editor, so the last SQL
     * document keeps the indicator rather than making it flicker away.
     */
    private render(): void {
        const active = vscode.window.activeTextEditor?.document;
        if (active) { this.lastSqlDoc = isSqlDocument(active) ? active : undefined; }
        const doc = active ?? this.lastSqlDoc;
        if (!isSqlDocument(doc)) { this.statusBar.hide(); return; }

        const name = this.forDocument(doc);
        if (!name) {
            this.statusBar.text = '$(database) Select connection';
            this.statusBar.tooltip = 'PGNet: no connection bound to this file — click to choose one';
            this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBar.show();
            return;
        }
        const info = providerInfo(this.store.provider(name));
        const inherited = !this.isExplicit(doc);
        this.statusBar.text = `$(database) ${name}${inherited ? ' (default)' : ''}`;
        this.statusBar.tooltip = new vscode.MarkdownString(
            [
                `**${name}** — ${info.label}`,
                '',
                inherited
                    ? `${shortName(doc!.uri)} has no connection of its own and follows the workspace default.`
                    : `Queries in ${shortName(doc!.uri)} run on **${name}**.`,
                '',
                'Click to bind this file to a different connection.',
            ].join('\n'));
        this.statusBar.backgroundColor = undefined;
        this.statusBar.show();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function shortName(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    return parts[parts.length - 1] || uri.toString();
}
