using PGNetWorker.Handlers;
using System.Text;

namespace PGNetWorker.Providers;

public record SchemaNode(string Name);
public record TableNode(string Schema, string Name, string Kind);   // Kind: table | view
public record RoutineNode(string Schema, string Name, string Kind, uint Oid, string Arguments);
public record TypeNode(string Schema, string Name, string Kind, uint Oid);
public record ColumnInfo(string Name, string Type);

public record CompletionObject(string Schema, string Name, string Kind);
public record CompletionColumn(string Schema, string Table, string Name, string Type);
public record CompletionCatalog(string[] Schemas, CompletionObject[] Objects, CompletionColumn[] Columns);

/// <summary>Receives a streamed result set. One call to Columns per result set, then Rows in chunks.</summary>
public interface IQuerySink
{
    Task Columns(ColumnInfo[] columns);
    Task Rows(IReadOnlyList<object?[]> rows);
    Task Notice(string message);
}

/// <summary>
/// Everything the extension needs from one database engine. Connection strings are
/// always semicolon-delimited key=value (Npgsql style) so both providers, and the
/// DBeaver importer, speak the same dialect.
/// </summary>
public interface IDbProvider
{
    string Id { get; }

    Task<TestConnectionResult> TestConnection(string connStr);
    Task<string[]> ListDatabases(string connStr);

    Task<SchemaNode[]> GetSchemas(string connStr);
    Task<TableNode[]> GetTables(string connStr, string schema);
    Task<TableNode[]> GetViews(string connStr, string schema);
    Task<RoutineNode[]> GetRoutines(string connStr, string schema);
    Task<TypeNode[]> GetTypes(string connStr, string schema);
    /// <summary>Columns of one table/view, in declaration order — for the column selector.</summary>
    Task<ColumnInfo[]> GetColumns(string connStr, string schema, string table);

    Task<string> GetTableDefinition(string connStr, string schema, string name);
    Task<string> GetViewDefinition(string connStr, string schema, string name);
    Task<string> GetRoutineDefinition(string connStr, string schema, string name, uint oid);
    Task<string> GetTypeDefinition(string connStr, string schema, string name);

    Task<CompletionCatalog> GetCompletionCatalog(string connStr);

    /// <summary>Runs sql, pushing results into the sink. Returns the total row count.</summary>
    Task<long> ExecuteStream(string connStr, string sql, string queryId, IQuerySink sink, CancellationToken ct);

    /// <summary>Best-effort server-side cancel; the HTTP/socket abort is handled by the caller.</summary>
    Task KillQuery(string connStr, string queryId);

    /// <summary>Provider-specific error shaping, or null to fall back to a generic client error.</summary>
    RpcError? MapError(Exception ex);
}

public static class ProviderRegistry
{
    private static readonly PostgresProvider Postgres = new();
    private static readonly ClickHouseProvider ClickHouse = new();

    /// <summary>Resolves a provider id; unknown/empty ids mean postgres, which is what pre-provider settings imply.</summary>
    public static IDbProvider For(string? provider) => (provider ?? "").ToLowerInvariant() switch
    {
        "clickhouse" => ClickHouse,
        _ => Postgres,
    };
}

/// <summary>
/// Parses a semicolon-delimited key=value connection string, ignoring key case.
/// Values may be quoted (Npgsql convention) so a password can contain ';' or '=';
/// a doubled quote inside a quoted value is a literal quote.
/// </summary>
public static class ConnStr
{
    public static Dictionary<string, string> Parse(string connStr)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var i = 0;
        while (i < connStr.Length)
        {
            var eq = connStr.IndexOf('=', i);
            if (eq < 0) break;
            var key = connStr[i..eq].Trim();
            i = eq + 1;
            while (i < connStr.Length && connStr[i] == ' ') i++;

            string value;
            if (i < connStr.Length && (connStr[i] == '"' || connStr[i] == '\''))
            {
                var quote = connStr[i++];
                var sb = new StringBuilder();
                while (i < connStr.Length)
                {
                    if (connStr[i] == quote)
                    {
                        if (i + 1 < connStr.Length && connStr[i + 1] == quote) { sb.Append(quote); i += 2; continue; }
                        i++;
                        break;
                    }
                    sb.Append(connStr[i++]);
                }
                value = sb.ToString();
                var semi = connStr.IndexOf(';', i);
                i = semi < 0 ? connStr.Length : semi + 1;
            }
            else
            {
                var semi = connStr.IndexOf(';', i);
                var end = semi < 0 ? connStr.Length : semi;
                value = connStr[i..end].Trim();
                i = semi < 0 ? connStr.Length : semi + 1;
            }
            if (key.Length > 0) map[key] = value;
        }
        return map;
    }

    public static string Get(Dictionary<string, string> map, string fallback, params string[] keys)
    {
        foreach (var k in keys)
            if (map.TryGetValue(k, out var v) && v.Length > 0) return v;
        return fallback;
    }
}
