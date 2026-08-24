# PGNet — PostgreSQL & ClickHouse Explorer for VS Code

Hybrid architecture:

- **Frontend**: TypeScript VS Code extension (`src/`) — tree view, virtual documents, results webview, inline DAP debug adapter, DBeaver import. No database code runs in Node.
- **Backend**: .NET 10 console app (`worker/PGNetWorker/`) — StreamJsonRpc over stdin/stdout. All connections, catalog queries, streaming execution, and pldbgapi debugging live here.

## Engines

Each connection names a provider (`worker/PGNetWorker/Providers/`), and every RPC call
takes that provider id first, so one worker serves both engines at once.

| | PostgreSQL | ClickHouse |
|---|---|---|
| Transport | Npgsql | HTTP(S) interface — no driver to install |
| Pooling | a cached `NpgsqlDataSource` per connection string | one shared keep-alive socket pool per host |
| Tree | Tables · Views · Routines · Data Types | Tables · Views · Functions |
| DDL | rebuilt from the catalogs | `SHOW CREATE` / `system.functions` |
| Run routine · debug | yes | not applicable |
| Multi-statement scripts | one command | split on top-level semicolons (one statement per HTTP request) |

ClickHouse connection strings use the same key=value shape as Npgsql, e.g.
`Host=ch.example.com;Port=8443;Database=default;Username=ro;Password=...;Protocol=https`.
A value containing `;` or `=` may be double-quoted.

**Connection pooling.** Both engines reuse physical connections so repeated catalog
lookups, autocomplete refreshes and queries don't pay a connect/handshake each time.
Postgres routes every operation through a `NpgsqlDataSource` cached per connection string
(`Providers/NpgsqlPool.cs`) — pooling is forced on unless the string explicitly sets
`Pooling=false`, with sensible keepalive and idle-lifetime defaults; the cache is bounded
and evicts least-recently-used data sources. ClickHouse shares one tuned `HttpClient` whose
`SocketsHttpHandler` keeps warm keep-alive sockets per host. The PL/pgSQL debugger keeps its
own dedicated control/target connections (a debug session can't be pooled) and is unaffected.

## Build & run

```bash
npm install
npm run compile
dotnet build worker/PGNetWorker
```

Then press **F5** in VS Code (Run Extension). In dev, the extension finds the Debug build of the worker automatically; for packaging, `npm run build-worker` publishes it to `worker/publish/`.

## Usage

1. **Add a connection** — database icon in the activity bar → `+`. Pick the engine, name it, and paste a connection string. The string is stored in VS Code SecretStorage and verified before saving.

   **Or import from DBeaver** — the cloud icon in the view title (*PGNet: Import Connections from DBeaver*) scans DBeaver's workspace (`DBeaverData/workspace6/<project>/.dbeaver/data-sources.json`, plus the flatpak/snap/macOS/Windows locations) and offers every PostgreSQL and ClickHouse data source it finds. Usernames and passwords come across too: DBeaver's `credentials-config.json` is AES-128-CBC encrypted with a fixed key that ships inside DBeaver, and PGNet decrypts it during the scan. Any connection whose credentials can't be read (a build that changed the scheme, or credentials never saved) is listed as such, and the connection editor dialog opens afterwards to fill them in — the *Set Connection Credentials* command (also on the connection's context menu) reopens that dialog anytime, with a labeled field per setting, a reveal toggle on the password (editing shows the saved one so it can be checked or corrected), an in-place **Test Connection** button, and a paste bar that fills the whole form from a connection string.

   The import also offers to carry over DBeaver's own per-script bindings (`project-metadata.json` records the data source each script was last run against), so opening one of those `.sql` files in VS Code lands on the same server it used in DBeaver. Scripts whose file or data source no longer exists are skipped.
2. **Browse** — Connection → Schemas → Tables / Views / Routines / Data Types. Clicking a table, view, or data type opens a paginated grid with a **DDL ↗** tab; clicking a routine opens its DDL directly (read-only virtual document, `pg-schema://` scheme). A data type's grid shows its definition detail — enum labels, composite attributes, a domain's base type and constraints, a range's subtype configuration — with the same sorting and CSV/SQL export as table data.
3. **Run queries** — in any SQL editor, select text (or nothing for the whole file) and press **Cmd+Enter** (or run *PGNet: Run Query*). A single read-only `SELECT` is **capped at 200 rows and paged in as you scroll** — the same guard other DB viewers give you against accidentally pulling a whole huge table — with click-to-sort on the headers; writes, DDL and multi-statement scripts run in full and stream in 100-row chunks. Data Grid / Messages / Metrics tabs; cancel with *PGNet: Cancel Running Query*.

4. **Know which server and schema you are on** — every SQL file carries its own connection *and* default schema, shown as two adjacent status-bar items (`$(database) analytics-prod` · `$(symbol-namespace) paylink`) and in the results panel title. Click the first to change the connection, the second to change the schema. The chosen schema is applied to each run (Postgres `search_path`, ClickHouse default database), so unqualified names like `transactions_encrypted` resolve without writing `schema.table` every time. Each file's binding is explicit and pinned — opening or rebinding one file never changes where another already-open file runs — and the first run on an unbound file asks once and remembers. Running always targets the SQL editor you last focused, even from the results panel. DDL documents opened from the explorer inherit the connection and schema they came from, and *Use This Connection for the Active File* on a connection's context menu binds from the other direction. Bindings persist per workspace.
5. **Debug PL/pgSQL** (PostgreSQL only) — requires the server extension:
   ```sql
   CREATE EXTENSION pldbgapi;
   ```
   and `shared_preload_libraries = 'plugin_debugger'` in `postgresql.conf` (restart required).

   Either click the debug icon on a routine in the explorer (it prompts for argument literals), or use a `launch.json` entry:
   ```json
   { "type": "pgsql", "request": "launch", "name": "Debug my_func",
     "connection": "local-dev", "routine": "public.my_func", "args": ["42", "'abc'"] }
   ```
   Stepping (over/into), continue, breakpoints, call stack, and local variables are all driven through `pldbg_*` calls on a control connection while a second target connection runs the routine.

## RPC surface (worker)

Every method below takes the provider id (`postgres` \| `clickhouse`) as its first argument.

| Method | Purpose |
|---|---|
| `TestConnection`, `ListDatabases` | connectivity |
| `GetSchemas/GetTables/GetViews/GetRoutines/GetTypes` | catalog tree |
| `GetTableDefinition/GetViewDefinition/GetRoutineDefinition/GetTypeDefinition` | DDL for virtual docs |
| `GetCompletionCatalog` | schemas, objects (incl. data types), columns for SQL autocomplete |
| `ExecuteQueryStream`, `CancelQuery` | streaming execution (notifies `onColumns`, `onDataChunk`, `onNotice`, `onQueryComplete`); cancel aborts the socket and, on ClickHouse, issues `KILL QUERY` |
| `CheckDebuggerInstalled`, `DebugStart`, `StepOver/StepInto/Continue`, `SetBreakpoint/DropBreakpoint`, `GetStack`, `GetVariables`, `GetSource`, `DebugAbort` | pldbgapi debugging (notifies `onDebugOutput`, `onDebugTerminated`) |
