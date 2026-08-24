using DBViewerWorker.Providers;
using StreamJsonRpc;
using System.Diagnostics;

namespace DBViewerWorker.Handlers;

public record QueryComplete(string RequestId, bool Success, long RowCount, long ElapsedMs, RpcError? Error);

public class QueryHandler(JsonRpc rpc)
{
    private readonly Dictionary<string, Running> _running = new();

    private sealed record Running(CancellationTokenSource Cts, IDbProvider Provider, string ConnStr, string QueryId);

    /// <summary>Forwards a provider's streamed results as notifications for one request id.</summary>
    private sealed class RpcSink(JsonRpc rpc, string requestId) : IQuerySink
    {
        public Task Columns(ColumnInfo[] columns) => rpc.NotifyAsync("onColumns", requestId, columns);
        public Task Rows(IReadOnlyList<object?[]> rows) => rpc.NotifyAsync("onDataChunk", requestId, rows);
        public Task Notice(string message) => rpc.NotifyAsync("onNotice", requestId, message);
    }

    /// <summary>
    /// Streams results back via notifications: onColumns, onDataChunk, onNotice, onQueryComplete.
    /// Never buffers the whole result set.
    /// </summary>
    public async Task ExecuteQueryStream(string provider, string connStr, string sqlQuery, string requestId)
    {
        var db = ProviderRegistry.For(provider);
        var cts = new CancellationTokenSource();
        // unique per worker process so a KILL QUERY cannot hit another session's ids
        var queryId = $"pgnet-{Environment.ProcessId}-{requestId}";
        lock (_running) _running[requestId] = new Running(cts, db, connStr, queryId);

        var sw = Stopwatch.StartNew();
        long rowCount = 0;
        try
        {
            rowCount = await db.ExecuteStream(connStr, sqlQuery, queryId, new RpcSink(rpc, requestId), cts.Token);
            await rpc.NotifyAsync("onQueryComplete",
                new QueryComplete(requestId, true, rowCount, sw.ElapsedMilliseconds, null));
        }
        catch (OperationCanceledException)
        {
            await rpc.NotifyAsync("onQueryComplete", new QueryComplete(requestId, false, rowCount,
                sw.ElapsedMilliseconds, new RpcError("CANCELLED", "Query cancelled by user.", "NOTICE")));
        }
        catch (Exception ex)
        {
            await rpc.NotifyAsync("onQueryComplete", new QueryComplete(requestId, false, rowCount,
                sw.ElapsedMilliseconds,
                db.MapError(ex) ?? new RpcError("CLIENT", ex.Message, "ERROR")));
        }
        finally
        {
            lock (_running) _running.Remove(requestId);
        }
    }

    public async Task CancelQuery(string requestId)
    {
        Running? running;
        lock (_running) _running.TryGetValue(requestId, out running);
        if (running is null) return;
        running.Cts.Cancel();
        await running.Provider.KillQuery(running.ConnStr, running.QueryId);
    }
}
