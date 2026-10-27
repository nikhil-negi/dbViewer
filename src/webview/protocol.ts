import type { ConnectionFields, ProviderId } from '../providers';

/**
 * Message contracts between the extension host and each React webview in webview-ui/.
 * Type-only (no runtime code, no `vscode` import), so both the extension build and the
 * webview bundle compile against the same definitions.
 */

/** The webview bundles built by esbuild.mjs (out/webview-ui/<entry>.js|.css). */
export type WebviewEntry = 'connectionEditor' | 'columnPicker' | 'grid';

// ---------- connection editor ----------

/** What the editor form posts back on Preview / Test / Save. */
export interface EditorForm extends ConnectionFields {
    name: string;
    provider: string;
}

export interface EditorLoad {
    type: 'load';
    mode: 'add' | 'edit';
    name: string;
    provider: ProviderId;
    fields: ConnectionFields;
    existingNames: string[];
    /** True while walking a queue of connections (Cancel becomes Skip). */
    inQueue: boolean;
    /** "2 of 5" while walking a queue, else empty. */
    progress: string;
    providers: { id: ProviderId; label: string }[];
}

export type EditorToWebview =
    | EditorLoad
    | { type: 'fill'; fields: ConnectionFields; provider?: ProviderId }
    | { type: 'connstr'; value: string }
    | { type: 'testResult'; success: boolean; message: string }
    | { type: 'saveResult'; success: boolean; message: string };

export type EditorFromWebview =
    | { type: 'ready' }
    | { type: 'parse'; text: string }
    | { type: 'preview'; form: EditorForm }
    | { type: 'test'; form: EditorForm }
    | { type: 'save'; form: EditorForm }
    | { type: 'cancel' };

// ---------- column picker ----------

export interface ColumnInfo { name: string; type: string; }

export interface ColumnPickerInit {
    title: string;
    columns: (ColumnInfo & { checked: boolean })[];
}

export type ColumnPickerFromWebview =
    | { type: 'apply'; columns: string[] }
    | { type: 'cancel' };

// ---------- results grid (query results + table viewer) ----------

export interface GridInit {
    /** 'table' pages on scroll and sorts server-side; 'query' sorts the loaded rows locally. */
    mode: 'query' | 'table';
    /** Used for export file names and INSERT targets. */
    tableName: string;
    /** Show the "DDL ↗" tab (table mode only). */
    ddl: boolean;
    /** Show the "Columns…" picker button. */
    columns: boolean;
}

export interface GridColumn { name: string; type: string; }

/** A cell as the worker serialises it; null is SQL NULL. */
export type Cell = unknown;

export interface QueryError { code: string; message: string; severity?: string; }

export type GridToWebview =
    | { type: 'start'; reset?: boolean; connection?: string }
    | { type: 'columns'; columns: GridColumn[] }
    | { type: 'rows'; rows: Cell[][] }
    | { type: 'notice'; message: string }
    | {
        type: 'complete'; success: boolean; rowCount: number; elapsedMs: number;
        error?: QueryError | null;
        /** Paged runs only: rows in this page vs the page size, to detect the last page. */
        pageRows?: number; pageSize?: number;
    }
    | { type: 'columnInfo'; selected?: number; total?: number };

export type GridFromWebview =
    | { type: 'export'; format: 'csv' | 'sql'; content: string; name: string }
    | { type: 'loadMore'; offset: number }
    | { type: 'sort'; column: string; dir: 'asc' | 'desc' }
    | { type: 'pickColumns' }
    | { type: 'openDdl' };
