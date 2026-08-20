import * as vscode from 'vscode';
import { DotNetClient } from './dotnetClient';
import { ConnectionStore } from './connections';

interface BreakpointHit { funcOid: number; lineNumber: number; targetName: string; }
interface DbgStackFrame { level: number; targetName: string; funcOid: number; lineNumber: number; args: string; }
interface DbgVariable { name: string; varClass: string; dType: string; value: string | null; }
interface DebugStartResult {
    success: boolean; sessionId: number; firstStop: BreakpointHit | null;
    error?: { code: string; message: string } | null;
}

export class PgDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.DebugConfiguration | undefined {
        if (!config.type) {
            config.type = 'pgsql';
            config.request = 'launch';
            config.name = 'Debug PL/pgSQL routine';
        }
        if (!config.connection || !config.routine) {
            vscode.window.showErrorMessage(
                'PGNet debug configuration needs "connection" and "routine" (e.g. public.my_func).');
            return undefined;
        }
        return config;
    }
}

export class PgDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly client: DotNetClient, private readonly store: ConnectionStore) {}

    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
        return new vscode.DebugAdapterInlineImplementation(
            new PgDebugAdapter(this.client, this.store, session.configuration));
    }
}

/**
 * Inline Debug Adapter: speaks DAP to VS Code and delegates every operation to
 * the .NET worker's pldbgapi client over JSON-RPC.
 */
class PgDebugAdapter implements vscode.DebugAdapter {
    private readonly _onDidSend = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._onDidSend.event;

    private seq = 1000;
    private funcOid = 0;
    private sourceCache = new Map<number, string>(); // funcOid -> source
    private pendingBreakpointLines: number[] = [];
    private lastVars: DbgVariable[] = [];
    private started = false;

    constructor(
        private readonly client: DotNetClient,
        private readonly store: ConnectionStore,
        private readonly config: vscode.DebugConfiguration,
    ) {
        client.onNotification('onDebugOutput', (msg: string) =>
            this.event('output', { category: 'console', output: msg + '\n'}));
        client.onNotification('onDebugTerminated', () => {
            if (this.started) { this.event('terminated', {}); }
        });
    }

    handleMessage(message: any): void {
        if (message.type === 'request') {
            this.dispatch(message).catch((e) => {
                this.respond(message, false, undefined, e?.message ?? String(e));
            });
        }
    }

    private async dispatch(req: any): Promise<void> {
        switch (req.command) {
            case 'initialize':
                this.respond(req, true, {
                    supportsConfigurationDoneRequest: true,
                    supportsTerminateRequest: true,
                });
                this.event('initialized', {});
                break;

            case 'setBreakpoints': {
                const lines: number[] = (req.arguments.breakpoints ?? []).map((b: any) => b.line);
                this.pendingBreakpointLines = lines;
                if (this.started && this.funcOid) {
                    for (const line of lines) {
                        try { await this.client.request('SetBreakpoint', this.funcOid, line); } catch { /* dup */ }
                    }
                }
                this.respond(req, true, {
                    breakpoints: lines.map(l => ({ verified: true, line: l })),
                });
                break;
            }

            case 'configurationDone':
                this.respond(req, true);
                break;

            case 'launch': {
                this.respond(req, true);
                await this.launch();
                break;
            }

            case 'threads':
                this.respond(req, true, { threads: [{ id: 1, name: 'PL/pgSQL session' }] });
                break;

            case 'stackTrace': {
                const frames = await this.client.request<DbgStackFrame[]>('GetStack');
                const stackFrames = await Promise.all(frames.map(async f => ({
                    id: f.level,
                    name: f.targetName || `oid ${f.funcOid}`,
                    line: f.lineNumber,
                    column: 1,
                    source: {
                        name: `${f.targetName || f.funcOid}.plpgsql`,
                        sourceReference: f.funcOid,
                    },
                })));
                this.respond(req, true, { stackFrames, totalFrames: stackFrames.length });
                break;
            }

            case 'source': {
                const oid = req.arguments.source?.sourceReference ?? req.arguments.sourceReference;
                let src = this.sourceCache.get(oid);
                if (!src) {
                    src = await this.client.request<string>('GetSource', oid);
                    this.sourceCache.set(oid, src);
                }
                this.respond(req, true, { content: src, mimeType: 'text/x-sql' });
                break;
            }

            case 'scopes':
                this.respond(req, true, {
                    scopes: [{ name: 'Locals', variablesReference: 1, expensive: false }],
                });
                break;

            case 'variables': {
                this.lastVars = await this.client.request<DbgVariable[]>('GetVariables');
                this.respond(req, true, {
                    variables: this.lastVars.map(v => ({
                        name: v.name,
                        value: v.value ?? 'NULL',
                        type: v.dType,
                        variablesReference: 0,
                    })),
                });
                break;
            }

            case 'next':      await this.step(req, 'StepOver'); break;
            case 'stepIn':    await this.step(req, 'StepInto'); break;
            case 'continue':  await this.step(req, 'Continue'); break;

            case 'evaluate': {
                const v = this.lastVars.find(x => x.name === req.arguments.expression.trim());
                if (v) { this.respond(req, true, { result: v.value ?? 'NULL', variablesReference: 0 }); }
                else { this.respond(req, false, undefined, 'Only local variable names can be evaluated.'); }
                break;
            }

            case 'terminate':
            case 'disconnect':
                await this.client.request('DebugAbort').catch(() => undefined);
                this.started = false;
                this.respond(req, true);
                this.event('terminated', {});
                break;

            default:
                this.respond(req, true);
        }
    }

