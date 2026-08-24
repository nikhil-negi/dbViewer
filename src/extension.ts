import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { PgTreeViewProvider, PgNode } from './pgTreeView';
import { PgDocumentProvider, PG_SCHEME, openDefinition } from './pgDocumentProvider';
import { QueryExecutor } from './queryExecutor';
import { QueryChannel } from './queryChannel';
import { TableViewer } from './tableViewer';
import { PgDebugConfigurationProvider, PgDebugAdapterDescriptorFactory } from './pgDebugProvider';
import { parseRoutineArgs, buildInvokeSql, userArgs } from './routineUtils';
import { PgCompletionProvider } from './sqlCompletion';

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

export function activate(context: vscode.ExtensionContext): void {
    const client = new DotNetClient(context.extensionPath);
    const store = new ConnectionStore(context);
    const tree = new PgTreeViewProvider(client, store);
    const docs = new PgDocumentProvider(client, store);
    const channel = new QueryChannel(client);
    const executor = new QueryExecutor(store, channel);
    const tableViewer = new TableViewer(client, store, channel);

    context.subscriptions.push(
        client,
        vscode.window.registerTreeDataProvider('pgnetExplorer', tree),
        vscode.workspace.registerTextDocumentContentProvider(PG_SCHEME, docs),
        vscode.debug.registerDebugConfigurationProvider('pgsql', new PgDebugConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory('pgsql',
            new PgDebugAdapterDescriptorFactory(client, store)),
        vscode.languages.registerCompletionItemProvider(
            [{ language: 'sql' }, { scheme: 'pg-schema' }],
            new PgCompletionProvider(client, store, () => executor.getActiveConnection()),
            '.'),

        vscode.commands.registerCommand('pgnet.connect', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Connection name', placeHolder: 'local-dev',
                validateInput: v => v.trim() ? undefined : 'Name is required',
            });
            if (!name) { return; }
            const connStr = await vscode.window.showInputBox({
                prompt: 'Npgsql connection string',
                placeHolder: 'Host=localhost;Port=5432;Database=mydb;Username=postgres;Password=...',
                password: true,
            });
            if (!connStr) { return; }
            const result = await client.request<{ success: boolean; error?: { message: string } }>(
                'TestConnection', connStr);
            if (!result.success) {
                vscode.window.showErrorMessage(`PGNet: connection failed — ${result.error?.message}`);
                return;
            }
            await store.add(name.trim(), connStr);
            tree.refresh();
            vscode.window.showInformationMessage(`PGNet: connection "${name}" added.`);
        }),

        vscode.commands.registerCommand('pgnet.removeConnection', async (node?: PgNode) => {
            const name = node?.connName ??
                await vscode.window.showQuickPick(store.names(), { placeHolder: 'Remove which connection?' });
            if (!name) { return; }
            await store.remove(name);
            tree.refresh();
        }),

        vscode.commands.registerCommand('pgnet.refresh', () => tree.refresh()),
        vscode.commands.registerCommand('pgnet.openDefinition', (node: PgNode) =>
            node.kind === 'table' || node.kind === 'view' ? tableViewer.open(node) : openDefinition(node)),
        vscode.commands.registerCommand('pgnet.runSelectedQuery', () => executor.runFromActiveEditor()),
        vscode.commands.registerCommand('pgnet.cancelQuery', () => executor.cancel()),
        vscode.commands.registerCommand('pgnet.selectConnection', () => executor.selectConnection()),

        vscode.commands.registerCommand('pgnet.runRoutine', async (node?: PgNode) => {
            if (!node || node.kind !== 'routine') {
                vscode.window.showWarningMessage('PGNet: pick a function/procedure in the explorer.');
                return;
            }
            const literals = await promptRoutineArgs(node);
            if (literals === undefined) { return; }
            const parsed = parseRoutineArgs(node.routineArgs ?? '');
            const { sql } = buildInvokeSql(
                node.routineKind ?? 'function', node.schema!, node.objectName!, parsed, literals);
            await executor.runSql(sql, node.connName);
        }),

        vscode.commands.registerCommand('pgnet.debugRoutine', async (node?: PgNode) => {
            if (!node || node.kind !== 'routine') {
                vscode.window.showWarningMessage('PGNet: pick a function/procedure in the explorer.');
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
        }),
    );
}

export function deactivate(): void {
    // DotNetClient is disposed via context.subscriptions; the worker exits when stdin closes.
}
