using System.Diagnostics;
using Npgsql;
using StreamJsonRpc;

namespace PGNetWorker.Handlers;

public record QueryComplete(string RequestId, bool Success, long RowCount, long ElapsedMs, RpcError? Error);

public class QueryHandler(JsonRpc rpc)
{
    private const int ChunkSize = 100;
    private readonly Dictionary<string, CancellationTokenSource> _running = new();

    /// <summary>
    /// Streams results back via notifications: onColumns, onDataChunk, onNotice, onQueryComplete.
    /// Never buffers the whole result set.
    /// </summary>
    public async Task ExecuteQueryStream(string connStr, string sqlQuery, string requestId)
    {
        var cts = new CancellationTokenSource();
        lock (_running) _running[requestId] = cts;
        var sw = Stopwatch.StartNew();
        long rowCount = 0;
        try
        {
            await using var conn = new NpgsqlConnection(connStr);
            conn.Notice += (_, e) => _ = rpc.NotifyAsync("onNotice", requestId,
                $"{e.Notice.Severity}: {e.Notice.MessageText}");
            await conn.OpenAsync(cts.Token);

            await using var cmd = new NpgsqlCommand(sqlQuery, conn) { CommandTimeout = 0 };
            // fetch every column as text: supports custom types (domains, composites, enums)
            // that Npgsql has no .NET mapping for; the grid displays strings anyway
            cmd.AllResultTypesAreUnknown = true;
            await using var reader = await cmd.ExecuteReaderAsync(cts.Token);

            do
            {
                if (reader.FieldCount > 0)
                {
                    var columns = Enumerable.Range(0, reader.FieldCount)
                        .Select(i => new { name = reader.GetName(i), type = reader.GetDataTypeName(i) })
                        .ToArray();
                    await rpc.NotifyAsync("onColumns", requestId, columns);

                    var chunk = new List<object?[]>(ChunkSize);
                    while (await reader.ReadAsync(cts.Token))
                    {
                        rowCount++;
                        var row = new object?[reader.FieldCount];
                        for (var i = 0; i < reader.FieldCount; i++)
                        {
                            var v = reader.GetValue(i);
                            row[i] = v is DBNull ? null : v is string or bool || v.GetType().IsPrimitive ? v : v.ToString();
                        }
                        chunk.Add(row);
                        if (chunk.Count >= ChunkSize)
                        {
                            await rpc.NotifyAsync("onDataChunk", requestId, chunk);
                            chunk.Clear();
                        }
                    }
                    if (chunk.Count > 0) await rpc.NotifyAsync("onDataChunk", requestId, chunk);
                }
                else if (reader.RecordsAffected >= 0)
                {
                    rowCount += reader.RecordsAffected;
                }
            } while (await reader.NextResultAsync(cts.Token));

            await rpc.NotifyAsync("onQueryComplete",
                new QueryComplete(requestId, true, rowCount, sw.ElapsedMilliseconds, null));
        }
        catch (PostgresException ex)
        {
            await rpc.NotifyAsync("onQueryComplete", new QueryComplete(requestId, false, rowCount,
                sw.ElapsedMilliseconds, new RpcError(ex.SqlState, $"{ex.MessageText} (line {ex.Line})", ex.Severity)));
        }
        catch (OperationCanceledException)
        {
            await rpc.NotifyAsync("onQueryComplete", new QueryComplete(requestId, false, rowCount,
                sw.ElapsedMilliseconds, new RpcError("CANCELLED", "Query cancelled by user.", "NOTICE")));
        }
        catch (Exception ex)
        {
            await rpc.NotifyAsync("onQueryComplete", new QueryComplete(requestId, false, rowCount,
                sw.ElapsedMilliseconds, new RpcError("CLIENT", ex.Message, "ERROR")));
        }
        finally
        {
            lock (_running) _running.Remove(requestId);
        }
    }

    public void CancelQuery(string requestId)
    {
        lock (_running)
            if (_running.TryGetValue(requestId, out var cts)) cts.Cancel();
    }
}
