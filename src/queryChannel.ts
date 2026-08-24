import { DotNetClient } from './dotnetClient';

export interface QueryComplete {
    requestId: string;
    success: boolean;
    rowCount: number;
    elapsedMs: number;
    error?: { code: string; message: string; severity: string } | null;
}

export interface QuerySink {
    onColumns(columns: unknown): void;
    onRows(rows: unknown[]): void;
    onNotice(message: string): void;
    onComplete(result: QueryComplete): void;
}

/**
 * Single owner of the worker's query notifications; routes each event to the
 * sink that issued the requestId (vscode-jsonrpc allows only one handler per
 * notification method, and we have multiple panels).
 */
export class QueryChannel {
    private readonly sinks = new Map<string, QuerySink>();
    private seq = 0;

    constructor(private readonly client: DotNetClient) {
        client.onNotification('onColumns', (id: string, columns: unknown) =>
            this.sinks.get(id)?.onColumns(columns));
        client.onNotification('onDataChunk', (id: string, rows: unknown[]) =>
            this.sinks.get(id)?.onRows(rows));
        client.onNotification('onNotice', (id: string, message: string) =>
            this.sinks.get(id)?.onNotice(message));
        client.onNotification('onQueryComplete', (result: QueryComplete) =>
            this.sinks.get(result.requestId)?.onComplete(result));
    }

    newRequestId(prefix: string): string {
        return `${prefix}${++this.seq}`;
    }

    async run(
        provider: string, connStr: string, sql: string, requestId: string, sink: QuerySink,
    ): Promise<void> {
        this.sinks.set(requestId, sink);
        await this.client.requestNoWait('ExecuteQueryStream', provider, connStr, sql, requestId);
    }

    release(requestId: string): void {
        this.sinks.delete(requestId);
    }

    cancel(requestId: string): Promise<unknown> {
        return this.client.request('CancelQuery', requestId);
    }
}
