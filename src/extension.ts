import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { ConnectionContext } from './connectionContext';
import { PgTreeViewProvider, PgNode } from './pgTreeView';
import { PgDocumentProvider, PG_SCHEME, openDefinition } from './pgDocumentProvider';
import { QueryExecutor } from './queryExecutor';
import { QueryChannel } from './queryChannel';
import { TableViewer } from './tableViewer';
import { PgDebugConfigurationProvider, PgDebugAdapterDescriptorFactory } from './pgDebugProvider';
import { parseRoutineArgs, buildInvokeSql, userArgs } from './routineUtils';
import { PgCompletionProvider } from './sqlCompletion';
import { providerInfo } from './providers';
import { ColumnPreferences } from './columnPreferences';
import { importFromDbeaver, testConnection } from './connectionSetup';
import { ConnectionEditor } from './connectionEditor';

/**
 * Prompts for a SQL literal per user-suppliable argument (refcursor and OUT
 * args are handled automatically). Returns undefined if the user cancels.
 */
async function promptRoutineArgs(node: PgNode): Promise<string[] | undefined> {
    const args = userArgs(parseRoutineArgs(node.routineArgs ?? ''));
    const literals: string[] = [];
    for (const a of args) {
        const v = await vscode.window.showInputBox({
            prompt: `${node.schema}.${node.objectName} — value for ${a.name || '(unnamed)'} (${a.type}) as a SQL literal`,
            placeHolder: /char|text|uuid|date|time|json/i.test(a.type) ? "'value'" : 'value, or NULL',
        });
        if (v === undefined) { return undefined; }
        literals.push(v.trim() === '' ? 'NULL' : v.trim());
    }
    return literals;
}

/** Routine actions only apply to engines that can invoke a routine by name. */
function requireRunnableRoutine(node?: PgNode): node is PgNode {
    if (!node || node.kind !== 'routine') {
        vscode.window.showWarningMessage('DBViewer: pick a function/procedure in the explorer.');
        return false;
    }
    if (!providerInfo(node.provider).supportsRunRoutine) {
        vscode.window.showWarningMessage(
            `DBViewer: running routines is not supported for ${providerInfo(node.provider).label}.`);
        return false;
    }
    return true;
}

/**
 * Registers a command, tolerating the id already being taken. That happens when a
 * second copy of this extension is loaded (a stale VSIX install alongside the
 * development build): without this, the first collision would abort activate() and
 * leave every later command unregistered — which looks like "command not found".
 */