    private async launch(): Promise<void> {
        const connStr = await this.store.get(this.config.connection);
        if (!connStr) {
            this.fail(`Unknown connection "${this.config.connection}". Add it in the PGNet explorer.`);
            return;
        }
        const installed = await this.client.request<boolean>('CheckDebuggerInstalled', connStr);
        if (!installed) {
            this.fail('The pldbgapi extension is not installed on the server. Run: CREATE EXTENSION pldbgapi;');
            return;
        }

        const [schema, name] = String(this.config.routine).split('.');
        if (!name) { this.fail('routine must be schema-qualified, e.g. public.my_func'); return; }

        const routines = await this.client.request<{ name: string; kind: string; oid: number }[]>(
            'GetRoutines', connStr, schema);
        const match = routines.find(r => r.name === name);
        if (!match) { this.fail(`Routine ${this.config.routine} not found.`); return; }
        this.funcOid = match.oid;

        const args = (this.config.args ?? []).join(', ');
        const invokeSql = match.kind === 'procedure'
            ? `CALL ${schema}.${name}(${args});`
            : `SELECT * FROM ${schema}.${name}(${args});`;

        this.event('output', { category: 'console', output: `Debugging: ${invokeSql}\n` });
        const result = await this.client.request<DebugStartResult>('DebugStart', connStr, this.funcOid, invokeSql);
        if (!result.success) {
            this.fail(`Failed to start debug session: ${result.error?.message}`);
            return;
        }
        this.started = true;

        for (const line of this.pendingBreakpointLines) {
            try { await this.client.request('SetBreakpoint', this.funcOid, line); } catch { /* ignore */ }
        }

        if (result.firstStop) {
            this.event('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
        } else {
            this.event('terminated', {});
        }
    }

    private async step(req: any, method: string): Promise<void> {
        this.respond(req, true);
        const hit = await this.client.request<BreakpointHit | null>(method);
        if (hit && hit.funcOid) {
            this.event('stopped', {
                reason: method === 'Continue' ? 'breakpoint' : 'step',
                threadId: 1, allThreadsStopped: true,
            });
        } else {
            this.started = false;
            this.event('terminated', {});
        }
    }

    private fail(message: string): void {
        this.event('output', { category: 'stderr', output: message + '\n' });
        vscode.window.showErrorMessage(`PGNet: ${message}`);
        this.event('terminated', {});
    }

    private respond(req: any, success: boolean, body?: unknown, message?: string): void {
        this._onDidSend.fire({
            type: 'response', seq: this.seq++, request_seq: req.seq,
            command: req.command, success, body, message,
        } as vscode.DebugProtocolMessage);
    }

    private event(event: string, body: unknown): void {
        this._onDidSend.fire({ type: 'event', seq: this.seq++, event, body } as vscode.DebugProtocolMessage);
    }

    dispose(): void {
        void this.client.request('DebugAbort').catch(() => undefined);
    }
}
