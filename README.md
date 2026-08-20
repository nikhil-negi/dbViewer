# PGNet — PostgreSQL Explorer & PL/pgSQL Debugger for VS Code

Hybrid architecture:

- **Frontend**: TypeScript VS Code extension (`src/`) — tree view, virtual documents, results webview, inline DAP debug adapter. No database code runs in Node.
- **Backend**: .NET 10 console app (`worker/PGNetWorker/`) — Npgsql + StreamJsonRpc over stdin/stdout. All connections, catalog queries, streaming execution, and pldbgapi debugging live here.

## Build & run

```bash
npm install
npm run compile
dotnet build worker/PGNetWorker
```

Then press **F5** in VS Code (Run Extension). In dev, the extension finds the Debug build of the worker automatically; for packaging, `npm run build-worker` publishes it to `worker/publish/`.

## Usage

1. **Add a connection** — PostgreSQL icon in the activity bar → `+`. Give it a name and an Npgsql connection string (`Host=...;Database=...;Username=...;Password=...`). The string is stored in VS Code SecretStorage; it is validated with `SELECT 1` before saving.
2. **Browse** — Connection → Schemas → Tables / Views / Routines. Clicking an object opens its DDL (read-only virtual document, `pg-schema://` scheme).
3. **Run queries** — in any SQL editor, select text (or nothing for the whole file) and press **Cmd+Enter** (or run *PGNet: Run Query*). Results stream into a side panel in 100-row chunks with Data Grid / Messages / Metrics tabs. Cancel with *PGNet: Cancel Running Query*.
4. **Debug PL/pgSQL** — requires the server extension:
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

| Method | Purpose |
|---|---|
| `TestConnection`, `ListDatabases` | connectivity |
| `GetSchemas/GetTables/GetViews/GetRoutines` | catalog tree |
| `GetTableDefinition/GetViewDefinition/GetRoutineDefinition` | DDL for virtual docs |
| `ExecuteQueryStream`, `CancelQuery` | streaming execution (notifies `onColumns`, `onDataChunk`, `onNotice`, `onQueryComplete`) |
| `CheckDebuggerInstalled`, `DebugStart`, `StepOver/StepInto/Continue`, `SetBreakpoint/DropBreakpoint`, `GetStack`, `GetVariables`, `GetSource`, `DebugAbort` | pldbgapi debugging (notifies `onDebugOutput`, `onDebugTerminated`) |
