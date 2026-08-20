import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as rpc from 'vscode-jsonrpc/node';

/**
 * Spawns the PGNetWorker .NET process and exposes a JSON-RPC channel over its
 * stdin/stdout (Content-Length header framing, matching StreamJsonRpc's
 * HeaderDelimitedMessageHandler + SystemTextJsonFormatter).
 */
export class DotNetClient implements vscode.Disposable {
    private proc: cp.ChildProcess | undefined;
    private connection: rpc.MessageConnection | undefined;
    private readonly output: vscode.OutputChannel;

    constructor(private readonly extensionPath: string) {
        this.output = vscode.window.createOutputChannel('PGNet Worker');
    }

    async start(): Promise<void> {
        if (this.connection) { return; }

        const { command, args, cwd } = this.resolveWorker();
        this.output.appendLine(`Starting worker: ${command} ${args.join(' ')}`);
        this.proc = cp.spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

        this.proc.stderr!.on('data', (d: Buffer) => this.output.append(d.toString()));
        this.proc.on('error', (err) => {
            this.output.appendLine(`Worker failed to start: ${err.message}`);
            vscode.window.showErrorMessage(`PGNet worker failed to start: ${err.message}`);
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

    /** Prefer a published binary shipped with the extension; fall back to `dotnet run` for development. */
    private resolveWorker(): { command: string; args: string[]; cwd: string } {
        const exeName = process.platform === 'win32' ? 'PGNetWorker.exe' : 'PGNetWorker';
        const published = path.join(this.extensionPath, 'worker', 'publish', exeName);
        if (fs.existsSync(published)) {
            return { command: published, args: [], cwd: this.extensionPath };
        }
        const dll = path.join(this.extensionPath, 'worker', 'PGNetWorker', 'bin', 'Debug', 'net10.0', 'PGNetWorker.dll');
        if (fs.existsSync(dll)) {
            return { command: 'dotnet', args: [dll], cwd: this.extensionPath };
        }
        return {
            command: 'dotnet',
            args: ['run', '--project', path.join(this.extensionPath, 'worker', 'PGNetWorker')],
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
