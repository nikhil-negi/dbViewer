import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { WebviewEntry } from './protocol';

/** Where esbuild.mjs writes the webview bundles, relative to the extension root. */
const BUNDLE_DIR = ['out', 'webview-ui'];

/** Panel options for a React webview: scripts on, and only the bundle folder readable. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...BUNDLE_DIR)],
    };
}

/**
 * The HTML shell for a React webview: a root element, the entry's bundled CSS and JS, and
 * an optional `init` payload the app reads synchronously on startup (as inert JSON, so it
 * needs no inline script). The CSP allows only the bundle itself.
 */
export function webviewHtml(
    webview: vscode.Webview, extensionUri: vscode.Uri, entry: WebviewEntry, init?: unknown,
): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...BUNDLE_DIR, file));
    // "<" escaped so a value containing "</script>" cannot end the JSON block early
    const initJson = JSON.stringify(init ?? null).replace(/</g, '\\u003c');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset(`${entry}.css`)}">
</head>
<body>
<div id="root"></div>
<script id="init" type="application/json">${initJson}</script>
<script nonce="${nonce}" src="${asset(`${entry}.js`)}"></script>
</body>
</html>`;
}
