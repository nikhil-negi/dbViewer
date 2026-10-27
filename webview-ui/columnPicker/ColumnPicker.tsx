import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fuzzyRank } from '../../src/fuzzy';
import type { ColumnPickerFromWebview, ColumnPickerInit } from '../../src/webview/protocol';
import { postToHost } from '../shared/vscode';

const post = (m: ColumnPickerFromWebview) => postToHost(m);

const isSep = (c: string) => c === '_' || c === ' ' || c === '-' || c === '.';
const norm = (s: string) => [...s.toLowerCase()].filter(c => !isSep(c)).join('');

/** Bolds the part of `name` that contains the query, ignoring separators (as the matcher does). */
function highlight(name: string, query: string): ReactNode {
    const q = norm(query);
    const at = q ? norm(name).indexOf(q) : -1;
    if (at < 0) { return name; }
    let ni = 0, start = -1, end = -1;
    for (let i = 0; i < name.length; i++) {
        if (isSep(name[i])) { continue; }
        if (ni === at) { start = i; }
        if (ni === at + q.length - 1) { end = i; break; }
        ni++;
    }
    if (start < 0 || end < 0) { return name; }
    return <>{name.slice(0, start)}<b>{name.slice(start, end + 1)}</b>{name.slice(end + 1)}</>;
}

/**
 * Chooses which columns of a table to show: a checkbox per column, a fuzzy search box
 * (tolerant of `_`/spaces, word position and typos — src/fuzzy.ts), and a select-all
 * toggle scoped to the current search. Apply returns the checked names to the host.
 */
export function ColumnPicker({ init }: { init: ColumnPickerInit }) {
    const all = init.columns;
    const [checked, setChecked] = useState<Record<string, boolean>>(
        () => Object.fromEntries(all.map(c => [c.name, c.checked])));
    const [query, setQuery] = useState('');
    const selectAllRef = useRef<HTMLInputElement>(null);

    const q = query.trim();
    const visible = useMemo(() => fuzzyRank(q, all, c => c.name), [q, all]);
    const onVisible = visible.filter(c => checked[c.name]).length;
    const onTotal = all.filter(c => checked[c.name]).length;

    // a checkbox's indeterminate state exists only as a DOM property
    useEffect(() => {
        if (selectAllRef.current) {
            selectAllRef.current.indeterminate = onVisible > 0 && onVisible < visible.length;
        }
    }, [onVisible, visible.length]);

    const setMany = (names: string[], on: boolean) =>
        setChecked(prev => ({ ...prev, ...Object.fromEntries(names.map(n => [n, on])) }));
    const apply = () => post({ type: 'apply', columns: all.map(c => c.name).filter(n => checked[n]) });

    return (
        <div className="wrap">
            <header>
                <h2>Show columns of {init.title}</h2>
                <div className="controls">
                    <label className="selall">
                        <input type="checkbox" ref={selectAllRef}
                            checked={visible.length > 0 && onVisible === visible.length}
                            onChange={e => setMany(visible.map(c => c.name), e.target.checked)} />
                        Select all
                    </label>
                    <input className="search" autoFocus value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { apply(); } }}
                        placeholder="Search columns… (ignores _/spaces, tolerates typos)" />
                </div>
                <div className="count">
                    {onTotal} of {all.length} column(s) selected{q ? ` · ${visible.length} shown` : ''}
                </div>
            </header>
            <div className="list">
                {visible.length === 0 && <div className="none">No columns match “{q}”.</div>}
                {visible.map(c => (
                    <label key={c.name} className="row">
                        <input type="checkbox" checked={!!checked[c.name]}
                            onChange={e => setMany([c.name], e.target.checked)} />
                        <span className="name">{highlight(c.name, q)}</span>
                        <span className="type">{c.type}</span>
                    </label>
                ))}
            </div>
            <footer>
                <button className="secondary" onClick={() => { setMany(all.map(c => c.name), true); setQuery(''); }}>
                    Reset to all
                </button>
                <div className="spacer" />
                <button className="secondary" onClick={() => post({ type: 'cancel' })}>Cancel</button>
                <button className="primary" onClick={apply}>Apply</button>
            </footer>
        </div>
    );
}
