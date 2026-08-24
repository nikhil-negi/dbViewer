import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as rpc from 'vscode-jsonrpc/node';

/** File modification time in epoch ms, or null when the file does not exist. */
function mtimeOrNull(file: string): number | null {
    try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Spawns the DBViewerWorker .NET process and exposes a JSON-RPC channel over its
 * stdin/stdout (Content-Length header framing, matching StreamJsonRpc's
 * HeaderDelimitedMessageHandler + SystemTextJsonFormatter).
 */
export class DotNetClient implements vscode.Disposable {
    private proc: cp.ChildProcess | undefined;
    private connection: rpc.MessageConnection | undefined;
    private readonly output: vscode.OutputChannel;

    constructor(private readonly extensionPath: string) {
        this.output = vscode.window.createOutputChannel('DBViewer Worker');
    }

    async start(): Promise<void> {
        if (this.connection) { return; }

        const { command, args, cwd } = this.resolveWorker();
        this.output.appendLine(`Starting worker: ${command} ${args.join(' ')}`);
        this.proc = cp.spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

        this.proc.stderr!.on('data', (d: Buffer) => this.output.append(d.toString()));
        this.proc.on('error', (err) => {
            this.output.appendLine(`Worker failed to start: ${err.message}`);
            vscode.window.showErrorMessage(`DBViewer worker failed to start: ${err.message}`);
        });
        this.proc.on('exit', (code) => {
            this.output.appendLine(`Worker exited with code ${code}`);
            this.connection = undefined;
            this.proc = undefined;
        });

        this.connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(this.proc.stdout!),
            new rpc.StreamMessageWriter(this.proc.stdin!)
        );
        this.connection.onError((e) => this.output.appendLine(`RPC error: ${e}`));
        this.connection.listen();
    }

    /**
     * Picks the worker binary to launch. A published build ships with the packaged
     * extension; a Debug build exists during development. When both are present we take
     * whichever was built more recently — otherwise a stale `worker/publish/` (e.g. from
     * an earlier packaging) silently shadows a freshly rebuilt Debug binary, and the
     * running worker's RPC signatures no longer match what the extension sends. Falls
     * back to `dotnet run` when neither binary is on disk.
     */
    private resolveWorker(): { command: string; args: string[]; cwd: string } {
        const exeName = process.platform === 'win32' ? 'DBViewerWorker.exe' : 'DBViewerWorker';
        const published = path.join(this.extensionPath, 'worker', 'publish', exeName);
        const dll = path.join(this.extensionPath, 'worker', 'DBViewerWorker', 'bin', 'Debug', 'net10.0', 'DBViewerWorker.dll');

        const publishedTime = mtimeOrNull(published);
        const dllTime = mtimeOrNull(dll);

        if (publishedTime !== null && (dllTime === null || publishedTime >= dllTime)) {
            this.output.appendLine(`Using published worker (built ${new Date(publishedTime).toISOString()}).`);
            return { command: published, args: [], cwd: this.extensionPath };
        }
        if (dllTime !== null) {
            if (publishedTime !== null) {
                this.output.appendLine('Debug worker is newer than the published one; using Debug build.');
            }
            return { command: 'dotnet', args: [dll], cwd: this.extensionPath };
        }
        return {
            command: 'dotnet',
            args: ['run', '--project', path.join(this.extensionPath, 'worker', 'DBViewerWorker')],
            cwd: this.extensionPath,
        };
    }

    async request<T>(method: string, ...params: unknown[]): Promise<T> {
        await this.start();
        return this.connection!.sendRequest<T>(method, ...params) as Promise<T>;
    }

    /** Fire-and-forget request for long-running server work that reports back via notifications. */
    async requestNoWait(method: string, ...params: unknown[]): Promise<void> {
        await this.start();
        void this.connection!.sendRequest(method, ...params).then(undefined, (e) =>
            this.output.appendLine(`${method} failed: ${e?.message ?? e}`));
    }

    onNotification(method: string, handler: (...args: any[]) => void): void {
        void this.start().then(() => this.connection!.onNotification(method, handler));
    }

    dispose(): void {
        this.connection?.dispose();
        if (this.proc) {
            this.proc.stdin?.end(); // worker exits when stdin closes
            const proc = this.proc;
            setTimeout(() => { if (!proc.killed) { proc.kill(); } }, 2000);
        }
        this.output.dispose();
    }
}
