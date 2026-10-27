import type { Cell, GridColumn } from '../../src/webview/protocol';

/** CSS class that colours a value by its column's SQL type. */
export function typeClass(type: string | undefined): string {
    const t = (type ?? '').toLowerCase();
    if (/int|numeric|float|double|real|money|serial|decimal/.test(t)) { return 't-num'; }
    if (/timestamp|date|time|interval/.test(t)) { return 't-date'; }
    if (/bool/.test(t)) { return 't-bool'; }
    if (/uuid/.test(t)) { return 't-uuid'; }
    if (/json/.test(t)) { return 't-json'; }
    return '';
}

const isNum = (v: Cell) => v !== null && /^-?\d+(\.\d+)?$/.test(String(v));

/** Sorts rows in place by one column: numbers numerically, everything else as text, nulls last. */
export function sortRows(rows: Cell[][], col: number, dir: 'asc' | 'desc'): void {
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === null) { return 1; }
        if (y === null) { return -1; }
        if (isNum(x) && isNum(y)) { return (Number(x) - Number(y)) * sign; }
        return String(x).localeCompare(String(y)) * sign;
    });
}

function csvEscape(v: Cell): string {
    if (v === null) { return ''; }
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sqlLiteral(v: Cell): string {
    return v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}

export function toCsv(columns: GridColumn[], rows: Cell[][], rowIdx: number[], colIdx: number[]): string {
    const lines = [colIdx.map(ci => csvEscape(columns[ci].name)).join(',')];
    for (const ri of rowIdx) { lines.push(colIdx.map(ci => csvEscape(rows[ri][ci])).join(',')); }
    return lines.join('\n');
}

export function toSqlInserts(
    table: string, columns: GridColumn[], rows: Cell[][], rowIdx: number[], colIdx: number[],
): string {
    const cols = colIdx.map(ci => `"${columns[ci].name}"`).join(', ');
    return rowIdx
        .map(ri => `INSERT INTO ${table} (${cols}) VALUES (${colIdx.map(ci => sqlLiteral(rows[ri][ci])).join(', ')});`)
        .join('\n');
}
