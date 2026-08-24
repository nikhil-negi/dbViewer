export interface RoutineArg {
    mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
    name: string;
    type: string;
    isRefcursor: boolean;
}

/**
 * Parses pg_get_function_identity_arguments() output, e.g.
 * "p_id integer, INOUT x_settings refcursor, amount numeric(10,2)".
 * Splits on top-level commas (paren-aware) since types may contain commas.
 */
export function parseRoutineArgs(signature: string): RoutineArg[] {
    if (!signature.trim()) { return []; }
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of signature) {
        if (ch === '(') { depth++; }
        if (ch === ')') { depth--; }
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
        else { cur += ch; }
    }
    if (cur.trim()) { parts.push(cur); }

    return parts.map(p => {
        const tokens = p.trim().split(/\s+/);
        let mode: RoutineArg['mode'] = 'IN';
        if (['IN', 'OUT', 'INOUT', 'VARIADIC'].includes(tokens[0]?.toUpperCase())) {
            mode = tokens.shift()!.toUpperCase() as RoutineArg['mode'];
        }
        // remaining: either "name type..." or just "type..." (unnamed arg)
        const name = tokens.length > 1 ? tokens.shift()! : '';
        const type = tokens.join(' ');
        return { mode, name, type, isRefcursor: /refcursor/i.test(type) };
    });
}

export interface InvokeSql {
    sql: string;
    cursorNames: string[];
}

/**
 * Builds the SQL to invoke a routine. User literals fill the non-refcursor
 * args in order; refcursor args get auto-generated cursor names, and a
 * FETCH ALL per cursor is appended so the result set is visible. Statements
 * run in one multi-statement command => one implicit transaction, so the
 * cursors stay open for the FETCH.
 */
export function buildInvokeSql(
    kind: string, schema: string, name: string, args: RoutineArg[], userLiterals: string[],
): InvokeSql {
    const cursorNames: string[] = [];
    const literals: string[] = [];
    let u = 0;
    for (const a of args) {
        if (a.mode === 'OUT') { continue; } // not passed in CALL/SELECT arg lists
        if (a.isRefcursor) {
            const cname = `dbviewer_cur_${cursorNames.length + 1}`;
            cursorNames.push(cname);
            literals.push(`'${cname}'`);
        } else {
            literals.push(userLiterals[u++] ?? 'NULL');
        }
    }
    const invoke = kind === 'procedure'
        ? `CALL "${schema}"."${name}"(${literals.join(', ')});`
        : `SELECT * FROM "${schema}"."${name}"(${literals.join(', ')});`;
    const fetches = cursorNames.map(c => `FETCH ALL FROM "${c}";`);
    return { sql: [invoke, ...fetches].join('\n'), cursorNames };
}

/** Prompts (via the given prompter) for each user-suppliable argument. */
export function userArgs(args: RoutineArg[]): RoutineArg[] {
    return args.filter(a => a.mode !== 'OUT' && !a.isRefcursor);
}
