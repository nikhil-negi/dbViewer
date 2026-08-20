using Npgsql;

namespace PGNetWorker.Handlers;

public record RpcError(string Code, string Message, string Severity);
public record TestConnectionResult(bool Success, string? ServerVersion, RpcError? Error);

public class ConnectionHandler
{
    public async Task<TestConnectionResult> TestConnection(string connectionString)
    {
        try
        {
            await using var conn = new NpgsqlConnection(connectionString);
            await conn.OpenAsync();
            await using var cmd = new NpgsqlCommand("SELECT 1;", conn);
            await cmd.ExecuteScalarAsync();
            return new TestConnectionResult(true, conn.PostgreSqlVersion.ToString(), null);
        }
        catch (PostgresException ex)
        {
            return new TestConnectionResult(false, null, new RpcError(ex.SqlState, ex.MessageText, ex.Severity));
        }
        catch (Exception ex)
        {
            return new TestConnectionResult(false, null, new RpcError("CLIENT", ex.Message, "ERROR"));
        }
    }

    public async Task<string[]> ListDatabases(string connectionString)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname;", conn);
        var result = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync()) result.Add(reader.GetString(0));
        return result.ToArray();
    }
}
