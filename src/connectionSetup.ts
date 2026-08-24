import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';
import { providerInfo } from './providers';
import { ConnectionContext } from './connectionContext';
import { scanDbeaver } from './dbeaverImport';

interface TestResult {
    success: boolean;
    serverVersion?: string;
    error?: { message: string };
}

/**
 * Import from DBeaver. Connection details always come across; passwords only when
 * DBeaver's credential file is readable (older releases encrypt it with a key that
 * ships inside DBeaver — newer ones do not). Connections still missing credentials
 * are handed to the connection editor dialog afterwards.
 */
export async function importFromDbeaver(
    store: ConnectionStore,
    context: ConnectionContext,
    editCredentials: (names: string[]) => void,
): Promise<boolean> {
    const scan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'PGNet: scanning DBeaver configuration...' },
        () => scanDbeaver());

    if (scan.connections.length === 0) {
        const detail = scan.sources.length === 0
            ? 'No DBeaver workspace was found in the usual locations.'
            : `Read ${scan.sources.length} config file(s) but found no PostgreSQL or ClickHouse data sources.`;
        const skippedNote = scan.skipped.length ? ` ${scan.skipped.length} data source(s) use unsupported engines.` : '';
        vscode.window.showWarningMessage(`PGNet: nothing to import. ${detail}${skippedNote}`);
        return false;
    }

    const existing = new Set(store.names());
    const items = scan.connections.map(c => ({
        label: c.name,
        description: `${providerInfo(c.provider).label} · ${c.host}:${c.port}/${c.database}`,
        detail: [
            c.password ? 'password imported' : 'no password saved',
            existing.has(c.name) ? 'overwrites an existing connection of the same name' : undefined,
        ].filter(Boolean).join(' · '),
        picked: true,
        conn: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Import which of the ${items.length} DBeaver connection(s)?`,
        matchOnDescription: true,
    });
    if (!picked || picked.length === 0) { return false; }

    for (const { conn } of picked) {
        await store.add(conn.name, conn.connectionString, conn.provider);
    }
    await importScriptBindings(context, scan, new Set(picked.map(p => p.conn.name)));

    const missing = picked.map(p => p.conn).filter(c => !c.password);
    const summary = `PGNet: imported ${picked.length} connection(s) from DBeaver.`;
    if (missing.length === 0) {
        vscode.window.showInformationMessage(summary);
        return true;
    }

    const note = scan.credentialsUnreadable
        ? `${missing.length} need credentials — this DBeaver version encrypts its password store with a key we cannot read.`
        : `${missing.length} had no saved password in DBeaver.`;
    const answer = await vscode.window.showInformationMessage(
        `${summary} ${note}`, 'Enter credentials', 'Later');
    if (answer === 'Enter credentials') {
        editCredentials(missing.map(c => c.name));
    }
    return true;
}

/**
 * Offers to carry over DBeaver's per-script connection bindings, so opening one of
 * those .sql files runs it against the same server it used in DBeaver.
 */
async function importScriptBindings(
    context: ConnectionContext, scan: Awaited<ReturnType<typeof scanDbeaver>>, imported: Set<string>,
): Promise<void> {
    const usable = scan.bindings.filter(b => imported.has(b.connection));
    if (usable.length === 0) { return; }
    const answer = await vscode.window.showInformationMessage(
        `PGNet: DBeaver also remembers a connection for ${usable.length} script file(s). Apply those too?`,
        'Apply', 'Skip');
    if (answer !== 'Apply') { return; }
    const applied = await context.bindFiles(usable);
    vscode.window.showInformationMessage(
        `PGNet: bound ${applied} script file(s) to their DBeaver connection.`);
}

/** Test Connection command: verify a stored connection and report the server version. */
export async function testConnection(client: DotNetClient, store: ConnectionStore, name?: string): Promise<void> {
    const target = name ?? await vscode.window.showQuickPick(store.names(), { placeHolder: 'Test which connection?' });
    if (!target) { return; }
    const resolved = await store.resolve(target);
    if (!resolved) {
        vscode.window.showErrorMessage(`PGNet: no stored connection string for "${target}".`);
        return;
    }
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `PGNet: testing "${target}"...` },
        () => client.request<TestResult>('TestConnection', resolved.provider, resolved.connStr));
    if (result.success) {
        vscode.window.showInformationMessage(
            `PGNet: "${target}" is reachable (${providerInfo(resolved.provider).label} ${result.serverVersion ?? ''}).`.trim());
    } else {
        vscode.window.showErrorMessage(`PGNet: "${target}" failed — ${result.error?.message}`);
    }
}
