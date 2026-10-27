import * as vscode from 'vscode';
import type { ColumnInfo, ColumnPickerFromWebview, ColumnPickerInit } from './webview/protocol';
import { webviewHtml, webviewOptions } from './webview/webviewHtml';

export type { ColumnInfo } from './webview/protocol';

/**
 * A webview dialog (React: webview-ui/columnPicker) for choosing which columns of a table
 * to show: a checkbox per column, fuzzy search and a select-all scoped to the search.
 * Resolves to the chosen column names in table order, or undefined if cancelled.
 */
export function pickColumns(
    extensionUri: vscode.Uri, title: string, columns: ColumnInfo[], selected: string[],
): Promise<string[] | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'dbviewerColumnPicker', `Columns — ${title}`,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            webviewOptions(extensionUri));

        let settled = false;
        const finish = (result: string[] | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(result);
            panel.dispose();
        };

        const chosen = new Set(selected);
        const init: ColumnPickerInit = {
            title,
            columns: columns.map(c => ({ ...c, checked: chosen.size === 0 || chosen.has(c.name) })),
        };
        panel.webview.html = webviewHtml(panel.webview, extensionUri, 'columnPicker', init);
        panel.webview.onDidReceiveMessage((msg: ColumnPickerFromWebview) => {
            if (msg.type === 'apply') {
                const checked = new Set(msg.columns);
                finish(columns.map(c => c.name).filter(n => checked.has(n)));
            } else if (msg.type === 'cancel') {
                finish(undefined);
            }
        });
        panel.onDidDispose(() => finish(undefined));
    });
}
