using DBViewerWorker.Providers;

namespace DBViewerWorker.Handlers;

/// <summary>
/// RPC facade over the catalog side of a provider. Every method takes the provider
/// id first so a single worker can serve Postgres and ClickHouse connections at once.
/// </summary>
public class CatalogHandler
{
    public Task<SchemaNode[]> GetSchemas(string provider, string connStr) =>
        ProviderRegistry.For(provider).GetSchemas(connStr);

    public Task<TableNode[]> GetTables(string provider, string connStr, string schema) =>
        ProviderRegistry.For(provider).GetTables(connStr, schema);

    public Task<TableNode[]> GetViews(string provider, string connStr, string schema) =>
        ProviderRegistry.For(provider).GetViews(connStr, schema);

    public Task<RoutineNode[]> GetRoutines(string provider, string connStr, string schema) =>
        ProviderRegistry.For(provider).GetRoutines(connStr, schema);

    public Task<TypeNode[]> GetTypes(string provider, string connStr, string schema) =>
        ProviderRegistry.For(provider).GetTypes(connStr, schema);

    public Task<ColumnInfo[]> GetColumns(string provider, string connStr, string schema, string table) =>
        ProviderRegistry.For(provider).GetColumns(connStr, schema, table);

    public Task<string> GetTableDefinition(string provider, string connStr, string schema, string name) =>
        ProviderRegistry.For(provider).GetTableDefinition(connStr, schema, name);

    public Task<string> GetViewDefinition(string provider, string connStr, string schema, string name) =>
        ProviderRegistry.For(provider).GetViewDefinition(connStr, schema, name);

    public Task<string> GetRoutineDefinition(
        string provider, string connStr, string schema, string name, uint oid) =>
        ProviderRegistry.For(provider).GetRoutineDefinition(connStr, schema, name, oid);

    public Task<string> GetTypeDefinition(string provider, string connStr, string schema, string name) =>
        ProviderRegistry.For(provider).GetTypeDefinition(connStr, schema, name);

    public Task<CompletionCatalog> GetCompletionCatalog(string provider, string connStr) =>
        ProviderRegistry.For(provider).GetCompletionCatalog(connStr);
}
