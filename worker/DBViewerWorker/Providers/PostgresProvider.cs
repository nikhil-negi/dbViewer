using Npgsql;
using PGNetWorker.Handlers;
using System.Text;

namespace PGNetWorker.Providers;

/// <summary>PostgreSQL over Npgsql. The reference implementation; supports PL/pgSQL debugging.</summary>
public sealed class PostgresProvider : IDbProvider
{
    private const int ChunkSize = 100;

    public string Id => "postgres";

    /// <summary>
    /// Restricts pg_type to types worth showing: skips the implicit row types of
    /// tables/views, the auto-generated array and multirange types, and pseudo-types.
    /// Expects the pg_type alias to be `t`.
    /// </summary>
    private const string UserTypeFilter = """
              AND t.typtype IN ('b','c','d','e','r')
              AND (t.typrelid = 0
                   OR (SELECT c2.relkind FROM pg_class c2 WHERE c2.oid = t.typrelid) = 'c')
              AND NOT EXISTS (SELECT 1 FROM pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)
        """;

    private const string TypeKindExpr = """
        CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite'
                       WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' ELSE 'base' END
        """;

    public async Task<TestConnectionResult> TestConnection(string connStr)
    {
        try
        {
            await using var conn = await Open(connStr);
            await using var cmd = new NpgsqlCommand("SELECT 1;", conn);
            await cmd.ExecuteScalarAsync();
            return new TestConnectionResult(true, conn.PostgreSqlVersion.ToString(), null);
        }
        catch (Exception ex)
        {
            return new TestConnectionResult(false, null, MapError(ex) ?? new RpcError("CLIENT", ex.Message, "ERROR"));
        }
    }

