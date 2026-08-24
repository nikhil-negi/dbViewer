using PGNetWorker.Handlers;
using PGNetWorker.Debug;
using StreamJsonRpc;

// JSON-RPC over stdio. IMPORTANT: nothing else may write to stdout.
var formatter = new SystemTextJsonFormatter();
formatter.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
var handler = new HeaderDelimitedMessageHandler(
    Console.OpenStandardOutput(), Console.OpenStandardInput(), formatter);

var rpc = new JsonRpc(handler);

rpc.AddLocalRpcTarget(new ConnectionHandler(), null);
rpc.AddLocalRpcTarget(new CatalogHandler(), null);
rpc.AddLocalRpcTarget(new QueryHandler(rpc), null);
rpc.AddLocalRpcTarget(new DebugHandler(rpc), null);

rpc.StartListening();
await Console.Error.WriteLineAsync("PGNetWorker ready.");
await rpc.Completion; // exits when stdin closes (extension deactivated)
