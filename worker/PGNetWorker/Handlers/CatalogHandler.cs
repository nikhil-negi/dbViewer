using Npgsql;
using System.Text;

namespace PGNetWorker.Handlers;

public record SchemaNode(string Name);
public record TableNode(string Schema, string Name, string Kind); // Kind: table | view
public record RoutineNode(string Schema, string Name, string Kind, uint Oid, string Arguments); // Kind: function | procedure

public class CatalogHandler
{
    public async Task<SchemaNode[]> GetSchemas(string connStr)
    {
        await using var conn = await Open(connStr);
        const string sql = """
            SELECT schema_name FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog','information_schema')
              AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
            ORDER BY schema_name;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        var list = new List<SchemaNode>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new SchemaNode(r.GetString(0)));
        return list.ToArray();
    }

    public async Task<TableNode[]> GetTables(string connStr, string schema)
    {
        await using var conn = await Open(connStr);
        const string sql = """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = @schema AND table_type = 'BASE TABLE'
            ORDER BY table_name;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("schema", schema);
        var list = new List<TableNode>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new TableNode(schema, r.GetString(0), "table"));
        return list.ToArray();
    }

    public async Task<TableNode[]> GetViews(string connStr, string schema)
    {
        await using var conn = await Open(connStr);
        const string sql = """
            SELECT table_name FROM information_schema.views
            WHERE table_schema = @schema ORDER BY table_name;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("schema", schema);
        var list = new List<TableNode>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new TableNode(schema, r.GetString(0), "view"));
        return list.ToArray();
    }

    public async Task<RoutineNode[]> GetRoutines(string connStr, string schema)
    {
        await using var conn = await Open(connStr);
        const string sql = """
            SELECT p.proname,
                   CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
                   p.oid::int8,
                   pg_get_function_identity_arguments(p.oid)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = @schema AND p.prokind IN ('f','p')
            ORDER BY p.proname;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("schema", schema);
        var list = new List<RoutineNode>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync())
            list.Add(new RoutineNode(schema, r.GetString(0), r.GetString(1), (uint)r.GetInt64(2), r.GetString(3)));
        return list.ToArray();
    }

    public async Task<string> GetRoutineDefinition(string connStr, uint oid)
    {
        await using var conn = await Open(connStr);
        await using var cmd = new NpgsqlCommand("SELECT pg_get_functiondef(@oid::oid);", conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        return (string?)await cmd.ExecuteScalarAsync() ?? "-- definition not available";
    }

    public async Task<string> GetViewDefinition(string connStr, string schema, string name)
    {
        await using var conn = await Open(connStr);
        await using var cmd = new NpgsqlCommand(
            "SELECT pg_get_viewdef((quote_ident(@s) || '.' || quote_ident(@n))::regclass, true);", conn);
        cmd.Parameters.AddWithValue("s", schema);
        cmd.Parameters.AddWithValue("n", name);
        var body = (string?)await cmd.ExecuteScalarAsync() ?? "";
        return $"CREATE OR REPLACE VIEW {schema}.{name} AS\n{body}";
    }

    public async Task<string> GetTableDefinition(string connStr, string schema, string name)
    {
        await using var conn = await Open(connStr);
        const string colSql = """
            SELECT column_name, data_type,
                   COALESCE(character_maximum_length::text, ''),
                   is_nullable, COALESCE(column_default, '')
            FROM information_schema.columns
            WHERE table_schema = @s AND table_name = @n
            ORDER BY ordinal_position;
            """;
        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE {schema}.{name} (");
        var cols = new List<string>();
        await using (var cmd = new NpgsqlCommand(colSql, conn))
        {
            cmd.Parameters.AddWithValue("s", schema);
            cmd.Parameters.AddWithValue("n", name);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
            {
                var type = r.GetString(1);
                var len = r.GetString(2);
                if (len.Length > 0 && type is "character varying" or "character") type += $"({len})";
                var line = $"    {r.GetString(0)} {type}";
                if (r.GetString(4).Length > 0) line += $" DEFAULT {r.GetString(4)}";
                if (r.GetString(3) == "NO") line += " NOT NULL";
                cols.Add(line);
            }
        }

        // primary key
        await using (var cmd = new NpgsqlCommand("""
            SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
            FROM pg_constraint c
            JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE c.contype = 'p'
              AND c.conrelid = (quote_ident(@s) || '.' || quote_ident(@n))::regclass;
            """, conn))
        {
            cmd.Parameters.AddWithValue("s", schema);
            cmd.Parameters.AddWithValue("n", name);
            var pk = await cmd.ExecuteScalarAsync() as string;
            if (!string.IsNullOrEmpty(pk)) cols.Add($"    PRIMARY KEY ({pk})");
        }

        sb.AppendLine(string.Join(",\n", cols));
        sb.AppendLine(");");
        return sb.ToString();
    }

    private static async Task<NpgsqlConnection> Open(string connStr)
    {
        var conn = new NpgsqlConnection(connStr);
        await conn.OpenAsync();
        return conn;
    }
}