function registerCommand(
    context: vscode.ExtensionContext, collisions: string[],
    id: string, handler: (...args: any[]) => any,
): void {
    try {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    } catch {
        collisions.push(id);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const client = new DotNetClient(context.extensionPath);
    const store = new ConnectionStore(context);
    const connectionContext = new ConnectionContext(context, store,
        async (connName: string) => {
            const resolved = await store.resolve(connName);
            if (!resolved) { return []; }
            const schemas = await client.request<{ name: string }[]>('GetSchemas', resolved.provider, resolved.connStr);
            return schemas.map(s => s.name);
        });
    const tree = new PgTreeViewProvider(client, store);
    const docs = new PgDocumentProvider(client, store);
    const channel = new QueryChannel(client);
    const executor = new QueryExecutor(store, channel, connectionContext);
    const columnPrefs = new ColumnPreferences(context);
    const tableViewer = new TableViewer(client, store, channel, columnPrefs);
    const editor = new ConnectionEditor(client, store, () => tree.refresh());

    const treeView = vscode.window.createTreeView('dbExplorer', {
        treeDataProvider: tree, showCollapseAll: true,
    });
    // reflect the live filter text in the view header so type-to-filter is visible
    tree.onDidChangeFilterText((text: string) => {
        treeView.message = text.trim()
            ? `Filtering: ${text}  —  type to refine, Backspace to edit, Esc to clear`
            : undefined;
    });
    treeView.onDidChangeSelection(e => tree.setActiveConnection(e.selection[0]?.connName));

    context.subscriptions.push(
        client,
        connectionContext,
        treeView,
        vscode.workspace.registerTextDocumentContentProvider(PG_SCHEME, docs),
        vscode.debug.registerDebugConfigurationProvider('pgsql', new PgDebugConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory('pgsql',
            new PgDebugAdapterDescriptorFactory(client, store)),
        vscode.languages.registerCompletionItemProvider(
            [{ language: 'sql' }, { scheme: 'pg-schema' }],
            new PgCompletionProvider(client, store, doc => connectionContext.forDocument(doc)?.connection),
            '.'),
    );

    const collisions: string[] = [];
    const command = (id: string, handler: (...args: any[]) => any) =>
        registerCommand(context, collisions, id, handler);

    command('dbviewer.connect', () => editor.openAdd());

    command('dbviewer.importDbeaver', async () => {
        if (await importFromDbeaver(store, connectionContext, names => editor.openEditQueue(names))) {
            tree.refresh();
        }
    });

    command('dbviewer.editCredentials', async (node?: PgNode) => {
        const name = node?.connName ??
            await vscode.window.showQuickPick(store.names(), { placeHolder: 'Edit which connection?' });
        if (name) { editor.openEdit(name); }
    });

    command('dbviewer.testConnection', (node?: PgNode) =>
        testConnection(client, store, node?.connName));

    command('dbviewer.removeConnection', async (node?: PgNode) => {
        const name = node?.connName ??
            await vscode.window.showQuickPick(store.names(), { placeHolder: 'Remove which connection?' });
        if (!name) { return; }
        await store.remove(name);
        await connectionContext.prune();
        tree.refresh();
    });

    command('dbviewer.refresh', () => tree.refresh());

    // live tree filter: an input box that filters the explorer as you type
    command('dbviewer.filterExplorer', () => {
        const input = vscode.window.createInputBox();
        input.title = 'Filter Explorer';
        input.placeholder = 'Type to filter tables, views, routines, types, schemas (fuzzy)…';
        input.value = tree.filterText();
        input.onDidChangeValue(v => tree.setFilter(v));
        input.onDidAccept(() => input.hide());
        input.onDidHide(() => input.dispose());
        input.show();
    });
    command('dbviewer.clearFilter', () => tree.setFilter(''));
    // type-to-filter: the character keybindings (see package.json) drive these
    command('dbviewer.filterType', (ch?: string) => { if (typeof ch === 'string') { tree.appendToFilter(ch); } });
    command('dbviewer.filterBackspace', () => tree.backspaceFilter());
    command('dbviewer.openDefinition', (node: PgNode) =>
        node.kind === 'routine' ? openDefinition(node) : tableViewer.open(node));
    command('dbviewer.runSelectedQuery', () => executor.runFromActiveEditor());
    command('dbviewer.cancelQuery', () => executor.cancel());

    // connection context: per-file connection + schema shown in the status bar
    command('dbviewer.setFileConnection', () => connectionContext.setConnectionForActiveEditor());
    command('dbviewer.setFileSchema', () => connectionContext.setSchemaForActiveEditor());
    command('dbviewer.selectConnection', () => connectionContext.setConnectionForActiveEditor());
    command('dbviewer.useConnectionForFile', async (node?: PgNode) => {
        const doc = connectionContext.activeSqlEditor()?.document;
        if (!node || !doc) {
            vscode.window.showWarningMessage('DBViewer: open a SQL file first.');
            return;
        }
        await connectionContext.bind(doc, { connection: node.connName });
        vscode.window.showInformationMessage(`DBViewer: this file now runs on "${node.connName}".`);
    });

    command('dbviewer.runRoutine', async (node?: PgNode) => {
        if (!requireRunnableRoutine(node)) { return; }
        const literals = await promptRoutineArgs(node);
        if (literals === undefined) { return; }
        const parsed = parseRoutineArgs(node.routineArgs ?? '');
        const { sql } = buildInvokeSql(
            node.routineKind ?? 'function', node.schema!, node.objectName!, parsed, literals);
        await executor.runSql(sql, node.connName);
    });

    command('dbviewer.debugRoutine', async (node?: PgNode) => {
        if (!requireRunnableRoutine(node)) { return; }
        if (!providerInfo(node.provider).supportsDebug) {
            vscode.window.showWarningMessage(
                'DBViewer: debugging is only available for PostgreSQL connections.');
            return;
        }
        const args = await promptRoutineArgs(node);
        if (args === undefined) { return; }
        await vscode.debug.startDebugging(undefined, {
            type: 'pgsql',
            request: 'launch',
            name: `Debug ${node.schema}.${node.objectName}`,
            connection: node.connName,
            routine: `${node.schema}.${node.objectName}`,
            args,
        });
    });

    if (collisions.length > 0) { warnAboutDuplicateInstall(collisions); }
}

/**
 * Every command id we own is already taken, so a second copy of DBViewer is loaded —
 * almost always a VSIX installed from an earlier build sitting alongside the
 * development build. Both copies contribute view buttons, and whichever registered
 * first handles the clicks, so commands added since that build appear "not found".
 */
function warnAboutDuplicateInstall(collisions: string[]): void {
    const id = 'nikhil.dbviewer';
    vscode.window.showWarningMessage(
        `DBViewer: ${collisions.length} command(s) were already registered by another copy of this ` +
        'extension, so this copy is only partly active. Uninstall the duplicate and reload.',
        'Show installed extension', 'Copy uninstall command',
    ).then(choice => {
        if (choice === 'Show installed extension') {
            void vscode.commands.executeCommand('workbench.extensions.search', `@installed ${id}`);
        } else if (choice === 'Copy uninstall command') {
            void vscode.env.clipboard.writeText(`code --uninstall-extension ${id}`);
        }
    });
}

export function deactivate(): void {
    // DotNetClient is disposed via context.subscriptions; the worker exits when stdin closes.
}
