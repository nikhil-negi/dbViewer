import * as vscode from 'vscode';

/** Handles 'export' messages from grid webviews: prompts for a location and writes the file. */
export async function handleExportMessage(msg: {
    format: 'csv' | 'sql'; content: string; name: string;
}): Promise<void> {
    const safe = msg.name.replace(/[^\w.]+/g, '_');
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'),
            `${safe}.${msg.format}`),
        filters: msg.format === 'csv' ? { CSV: ['csv'] } : { SQL: ['sql'] },
    });
    if (!uri) { return; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.content, 'utf8'));
    vscode.window.showInformationMessage(`PGNet: exported to ${uri.fsPath}`);
}
