/**
 * Comment- and quote-aware splitting of a SQL script into top-level statements,
 * mirroring the worker's SqlSplitter so the extension can reason about a script the
 * same way the server will run it (e.g. "is this a single SELECT?").
 */
export function splitStatements(script: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < script.length; i++) {
        const c = script[i];
        if (c === "'" || c === '"' || c === '`') { i = skipQuoted(script, i, c); }
        else if (c === '-' && script[i + 1] === '-') { i = nextLine(script, i); }
        else if (c === '/' && script[i + 1] === '*') { i = endBlock(script, i); }
        else if (c === ';') { push(out, script.slice(start, i)); start = i + 1; }
    }
    push(out, script.slice(start));
    return out;
}

function push(into: string[], stmt: string): void {
    if (stmt.trim().length > 0) { into.push(stmt.trim()); }
}
function skipQuoted(s: string, i: number, q: string): number {
    for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\' && q === "'") { j++; continue; }
        if (s[j] !== q) { continue; }
        if (s[j + 1] === q) { j++; continue; }
        return j;
    }
    return s.length - 1;
}
function nextLine(s: string, i: number): number {
    const nl = s.indexOf('\n', i);
    return nl < 0 ? s.length - 1 : nl;
}
function endBlock(s: string, i: number): number {
    const end = s.indexOf('*/', i + 2);
    return end < 0 ? s.length - 1 : end + 1;
}

/**
 * If `sql` is a single read-only SELECT/WITH statement that is safe to wrap in a
 * paginating subquery, returns that statement (semicolon trimmed); otherwise undefined.
 * Multi-statement scripts and writes/DDL are left to run as-is and unpaginated.
 */
export function paginableSelect(sql: string): string | undefined {
    const statements = splitStatements(sql);
    if (statements.length !== 1) { return undefined; }
    const one = statements[0];
    const head = stripLeadingComments(one).slice(0, 8).toLowerCase();
    // a leading WITH may still be a data-modifying CTE (INSERT/UPDATE/DELETE inside);
    // only treat plain SELECT / WITH…SELECT as paginable, and reject obvious writers
    if (/^(insert|update|delete|merge|create|drop|alter|truncate|grant|revoke|call|do)\b/.test(head)) {
        return undefined;
    }
    if (head.startsWith('select') || head.startsWith('with')) {
        if (head.startsWith('with') && /\b(insert|update|delete|merge)\b/i.test(one)) { return undefined; }
        return one;
    }
    return undefined;
}

function stripLeadingComments(sql: string): string {
    let s = sql.trimStart();
    for (;;) {
        if (s.startsWith('--')) { const nl = s.indexOf('\n'); s = nl < 0 ? '' : s.slice(nl + 1).trimStart(); }
        else if (s.startsWith('/*')) { const e = s.indexOf('*/'); s = e < 0 ? '' : s.slice(e + 2).trimStart(); }
        else { return s; }
    }
}
