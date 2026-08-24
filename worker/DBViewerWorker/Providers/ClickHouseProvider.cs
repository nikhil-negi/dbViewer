using DBViewerWorker.Handlers;
using DBViewerWorker.Sql;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DBViewerWorker.Providers;

public class ClickHouseException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// ClickHouse over its HTTP interface — no JDBC/ODBC driver needed, and row-oriented
/// streaming falls out of JSONCompactEachRowWithNamesAndTypes: one JSON array per line.
/// Connection strings use the same key=value shape as Npgsql, e.g.
/// "Host=ch.example.com;Port=8443;Database=default;Username=ro;Password=...;Protocol=https".
/// </summary>
public sealed class ClickHouseProvider : IDbProvider
{
    private const int ChunkSize = 100;
    private const string StreamFormat = "JSONCompactEachRowWithNamesAndTypes";

    // One shared handler pools TCP sockets (and TLS sessions) across every request and
    // every ClickHouse endpoint, keyed internally by host: no per-query connect or
    // handshake once a socket is warm. Tuned for the extension's bursty pattern —
    // several catalog calls fanning out, then a streamed query.
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        // keep a healthy number of warm sockets per server for concurrent tree expansion
        MaxConnectionsPerServer = 24,
        // recycle sockets periodically so DNS/topology changes are eventually picked up
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        // but keep them idle-alive long enough to be reused between bursts
        PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
        // detect a dropped keep-alive socket before handing it to a new request
        KeepAlivePingDelay = TimeSpan.FromSeconds(30),
        KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
        EnableMultipleHttp2Connections = true,
    }) { Timeout = Timeout.InfiniteTimeSpan };

    public string Id => "clickhouse";

    private sealed record Endpoint(string Protocol, string Host, int Port, string Database, string User, string Password)
    {
        public string BaseUrl => $"{Protocol}://{Host}:{Port}/";
    }

    private static Endpoint Parse(string connStr)
    {
        var map = ConnStr.Parse(connStr);
        var protocol = ConnStr.Get(map, "http", "Protocol", "Scheme").ToLowerInvariant();
        if (protocol is not ("http" or "https")) protocol = protocol == "native" ? "http" : "http";
        var defaultPort = protocol == "https" ? 8443 : 8123;
        var port = int.TryParse(ConnStr.Get(map, "", "Port"), out var p) ? p : defaultPort;
        return new Endpoint(
            protocol,
            ConnStr.Get(map, "localhost", "Host", "Server"),
            port,
            ConnStr.Get(map, "default", "Database", "Db"),
            ConnStr.Get(map, "default", "Username", "User", "Uid"),
            ConnStr.Get(map, "", "Password", "Pwd"));
    }

    // ---------- transport ----------

    private static async Task<HttpResponseMessage> Send(
        Endpoint ep, string sql, string? queryId, string? format, CancellationToken ct)
    {
        var url = new StringBuilder(ep.BaseUrl)
            .Append("?database=").Append(Uri.EscapeDataString(ep.Database));
        if (format is not null) url.Append("&default_format=").Append(format);
        if (queryId is not null) url.Append("&query_id=").Append(Uri.EscapeDataString(queryId));

        using var req = new HttpRequestMessage(HttpMethod.Post, url.ToString())
        {
            Content = new StringContent(sql, Encoding.UTF8),
        };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("text/plain") { CharSet = "utf-8" };
        req.Headers.TryAddWithoutValidation("X-ClickHouse-User", ep.User);
        if (ep.Password.Length > 0) req.Headers.TryAddWithoutValidation("X-ClickHouse-Key", ep.Password);

        var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (resp.IsSuccessStatusCode) return resp;

        var body = await resp.Content.ReadAsStringAsync(ct);
        resp.Dispose();
        throw ToException(resp, body);
    }

    private static ClickHouseException ToException(HttpResponseMessage resp, string body)
    {
        var code = resp.Headers.TryGetValues("X-ClickHouse-Exception-Code", out var v)
            ? v.FirstOrDefault() ?? ((int)resp.StatusCode).ToString()
            : ((int)resp.StatusCode).ToString();
        // "Code: 62. DB::Exception: Syntax error ... (SYNTAX_ERROR) (version 24.1)"
        var message = body.Trim();
        var marker = message.IndexOf("DB::Exception:", StringComparison.Ordinal);
        if (marker >= 0) message = message[(marker + "DB::Exception:".Length)..].Trim();
        if (message.Length == 0) message = $"HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}";
        return new ClickHouseException(code, message);
    }

    /// <summary>Runs a catalog query and materialises it; rows come back as strings.</summary>
    private static async Task<List<string?[]>> Rows(Endpoint ep, string sql, CancellationToken ct = default)
    {
        using var resp = await Send(ep, sql, null, "JSONCompactEachRow", ct);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var rows = new List<string?[]>();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            using var doc = JsonDocument.Parse(line);
            // JSONCompactEachRow emits one array per row; tolerate a bare scalar
            // so an unexpected shape surfaces as data rather than a parser crash
            rows.Add(doc.RootElement.ValueKind == JsonValueKind.Array
                ? doc.RootElement.EnumerateArray().Select(Scalar).ToArray()
                : [Scalar(doc.RootElement)]);
        }
        return rows;
    }

    private static string? Scalar(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => e.GetString(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => e.GetRawText(),
    };

    /// <summary>Reads a cell by position, tolerating a shorter row than expected.</summary>
    private static string Col(string?[] row, int i) => i < row.Length ? row[i] ?? "" : "";

    /// <summary>First cell of the first row, or null when the result is empty.</summary>
    private static string? FirstCell(List<string?[]> rows) =>
        rows.Count > 0 && rows[0].Length > 0 ? rows[0][0] : null;

    private static string Lit(string value) => $"'{value.Replace("\\", "\\\\").Replace("'", "\\'")}'";
    private static string Ident(string name) => $"`{name.Replace("`", "\\`")}`";

    /// <summary>Object kinds that ClickHouse reports through table engines rather than a catalog view.</summary>
    private const string IsViewExpr = "engine IN ('View','MaterializedView','LiveView','WindowView')";

    // ---------- connectivity ----------

    public async Task<TestConnectionResult> TestConnection(string connStr)
    {
        try
        {
            var rows = await Rows(Parse(connStr), "SELECT version()");
            return new TestConnectionResult(true, FirstCell(rows) ?? "unknown", null);
        }
        catch (Exception ex)
        {
            return new TestConnectionResult(false, null, MapError(ex) ?? new RpcError("CLIENT", ex.Message, "ERROR"));
        }
    }

    public async Task<string[]> ListDatabases(string connStr)
    {
        var rows = await Rows(Parse(connStr), "SELECT name FROM system.databases ORDER BY name");
        return rows.Select(r => Col(r, 0)).ToArray();
    }

    // ---------- catalog ----------

    public async Task<SchemaNode[]> GetSchemas(string connStr)
    {
        var rows = await Rows(Parse(connStr), """
            SELECT name FROM system.databases
            WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema')
            ORDER BY name
            """);
        return rows.Select(r => new SchemaNode(Col(r, 0))).ToArray();
    }

    public async Task<TableNode[]> GetTables(string connStr, string schema)
    {
        var rows = await Rows(Parse(connStr), $"""
            SELECT name, engine FROM system.tables
            WHERE database = {Lit(schema)} AND NOT {IsViewExpr}
            ORDER BY name
            """);
        return rows.Select(r => new TableNode(schema, Col(r, 0), "table")).ToArray();
    }

    public async Task<TableNode[]> GetViews(string connStr, string schema)
    {
        var rows = await Rows(Parse(connStr), $"""
            SELECT name FROM system.tables
            WHERE database = {Lit(schema)} AND {IsViewExpr}
            ORDER BY name
            """);
        return rows.Select(r => new TableNode(schema, Col(r, 0), "view")).ToArray();
    }

    /// <summary>
    /// ClickHouse user-defined functions are cluster-wide rather than per-database, so the
    /// same set appears under every database. Built-in functions are excluded.
    /// </summary>
    public async Task<RoutineNode[]> GetRoutines(string connStr, string schema)
    {
        var rows = await Rows(Parse(connStr), """
            SELECT name, origin FROM system.functions
            WHERE origin != 'System'
            ORDER BY name
            """);
        return rows
            .Select(r => new RoutineNode(schema, Col(r, 0), Col(r, 1).ToLowerInvariant(), 0, ""))
            .ToArray();
    }

    /// <summary>ClickHouse has no user-defined named types; the folder is not shown for it.</summary>
    public Task<TypeNode[]> GetTypes(string connStr, string schema) => Task.FromResult(Array.Empty<TypeNode>());

    public async Task<ColumnInfo[]> GetColumns(string connStr, string schema, string table)
    {
        var rows = await Rows(Parse(connStr), $"""
            SELECT name, type FROM system.columns
            WHERE database = {Lit(schema)} AND table = {Lit(table)}
            ORDER BY position
            """);
        return rows.Select(r => new ColumnInfo(Col(r, 0), Col(r, 1))).ToArray();
    }

    public Task<string> GetTableDefinition(string connStr, string schema, string name) =>
        ShowCreate(connStr, schema, name);

    public Task<string> GetViewDefinition(string connStr, string schema, string name) =>
        ShowCreate(connStr, schema, name);

    private static async Task<string> ShowCreate(string connStr, string schema, string name)
    {
        var rows = await Rows(Parse(connStr), $"SHOW CREATE TABLE {Ident(schema)}.{Ident(name)}");
        var ddl = FirstCell(rows);
        return string.IsNullOrEmpty(ddl) ? $"-- no definition for {schema}.{name}" : ddl + "\n";
    }

    public async Task<string> GetRoutineDefinition(string connStr, string schema, string name, uint oid)
    {
        var rows = await Rows(Parse(connStr),
            $"SELECT create_query FROM system.functions WHERE name = {Lit(name)}");
        var ddl = FirstCell(rows);
        return string.IsNullOrEmpty(ddl) ? $"-- {name} is a built-in function (no DDL)" : ddl + "\n";
    }

    public Task<string> GetTypeDefinition(string connStr, string schema, string name) =>
        Task.FromResult("-- ClickHouse has no user-defined named types");

    public async Task<CompletionCatalog> GetCompletionCatalog(string connStr)
    {
        var ep = Parse(connStr);
        var schemas = (await Rows(ep, """
            SELECT name FROM system.databases
            WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema')
            """)).Select(r => Col(r, 0)).ToArray();

        var objects = (await Rows(ep, $"""
            SELECT database, name, if({IsViewExpr}, 'view', 'table') FROM system.tables
            WHERE database NOT IN ('INFORMATION_SCHEMA','information_schema')
            UNION ALL
            SELECT '', name, 'function' FROM system.functions
            """)).Select(r => new CompletionObject(Col(r, 0), Col(r, 1), Col(r, 2))).ToArray();

        var columns = (await Rows(ep, """
            SELECT database, table, name, type FROM system.columns
            WHERE database NOT IN ('INFORMATION_SCHEMA','information_schema')
            """)).Select(r => new CompletionColumn(Col(r, 0), Col(r, 1), Col(r, 2), Col(r, 3))).ToArray();

        return new CompletionCatalog(schemas, objects, columns);
    }

    // ---------- execution ----------

    public async Task<long> ExecuteStream(
        string connStr, string sql, string queryId, IQuerySink sink, CancellationToken ct)
    {
        var ep = Parse(connStr);
        // the HTTP interface takes one statement per request
        var statements = SqlSplitter.Split(sql);
        long rowCount = 0;
        for (var i = 0; i < statements.Count; i++)
        {
            // a distinct query_id per statement keeps KILL QUERY targeted
            var id = statements.Count > 1 ? $"{queryId}-{i + 1}" : queryId;
            rowCount += await ExecuteOne(ep, statements[i], id, sink, ct);
        }
        return rowCount;
    }

    private static async Task<long> ExecuteOne(
        Endpoint ep, string sql, string queryId, IQuerySink sink, CancellationToken ct)
    {
        using var resp = await Send(ep, sql, queryId, StreamFormat, ct);
        var summary = resp.Headers.TryGetValues("X-ClickHouse-Summary", out var s) ? s.FirstOrDefault() : null;

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        string[]? names = null;
        ColumnInfo[]? columns = null;
        long rowCount = 0;
        var chunk = new List<object?[]>(ChunkSize);

        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            using var doc = JsonDocument.Parse(line);
            var cells = doc.RootElement;

            if (names is null)                       // line 1: column names
            {
                names = cells.EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
                continue;
            }
            if (columns is null)                     // line 2: column types
            {
                var types = cells.EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
                columns = names.Select((n, i) => new ColumnInfo(n, i < types.Length ? types[i] : "")).ToArray();
                await sink.Columns(columns);
                continue;
            }

            rowCount++;
            chunk.Add(cells.EnumerateArray().Select(Cell).ToArray());
            if (chunk.Count >= ChunkSize)
            {
                await sink.Rows(chunk);
                chunk = new List<object?[]>(ChunkSize);
            }
        }
        if (chunk.Count > 0) await sink.Rows(chunk);

        // statements with no result set (DDL, INSERT) send an empty body; report what the server did
        if (names is null)
        {
            await sink.Notice(summary is null
                ? "Statement executed."
                : $"Statement executed. {summary}");
        }
        return rowCount;
    }

    private static object? Cell(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => e.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => e.GetRawText(),   // keep full precision; the grid renders strings
        _ => e.GetRawText(),                      // arrays, tuples, maps, nested
    };

    /// <summary>
    /// Aborting the HTTP request does not always stop the server, so ask ClickHouse to
    /// kill anything tagged with this request's query_id (including split statements).
    /// </summary>
    public async Task KillQuery(string connStr, string queryId)
    {
        try
        {
            await Rows(Parse(connStr),
                $"KILL QUERY WHERE query_id = {Lit(queryId)} OR query_id LIKE {Lit(queryId + "-%")} ASYNC");
        }
        catch (Exception)
        {
            // the user may lack KILL QUERY rights; the aborted socket is still the primary cancel
        }
    }

    public RpcError? MapError(Exception ex) => ex switch
    {
        ClickHouseException ch => new RpcError(ch.Code, ch.Message, "ERROR"),
        HttpRequestException http => new RpcError("CONNECTION", http.Message, "ERROR"),
        _ => null,
    };
}
