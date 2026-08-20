import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { PgTreeViewProvider, PgNode } from './pgTreeView';
import { PgDocumentProvider, PG_SCHEME, openDefinition } from './pgDocumentProvider';
import { QueryExecutor } from './queryExecutor';
import { PgDebugConfigurationProvider, PgDebugAdapterDescriptorFactory } from './pgDebugProvider';

export function activate(context: vscode.ExtensionContext): void {
    const client = new DotNetClient(context.extensionPath);
    const store = new ConnectionStore(context);
    const tree = new PgTreeViewProvider(client, store);
    const docs = new PgDocumentProvider(client, store);
    const executor = new QueryExecutor(client, store);

    context.subscriptions.push(
        client,
        vscode.window.registerTreeDataProvider('pgnetExplorer', tree),
        vscode.workspace.registerTextDocumentContentProvider(PG_SCHEME, docs),
        vscode.debug.registerDebugConfigurationProvider('pgsql', new PgDebugConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory('pgsql',
            new PgDebugAdapterDescriptorFactory(client, store)),

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
        vscode.commands.registerCommand('pgnet.openDefinition', (node: PgNode) => openDefinition(node)),
        vscode.commands.registerCommand('pgnet.runSelectedQuery', () => executor.runFromActiveEditor()),
        vscode.commands.registerCommand('pgnet.cancelQuery', () => executor.cancel()),
        vscode.commands.registerCommand('pgnet.selectConnection', () => executor.selectConnection()),

        vscode.commands.registerCommand('pgnet.debugRoutine', async (node?: PgNode) => {
            if (!node || node.kind !== 'routine') {
                vscode.window.showWarningMessage('PGNet: pick a function/procedure in the explorer.');
                return;
            }
            const argsInput = await vscode.window.showInputBox({
                prompt: `Arguments for ${node.schema}.${node.objectName} (comma-separated SQL literals, empty for none)`,
                placeHolder: "42, 'text'",
            });
            if (argsInput === undefined) { return; }
            const args = argsInput.trim()
                ? argsInput.split(',').map(s => s.trim())
                : [];
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
