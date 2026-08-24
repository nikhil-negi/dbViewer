using Npgsql;
using DBViewerWorker.Handlers;
using StreamJsonRpc;

namespace DBViewerWorker.Debug;

public record BreakpointHit(uint FuncOid, int LineNumber, string TargetName);
public record StackFrame(int Level, string TargetName, uint FuncOid, int LineNumber, string Args);
public record DbgVariable(string Name, string VarClass, int LineNumber, bool Unique, bool IsConst,
    bool NotNull, string DType, string? Value);
public record DebugStartResult(bool Success, int SessionId, BreakpointHit? FirstStop, RpcError? Error);

/// <summary>
/// Orchestrates PL/pgSQL debugging via the pldbgapi extension.
/// Uses two connections: a target connection that runs the routine, and a
/// control connection that drives stepping through pldbg_* functions.
/// One debug session at a time per worker instance.
/// </summary>
public class DebugHandler(JsonRpc rpc)
{
    private NpgsqlConnection? _control;
    private NpgsqlConnection? _target;
    private Task? _targetTask;
    private int _session;

    public async Task<bool> CheckDebuggerInstalled(string connStr)
    {
        await using var conn = new NpgsqlConnection(connStr);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT 1 FROM pg_extension WHERE extname IN ('pldbgapi');", conn);
        return await cmd.ExecuteScalarAsync() is not null;
    }

    /// <summary>
    /// Starts a debug session: sets a global breakpoint on the routine, then
    /// invokes it on the target connection and waits for the first stop.
    /// </summary>
    public async Task<DebugStartResult> DebugStart(string connStr, uint funcOid, string invokeSql)
    {
        try
        {
            await DebugAbort(); // clean up any previous session

            _control = new NpgsqlConnection(connStr);
            await _control.OpenAsync();
            _session = Convert.ToInt32(await Scalar(_control, "SELECT pldbg_create_listener();"));
            await Scalar(_control, $"SELECT pldbg_set_global_breakpoint({_session}, {funcOid}, NULL, NULL);");

            _target = new NpgsqlConnection(connStr);
            await _target.OpenAsync();
            _target.Notice += (_, e) => _ = rpc.NotifyAsync("onDebugOutput",
                $"{e.Notice.Severity}: {e.Notice.MessageText}");

            var waitTask = Scalar(_control, $"SELECT pldbg_wait_for_target({_session});");

            // run the routine on the target connection; completion ends the session
            _targetTask = Task.Run(async () =>
            {
                try
                {
                    // multi-statement (e.g. CALL + FETCH ALL for refcursors) runs in one
                    // implicit transaction; report every result set to the debug console
                    await using var cmd = new NpgsqlCommand(invokeSql, _target) { CommandTimeout = 0 };
                    cmd.AllResultTypesAreUnknown = true;
                    await using var reader = await cmd.ExecuteReaderAsync();
                    var resultSet = 0;
                    do
                    {
                        if (reader.FieldCount == 0) continue;
                        resultSet++;
                        var cols = string.Join(" | ", Enumerable.Range(0, reader.FieldCount).Select(reader.GetName));
                        await rpc.NotifyAsync("onDebugOutput", $"--- result set {resultSet}: {cols}");
                        var rows = 0;
                        while (await reader.ReadAsync())
                        {
                            rows++;
                            if (rows <= 200)
                            {
                                var vals = string.Join(" | ", Enumerable.Range(0, reader.FieldCount)
                                    .Select(i => reader.IsDBNull(i) ? "NULL" : reader.GetString(i)));
                                await rpc.NotifyAsync("onDebugOutput", vals);
                            }
                        }
                        await rpc.NotifyAsync("onDebugOutput",
                            rows > 200 ? $"({rows} rows, first 200 shown)" : $"({rows} rows)");
                    } while (await reader.NextResultAsync());
                    if (resultSet == 0) await rpc.NotifyAsync("onDebugOutput", "Routine completed.");
                }
                catch (Exception ex)
                {
                    await rpc.NotifyAsync("onDebugOutput", $"Target error: {ex.Message}");
                }
                await rpc.NotifyAsync("onDebugTerminated");
            });

            await waitTask;
            var stop = await WaitForBreakpoint();
            return new DebugStartResult(true, _session, stop, null);
        }
        catch (PostgresException ex)
        {
            await DebugAbort();
            return new DebugStartResult(false, 0, null, new RpcError(ex.SqlState, ex.MessageText, ex.Severity));
        }
        catch (Exception ex)
        {
            await DebugAbort();
            return new DebugStartResult(false, 0, null, new RpcError("CLIENT", ex.Message, "ERROR"));
        }
    }

