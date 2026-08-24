using Npgsql;

namespace DBViewerWorker.Providers;

/// <summary>
/// Owns one <see cref="NpgsqlDataSource"/> per connection string and hands out pooled
/// connections from it. A data source is the modern Npgsql pooling primitive: it holds
/// the physical connection pool and caches the parsed settings and host resolution, so
/// reusing one across the many short catalog/query operations is markedly cheaper than
/// building a fresh <c>NpgsqlConnection</c> each time.
///
/// Keyed by the *tuned* connection string, so callers that pass the same raw string share
/// a pool. The cache is bounded; editing a connection produces a different string and thus
/// a new data source, and the least-recently-used one is disposed once the cap is reached.
/// </summary>
internal static class NpgsqlPool
{
    private const int MaxDataSources = 32;

    private static readonly object Gate = new();
    // insertion/access order is maintained by re-inserting on hit, so the first key is the LRU victim
    private static readonly Dictionary<string, NpgsqlDataSource> Cache = new();
    private static readonly LinkedList<string> Lru = new();

    /// <summary>Returns the shared data source for a connection string, building it on first use.</summary>
    public static NpgsqlDataSource Source(string connStr)
    {
        var key = Tune(connStr);
        lock (Gate)
        {
            if (Cache.TryGetValue(key, out var existing))
            {
                Touch(key);
                return existing;
            }

            var built = new NpgsqlDataSourceBuilder(key).Build();
            if (Cache.Count >= MaxDataSources) EvictOldest();
            Cache[key] = built;
            Lru.AddLast(key);
            return built;
        }
    }

    /// <summary>An unopened connection bound to the pool, so callers can wire up events before opening.</summary>
    public static NpgsqlConnection Create(string connStr) => Source(connStr).CreateConnection();

    /// <summary>A ready-to-use pooled connection.</summary>
    public static ValueTask<NpgsqlConnection> OpenAsync(string connStr, CancellationToken ct = default) =>
        Source(connStr).OpenConnectionAsync(ct);

    /// <summary>
    /// Normalises pool-relevant settings so every connection actually pools and reuse
    /// stays healthy. Pooling is forced on only when the string does not mention it,
    /// so a deliberate <c>Pooling=false</c> is still honoured. Keepalive and idle-lifetime
    /// defaults are applied when the caller has not set them.
    /// </summary>
    private static string Tune(string connStr)
    {
        var b = new NpgsqlConnectionStringBuilder(connStr);
        if (!Mentions(connStr, "Pooling")) b.Pooling = true;
        if (b.Pooling)
        {
            // recycle idle connections rather than holding them open forever
            if (!Mentions(connStr, "Connection Idle Lifetime", "ConnectionIdleLifetime"))
                b.ConnectionIdleLifetime = 300;
            // detect connections dropped by a firewall/server so a stale one is not handed out
            if (!Mentions(connStr, "Keepalive")) b.KeepAlive = 30;
            // cap idle connection age so long-lived pools pick up server-side changes
            if (!Mentions(connStr, "Connection Pruning Interval", "ConnectionPruningInterval"))
                b.ConnectionPruningInterval = 10;
        }
        return b.ConnectionString;
    }

    private static bool Mentions(string connStr, params string[] keys) =>
        keys.Any(k => connStr.Contains(k, StringComparison.OrdinalIgnoreCase));

    private static void Touch(string key)
    {
        Lru.Remove(key);
        Lru.AddLast(key);
    }

    private static void EvictOldest()
    {
        var oldest = Lru.First;
        if (oldest is null) return;
        Lru.RemoveFirst();
        if (Cache.Remove(oldest.Value, out var ds))
            _ = ds.DisposeAsync().AsTask(); // fire-and-forget: drains and closes its pool
    }
}
