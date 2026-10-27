import { memo, useCallback, useMemo, useReducer, useRef, useState, type MouseEvent, type UIEvent } from 'react';
import type { Cell, GridColumn, GridFromWebview, GridInit, GridToWebview } from '../../src/webview/protocol';
import { postToHost, useHostMessages } from '../shared/vscode';
import { sortRows, toCsv, toSqlInserts, typeClass } from './gridUtils';

const post = (m: GridFromWebview) => postToHost(m);

/** Rows beyond this are kept (for export) but not rendered, so huge results stay responsive. */
const MAX_RENDER_ROWS = 5000;

type Pane = 'grid' | 'messages' | 'metrics';
interface LogLine { text: string; error?: boolean; }
interface Sort { col: number | null; dir: 'asc' | 'desc'; }

const isMulti = (e: MouseEvent) => e.metaKey || e.ctrlKey;

/**
 * Results grid shared by the query results panel and the table viewer: Data / DDL /
 * Messages / Metrics tabs, row + column selection, CSV/SQL export, header sort, and (table
 * mode) infinite scroll that asks the host for the next page.
 */
export function Grid({ init }: { init: GridInit }) {
    const [pane, setPane] = useState<Pane>('grid');
    const [columns, setColumns] = useState<GridColumn[]>([]);
    const [log, setLog] = useState<LogLine[]>([]);
    const [metrics, setMetrics] = useState('');
    const [status, setStatus] = useState('');
    const [colLabel, setColLabel] = useState('Columns…');
    const [selRows, setSelRows] = useState<ReadonlySet<number>>(new Set());
    const [selCols, setSelCols] = useState<ReadonlySet<number>>(new Set());
    const [sort, setSort] = useState<Sort>({ col: null, dir: 'asc' });

    // Row data can run to many thousands of rows arriving in chunks, so it lives in a ref
    // and is appended in place; `rerender` repaints after each change.
    const data = useRef<Cell[][]>([]);
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const hasHeader = useRef(false);
    const flags = useRef({ running: false, loading: false, exhausted: false });
    const rowAnchor = useRef<number | null>(null);

    const loadedText = () =>
        `${data.current.length} row(s) loaded${flags.current.exhausted ? ' (all)' : ''}`;
    const addLog = (text: string, error = false) => setLog(l => [...l, { text, error }]);

    useHostMessages<GridToWebview>(m => {
        const f = flags.current;
        switch (m.type) {
            case 'columnInfo':
                if (m.selected !== undefined && m.total !== undefined) {
                    setColLabel(m.selected < m.total ? `Columns (${m.selected}/${m.total})` : 'Columns…');
                }
                break;
            case 'start':
                f.running = true;
                if (m.reset !== false) {
                    data.current = [];
                    hasHeader.current = false;
                    f.exhausted = false;
                    rowAnchor.current = null;
                    setColumns([]);
                    setSelRows(new Set());
                    setSelCols(new Set());
                    // a table re-query keeps its server-side sort; fresh query results start unsorted
                    if (init.mode === 'query') { setSort(s => ({ ...s, col: null })); }
                    setLog([]);
                    setMetrics('');
                    rerender();
                }
                if (m.connection) { addLog(`Running on ${m.connection}...`); }
                break;
            case 'columns':
                // a multi-statement script reports columns per statement; the first set wins
                if (!hasHeader.current) { hasHeader.current = true; setColumns(m.columns); }
                break;
            case 'rows':
                data.current.push(...m.rows);
                setStatus(loadedText());
                rerender();
                break;
            case 'notice':
                addLog(m.message);
                break;
            case 'complete': {
                f.running = false;
                f.loading = false;
                if (m.success) {
                    if (m.pageRows !== undefined && m.pageSize !== undefined && m.pageRows < m.pageSize) {
                        f.exhausted = true;
                    }
                    addLog(`Done. ${m.rowCount} row(s) in ${m.elapsedMs} ms.`);
                } else {
                    f.exhausted = true;
                    addLog(`${m.error?.code || 'ERROR'}: ${m.error?.message || 'unknown error'}`, true);
                }
                const n = data.current.length;
                setMetrics(`Rows loaded: ${n}\nLast batch: ${m.rowCount} row(s), ${m.elapsedMs} ms\n` +
                    `Status: ${m.success ? 'success' : 'failed'}`);
                setStatus(loadedText());
                if (n > MAX_RENDER_ROWS) {
                    addLog(`Grid render capped at ${MAX_RENDER_ROWS} rows (${n} held for export).`);
                }
                break;
            }
        }
    });

    // plain click sorts (toggling asc/desc); cmd/ctrl-click selects the column instead
    const onHeaderClick = (ci: number, e: MouseEvent) => {
        if (isMulti(e)) { setSelCols(s => toggle(s, ci)); return; }
        const dir = sort.col === ci && sort.dir === 'asc' ? 'desc' : 'asc';
        setSort({ col: ci, dir });
        if (init.mode === 'table') {
            post({ type: 'sort', column: columns[ci].name, dir });
        } else {
            sortRows(data.current, ci, dir);
            setSelRows(new Set());
            rowAnchor.current = null;
            rerender();
        }
    };

    // stable identity so memoised rows don't re-render on every chunk
    const onRowNumClick = useCallback((ri: number, e: MouseEvent) => {
        const anchor = rowAnchor.current;
        if (e.shiftKey && anchor !== null) {
            // shift-click: select the range from the anchor, like a text editor
            setSelRows(s => {
                const next = new Set(isMulti(e) ? s : []);
                for (let i = Math.min(anchor, ri); i <= Math.max(anchor, ri); i++) { next.add(i); }
                return next;
            });
        } else if (isMulti(e)) {
            setSelRows(s => toggle(s, ri));
            rowAnchor.current = ri;
        } else {
            setSelRows(new Set([ri]));
            setSelCols(new Set());
            rowAnchor.current = ri;
        }
    }, []);

    const onScroll = (e: UIEvent<HTMLDivElement>) => {
        const f = flags.current;
        if (init.mode !== 'table' || f.loading || f.exhausted || f.running) { return; }
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
            f.loading = true;
            post({ type: 'loadMore', offset: data.current.length });
        }
    };

    // the selection if there is one, else everything loaded
    const exportSet = () => ({
        rowIdx: selRows.size ? [...selRows].sort((a, b) => a - b) : data.current.map((_, i) => i),
        colIdx: selCols.size ? [...selCols].sort((a, b) => a - b) : columns.map((_, i) => i),
    });
    const exportAs = (format: 'csv' | 'sql') => {
        const { rowIdx, colIdx } = exportSet();
        const content = format === 'csv'
            ? toCsv(columns, data.current, rowIdx, colIdx)
            : toSqlInserts(init.tableName, columns, data.current, rowIdx, colIdx);
        post({ type: 'export', format, content, name: init.tableName });
    };

    const colClasses = useMemo(() => columns.map(c => typeClass(c.type)), [columns]);
    const shown = data.current.slice(0, MAX_RENDER_ROWS);

    const tab = (p: Pane, label: string) => (
        <div className={`tab${pane === p ? ' active' : ''}`} onClick={() => setPane(p)}>{label}</div>
    );

    return (
        <>
            <div className="bar">
                {tab('grid', 'Data')}
                {init.mode === 'table' && init.ddl && (
                    <div className="tab" title="Open DDL in an editor" onClick={() => post({ type: 'openDdl' })}>
                        DDL ↗
                    </div>
                )}
                {tab('messages', 'Messages')}
                {tab('metrics', 'Metrics')}
                <div className="spacer" />
                {init.columns && (
                    <button title="Choose which columns to show" onClick={() => post({ type: 'pickColumns' })}>
                        {colLabel}
                    </button>
                )}
                <button onClick={() => exportAs('csv')}>Export CSV</button>
                <button onClick={() => exportAs('sql')}>Export SQL</button>
                <button onClick={() => { setSelRows(new Set()); setSelCols(new Set()); }}>Clear selection</button>
            </div>

            <div className={`pane${pane === 'grid' ? ' active' : ''}`}>
                <div className="gridwrap" onScroll={onScroll}>
                    {columns.length > 0 && (
                        <table>
                            <thead>
                                <tr>
                                    <th className="rownum">#</th>
                                    {columns.map((c, ci) => (
                                        <th key={ci}
                                            className={cls(colClasses[ci], sort.col === ci && 'sorted', selCols.has(ci) && 'selcol')}
                                            title="Click to sort · Cmd/Ctrl-click to select column"
                                            onClick={e => onHeaderClick(ci, e)}>
                                            {c.name} ({c.type}){sort.col === ci ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((row, ri) => (
                                    <Row key={ri} ri={ri} row={row} colClasses={colClasses}
                                        selected={selRows.has(ri)} selCols={selCols} onRowNumClick={onRowNumClick} />
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
            <div className={`pane mono${pane === 'messages' ? ' active' : ''}`}>
                {log.map((l, i) => <div key={i} className={l.error ? 'error' : undefined}>{l.text}</div>)}
            </div>
            <div className={`pane mono${pane === 'metrics' ? ' active' : ''}`}>{metrics}</div>
            <div className="status">{status}</div>
        </>
    );
}

interface RowProps {
    ri: number;
    row: Cell[];
    colClasses: string[];
    selected: boolean;
    selCols: ReadonlySet<number>;
    onRowNumClick: (ri: number, e: MouseEvent) => void;
}

/** One data row; memoised so appending a chunk renders only the new rows. */
const Row = memo(function Row({ ri, row, colClasses, selected, selCols, onRowNumClick }: RowProps) {
    return (
        <tr className={selected ? 'selrow' : undefined}>
            <td className="rownum" onClick={e => onRowNumClick(ri, e)}>{ri + 1}</td>
            {row.map((cell, ci) => (
                <td key={ci} className={cls(cell === null ? 'null' : colClasses[ci], selCols.has(ci) && 'selcol')}>
                    {cell === null ? 'NULL' : String(cell)}
                </td>
            ))}
        </tr>
    );
});

function toggle(s: ReadonlySet<number>, v: number): Set<number> {
    const next = new Set(s);
    if (next.has(v)) { next.delete(v); } else { next.add(v); }
    return next;
}

function cls(...names: (string | false | undefined)[]): string | undefined {
    return names.filter(Boolean).join(' ') || undefined;
}