    public Task<BreakpointHit?> StepOver() => StepCmd("pldbg_step_over");
    public Task<BreakpointHit?> StepInto() => StepCmd("pldbg_step_into");
    public Task<BreakpointHit?> Continue() => StepCmd("pldbg_continue");

    public async Task SetBreakpoint(uint funcOid, int line) =>
        await Scalar(Control(), $"SELECT pldbg_set_breakpoint({_session}, {funcOid}, {line});");

    public async Task DropBreakpoint(uint funcOid, int line) =>
        await Scalar(Control(), $"SELECT pldbg_drop_breakpoint({_session}, {funcOid}, {line});");

    public async Task<StackFrame[]> GetStack()
    {
        try
        {
            await using var cmd = new NpgsqlCommand($"SELECT level, targetname, func::int8, linenumber, args FROM pldbg_get_stack({_session});", Control());
            var frames = new List<StackFrame>();
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                frames.Add(new StackFrame(r.GetInt32(0), r.GetString(1), (uint)r.GetInt64(2), r.GetInt32(3),
                    r.IsDBNull(4) ? "" : r.GetString(4)));
            return frames.ToArray();
        }
        catch { return []; } // session already ended
    }

    public async Task<DbgVariable[]> GetVariables()
    {
        try
        {
            await using var cmd = new NpgsqlCommand($"SELECT name, varclass, linenumber, isunique, isconst, isnotnull, dtype::regtype::text, value FROM pldbg_get_variables({_session});", Control());
            var vars = new List<DbgVariable>();
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                vars.Add(new DbgVariable(r.GetString(0), r.GetChar(1).ToString(), r.GetInt32(2), r.GetBoolean(3),
                    r.GetBoolean(4), r.GetBoolean(5), r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7)));
            return vars.ToArray();
        }
        catch { return []; } // session already ended
    }

    public async Task<string> GetSource(uint funcOid) =>
        (string?)await Scalar(Control(), $"SELECT pldbg_get_source({_session}, {funcOid});") ?? "";

    public async Task DebugAbort()
    {
        try { if (_control is not null && _session > 0) await Scalar(_control, $"SELECT pldbg_abort_target({_session});"); }
        catch { /* session may already be gone */ }
        if (_target is not null) { try { await _target.DisposeAsync(); } catch { } }
        if (_control is not null) { try { await _control.DisposeAsync(); } catch { } }
        _target = null; _control = null; _session = 0; _targetTask = null;
    }

    private async Task<BreakpointHit?> StepCmd(string fn)
    {
        try
        {
            await using var cmd = new NpgsqlCommand($"SELECT func::int8, linenumber, targetname FROM {fn}({_session});", Control());
            cmd.CommandTimeout = 0;
            var readerTask = cmd.ExecuteReaderAsync();
            // stepping past the routine's end completes the target while the control
            // call is still blocking; detect that and cancel instead of hanging forever
            var finished = await Task.WhenAny(readerTask, _targetTask ?? Task.Delay(Timeout.Infinite));
            if (finished != readerTask)
            {
                var grace = await Task.WhenAny(readerTask, Task.Delay(750));
                if (grace != readerTask)
                {
                    cmd.Cancel();
                    try { await readerTask; } catch { /* cancelled */ }
                    return null; // target finished
                }
            }
            await using var r = await readerTask;
            if (await r.ReadAsync() && !r.IsDBNull(0) && r.GetInt64(0) > 0)
                return new BreakpointHit((uint)r.GetInt64(0), r.GetInt32(1), r.IsDBNull(2) ? "" : r.GetString(2));
            return null; // target finished
        }
        catch
        {
            return null; // target completed; session closed
        }
    }

    private async Task<BreakpointHit?> WaitForBreakpoint()
    {
        await using var cmd = new NpgsqlCommand($"SELECT func::int8, linenumber, targetname FROM pldbg_wait_for_breakpoint({_session});", Control());
        cmd.CommandTimeout = 0;
        await using var r = await cmd.ExecuteReaderAsync();
        if (await r.ReadAsync() && !r.IsDBNull(0))
            return new BreakpointHit((uint)r.GetInt64(0), r.GetInt32(1), r.IsDBNull(2) ? "" : r.GetString(2));
        return null;
    }

    private NpgsqlConnection Control() =>
        _control ?? throw new InvalidOperationException("No active debug session.");

    private static async Task<object?> Scalar(NpgsqlConnection conn, string sql)
    {
        await using var cmd = new NpgsqlCommand(sql, conn) { CommandTimeout = 0 };
        return await cmd.ExecuteScalarAsync();
    }
}