    public async Task<string[]> ListDatabases(string connStr)
    {
        await using var conn = await Open(connStr);
        await using var cmd = new NpgsqlCommand(
            "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname;", conn);
        var result = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync()) result.Add(reader.GetString(0));
        return result.ToArray();
    }

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

    /// <summary>User-defined data types (enum, composite, domain, range, base) in a schema.</summary>
    public async Task<TypeNode[]> GetTypes(string connStr, string schema)
    {
        await using var conn = await Open(connStr);
        var sql = $"""
            SELECT t.typname, {TypeKindExpr}, t.oid::int8
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = @schema
            {UserTypeFilter}
            ORDER BY t.typname;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("schema", schema);
        var list = new List<TypeNode>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync())
            list.Add(new TypeNode(schema, r.GetString(0), r.GetString(1), (uint)r.GetInt64(2)));
        return list.ToArray();
    }

    public async Task<ColumnInfo[]> GetColumns(string connStr, string schema, string table)
    {
        await using var conn = await Open(connStr);
        const string sql = """
            SELECT column_name,
                   CASE WHEN character_maximum_length IS NOT NULL
                        THEN data_type || '(' || character_maximum_length || ')'
                        ELSE data_type END
            FROM information_schema.columns
            WHERE table_schema = @s AND table_name = @t
            ORDER BY ordinal_position;
            """;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("s", schema);
        cmd.Parameters.AddWithValue("t", table);
        var list = new List<ColumnInfo>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new ColumnInfo(r.GetString(0), r.GetString(1)));
        return list.ToArray();
    }

    public async Task<string> GetRoutineDefinition(string connStr, string schema, string name, uint oid)
    {
        await using var conn = await Open(connStr);
        // filtered/search results carry no oid, so fall back to resolving it by name;
        // ambiguous overloads resolve to the first by oid, which is good enough for a preview
        if (oid == 0)
        {
            await using var resolve = new NpgsqlCommand("""
                SELECT p.oid::int8 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = @s AND p.proname = @n ORDER BY p.oid LIMIT 1;
                """, conn);
            resolve.Parameters.AddWithValue("s", schema);
            resolve.Parameters.AddWithValue("n", name);
            if (await resolve.ExecuteScalarAsync() is long resolved) oid = (uint)resolved;
            else return $"-- routine {schema}.{name} not found";
        }
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

    /// <summary>
    /// Reconstructs CREATE TYPE / CREATE DOMAIN DDL for a user-defined type.
    /// Postgres has no pg_get_typedef(), so each type kind is rebuilt from the catalogs.
    /// </summary>
    public async Task<string> GetTypeDefinition(string connStr, string schema, string name)
    {
        await using var conn = await Open(connStr);

        uint oid;
        string kind;
        await using (var cmd = new NpgsqlCommand($"""
            SELECT t.oid::int8, {TypeKindExpr}
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = @s AND t.typname = @n;
            """, conn))
        {
            cmd.Parameters.AddWithValue("s", schema);
            cmd.Parameters.AddWithValue("n", name);
            await using var r = await cmd.ExecuteReaderAsync();
            if (!await r.ReadAsync()) return $"-- type {schema}.{name} not found";
            oid = (uint)r.GetInt64(0);
            kind = r.GetString(1);
        }

        var qualified = $"{Quote(schema)}.{Quote(name)}";
        var ddl = kind switch
        {
            "enum" => await EnumDdl(conn, oid, qualified),
            "composite" => await CompositeDdl(conn, oid, qualified),
            "domain" => await DomainDdl(conn, oid, qualified),
            "range" => await RangeDdl(conn, oid, qualified),
            _ => await BaseTypeDdl(conn, oid, qualified),
        };

        var comment = await Scalar(conn, "SELECT COALESCE(obj_description(@oid::oid, 'pg_type'), '');", oid);
        if (comment.Length > 0)
        {
            var keyword = kind == "domain" ? "DOMAIN" : "TYPE";
            ddl += $"\n\nCOMMENT ON {keyword} {qualified} IS {Literal(comment)};\n";
        }
        return ddl;
    }

    private static async Task<string> EnumDdl(NpgsqlConnection conn, uint oid, string qualified)
    {
        var labels = new List<string>();
        await using var cmd = new NpgsqlCommand(
            "SELECT enumlabel FROM pg_enum WHERE enumtypid = @oid::oid ORDER BY enumsortorder;", conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) labels.Add("    " + Literal(r.GetString(0)));
        return $"CREATE TYPE {qualified} AS ENUM (\n{string.Join(",\n", labels)}\n);\n";
    }

    private static async Task<string> CompositeDdl(NpgsqlConnection conn, uint oid, string qualified)
    {
        var attrs = new List<string>();
        await using var cmd = new NpgsqlCommand("""
            SELECT a.attname, format_type(a.atttypid, a.atttypmod),
                   COALESCE((SELECT co.collname FROM pg_collation co
                             WHERE co.oid = a.attcollation AND co.collname <> 'default'), '')
            FROM pg_attribute a
            WHERE a.attrelid = (SELECT typrelid FROM pg_type WHERE oid = @oid::oid)
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum;
            """, conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync())
        {
            var line = $"    {Quote(r.GetString(0))} {r.GetString(1)}";
            if (r.GetString(2).Length > 0) line += $" COLLATE {Quote(r.GetString(2))}";
            attrs.Add(line);
        }
        return $"CREATE TYPE {qualified} AS (\n{string.Join(",\n", attrs)}\n);\n";
    }

    private static async Task<string> DomainDdl(NpgsqlConnection conn, uint oid, string qualified)
    {
        var sb = new StringBuilder();
        await using (var cmd = new NpgsqlCommand("""
            SELECT format_type(t.typbasetype, t.typtypmod), t.typnotnull, COALESCE(t.typdefault, ''),
                   COALESCE((SELECT co.collname FROM pg_collation co
                             WHERE co.oid = t.typcollation AND co.collname <> 'default'), '')
            FROM pg_type t WHERE t.oid = @oid::oid;
            """, conn))
        {
            cmd.Parameters.AddWithValue("oid", (long)oid);
            await using var r = await cmd.ExecuteReaderAsync();
            if (!await r.ReadAsync()) return $"-- domain {qualified} not found";
            sb.Append($"CREATE DOMAIN {qualified} AS {r.GetString(0)}");
            if (r.GetString(3).Length > 0) sb.Append($"\n    COLLATE {Quote(r.GetString(3))}");
            if (r.GetString(2).Length > 0) sb.Append($"\n    DEFAULT {r.GetString(2)}");
            if (r.GetBoolean(1)) sb.Append("\n    NOT NULL");
        }

        await using (var cmd = new NpgsqlCommand("""
            SELECT c.conname, pg_get_constraintdef(c.oid)
            FROM pg_constraint c WHERE c.contypid = @oid::oid ORDER BY c.conname;
            """, conn))
        {
            cmd.Parameters.AddWithValue("oid", (long)oid);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                sb.Append($"\n    CONSTRAINT {Quote(r.GetString(0))} {r.GetString(1)}");
        }
        sb.AppendLine(";");
        return sb.ToString();
    }

    private static async Task<string> RangeDdl(NpgsqlConnection conn, uint oid, string qualified)
    {
        await using var cmd = new NpgsqlCommand("""
            SELECT format_type(r.rngsubtype, NULL::integer),
                   COALESCE((SELECT opcname FROM pg_opclass WHERE oid = r.rngsubopc), ''),
                   COALESCE((SELECT collname FROM pg_collation
                             WHERE oid = r.rngcollation AND collname <> 'default'), ''),
                   CASE WHEN r.rngcanonical = 0 THEN '' ELSE r.rngcanonical::regproc::text END,
                   CASE WHEN r.rngsubdiff = 0 THEN '' ELSE r.rngsubdiff::regproc::text END
            FROM pg_range r WHERE r.rngtypid = @oid::oid;
            """, conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        await using var r = await cmd.ExecuteReaderAsync();
        if (!await r.ReadAsync()) return $"-- range type {qualified} not found";
        var opts = new List<string> { $"    SUBTYPE = {r.GetString(0)}" };
        if (r.GetString(1).Length > 0) opts.Add($"    SUBTYPE_OPCLASS = {r.GetString(1)}");
        if (r.GetString(2).Length > 0) opts.Add($"    COLLATION = {Quote(r.GetString(2))}");
        if (r.GetString(3).Length > 0) opts.Add($"    CANONICAL = {r.GetString(3)}");
        if (r.GetString(4).Length > 0) opts.Add($"    SUBTYPE_DIFF = {r.GetString(4)}");
        return $"CREATE TYPE {qualified} AS RANGE (\n{string.Join(",\n", opts)}\n);\n";
    }

    private static async Task<string> BaseTypeDdl(NpgsqlConnection conn, uint oid, string qualified)
    {
        await using var cmd = new NpgsqlCommand("""
            SELECT t.typinput::regproc::text, t.typoutput::regproc::text, t.typlen, t.typbyval,
                   t.typalign::text, t.typstorage::text, t.typcategory::text, t.typdelim::text,
                   COALESCE(t.typdefault, '')
            FROM pg_type t WHERE t.oid = @oid::oid;
            """, conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        await using var r = await cmd.ExecuteReaderAsync();
        if (!await r.ReadAsync()) return $"-- type {qualified} not found";
        var align = r.GetString(4) switch { "c" => "char", "s" => "int2", "i" => "int4", _ => "double" };
        var storage = r.GetString(5) switch { "p" => "plain", "e" => "external", "m" => "main", _ => "extended" };
        var opts = new List<string>
        {
            $"    INPUT = {r.GetString(0)}",
            $"    OUTPUT = {r.GetString(1)}",
            $"    INTERNALLENGTH = {(r.GetInt16(2) < 0 ? "VARIABLE" : r.GetInt16(2).ToString())}",
            $"    ALIGNMENT = {align}",
            $"    STORAGE = {storage}",
            $"    CATEGORY = {Literal(r.GetString(6))}",
            $"    DELIMITER = {Literal(r.GetString(7))}",
        };
        if (r.GetBoolean(3)) opts.Add("    PASSEDBYVALUE"); // a flag, not a key = value option
        if (r.GetString(8).Length > 0) opts.Add($"    DEFAULT = {Literal(r.GetString(8))}");
        return $"CREATE TYPE {qualified} (\n{string.Join(",\n", opts)}\n);\n";
    }

    private static async Task<string> Scalar(NpgsqlConnection conn, string sql, uint oid)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("oid", (long)oid);
        return (string?)await cmd.ExecuteScalarAsync() ?? "";
    }

    private static string Quote(string ident) => $"\"{ident.Replace("\"", "\"\"")}\"";
    private static string Literal(string value) => $"'{value.Replace("'", "''")}'";

    /// <summary>Everything the SQL autocomplete needs, in one round trip.</summary>
    public async Task<CompletionCatalog> GetCompletionCatalog(string connStr)
    {
        await using var conn = await Open(connStr);

        var schemas = new List<string>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT schema_name FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog','information_schema')
              AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%';
            """, conn))
        await using (var r = await cmd.ExecuteReaderAsync())
            while (await r.ReadAsync()) schemas.Add(r.GetString(0));

        var objects = new List<CompletionObject>();
        await using (var cmd = new NpgsqlCommand($"""
            SELECT table_schema, table_name,
                   CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END
            FROM information_schema.tables
            WHERE table_schema = ANY(@s)
            UNION ALL
            SELECT n.nspname, p.proname,
                   CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = ANY(@s) AND p.prokind IN ('f','p')
            UNION ALL
            SELECT n.nspname, t.typname, {TypeKindExpr}
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = ANY(@s)
            {UserTypeFilter};
            """, conn))
        {
            cmd.Parameters.AddWithValue("s", schemas.ToArray());
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                objects.Add(new CompletionObject(r.GetString(0), r.GetString(1), r.GetString(2)));
        }

        var columns = new List<CompletionColumn>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT table_schema, table_name, column_name, data_type
            FROM information_schema.columns WHERE table_schema = ANY(@s)
            UNION ALL
            SELECT n.nspname, t.typname, a.attname, format_type(a.atttypid, a.atttypmod)
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = ANY(@s);
            """, conn))
        {
            cmd.Parameters.AddWithValue("s", schemas.ToArray());
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync())
                columns.Add(new CompletionColumn(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)));
        }

        return new CompletionCatalog(schemas.ToArray(), objects.ToArray(), columns.ToArray());
    }

    public async Task<long> ExecuteStream(
        string connStr, string sql, string queryId, IQuerySink sink, CancellationToken ct)
    {
        long rowCount = 0;
        // an unopened pooled connection, so the Notice handler is attached before open
        await using var conn = NpgsqlPool.Create(connStr);
        conn.Notice += (_, e) => _ = sink.Notice($"{e.Notice.Severity}: {e.Notice.MessageText}");
        await conn.OpenAsync(ct);

        await using var cmd = new NpgsqlCommand(sql, conn) { CommandTimeout = 0 };
        // fetch every column as text: supports custom types (domains, composites, enums)
        // that Npgsql has no .NET mapping for; the grid displays strings anyway
        cmd.AllResultTypesAreUnknown = true;
        await using var reader = await cmd.ExecuteReaderAsync(ct);

        do
        {
            if (reader.FieldCount > 0)
            {
                var columns = Enumerable.Range(0, reader.FieldCount)
                    .Select(i => new ColumnInfo(reader.GetName(i), reader.GetDataTypeName(i)))
                    .ToArray();
                await sink.Columns(columns);

                var chunk = new List<object?[]>(ChunkSize);
                while (await reader.ReadAsync(ct))
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
                        await sink.Rows(chunk);
                        chunk = new List<object?[]>(ChunkSize);
                    }
                }
                if (chunk.Count > 0) await sink.Rows(chunk);
            }
            else if (reader.RecordsAffected >= 0)
            {
                rowCount += reader.RecordsAffected;
            }
        } while (await reader.NextResultAsync(ct));

        return rowCount;
    }

    /// <summary>Npgsql cancels through the socket, so there is nothing extra to do server-side.</summary>
    public Task KillQuery(string connStr, string queryId) => Task.CompletedTask;

    public RpcError? MapError(Exception ex) => ex is PostgresException pg
        ? new RpcError(pg.SqlState, $"{pg.MessageText} (line {pg.Line})", pg.Severity)
        : null;

    private static async Task<NpgsqlConnection> Open(string connStr)
    {
        // draws from the shared, tuned pool for this connection string
        return await NpgsqlPool.OpenAsync(connStr);
    }
}
