using PGNetWorker.Providers;

namespace PGNetWorker.Handlers;

public record RpcError(string Code, string Message, string Severity);
public record TestConnectionResult(bool Success, string? ServerVersion, RpcError? Error);

public class ConnectionHandler
{
    public Task<TestConnectionResult> TestConnection(string provider, string connectionString) =>
        ProviderRegistry.For(provider).TestConnection(connectionString);

    public Task<string[]> ListDatabases(string provider, string connectionString) =>
        ProviderRegistry.For(provider).ListDatabases(connectionString);
}
