/**
 * Fuzzy matching tuned for database identifiers, shared by the column selector and the
 * tree filter. It is tolerant of the things people get wrong when typing a column or
 * table name: word separators (`_`, spaces, hyphens, camelCase boundaries), the position
 * of the typed fragment within the name, and small spelling mistakes.
 *
 * `score` returns a higher number for a better match and a negative number for no match,
 * so callers can both filter (score >= 0) and rank (sort by score descending).
 */

/** Collapses separators so "created_at", "created at" and "createdAt" all normalise alike. */
function normalize(s: string): string {
    return s.toLowerCase().replace(/[\s_\-.]+/g, '');
}

/** Splits an identifier into its words: on separators and camelCase boundaries. */
function tokens(s: string): string[] {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[\s_\-.]+/)
        .map(t => t.toLowerCase())
        .filter(Boolean);
}

/** Whether every character of `q` appears in `t` in order (gaps allowed). */
function isSubsequence(q: string, t: string): boolean {
    let i = 0;
    for (let j = 0; j < t.length && i < q.length; j++) {
        if (t[j] === q[i]) { i++; }
    }
    return i === q.length;
}

/** Standard Levenshtein edit distance, bounded early once it exceeds `max`. */
function levenshtein(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) { return max + 1; }
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            cur.push(v);
            if (v < rowMin) { rowMin = v; }
        }
        if (rowMin > max) { return max + 1; } // whole row already over budget
        prev = cur;
    }
    return prev[b.length];
}

/** How many typos to forgive for a query of the given length. */
function maxEdits(len: number): number {
    if (len <= 3) { return 1; }
    if (len <= 6) { return 2; }
    return 3;
}

/**
 * Scores `query` against `target`. Ranking, best to worst:
 *   exact/prefix > substring > word-prefix > subsequence > typo-tolerant.
 * Returns a negative number when there is no reasonable match.
 */
export function score(query: string, target: string): number {
    const q = normalize(query);
    if (!q) { return 0; } // empty query matches everything (neutral score)
    const t = normalize(target);
    if (!t) { return -1; }

    if (t === q) { return 1000; }
    if (t.startsWith(q)) { return 900 - (t.length - q.length); }

    const idx = t.indexOf(q);
    if (idx >= 0) { return 800 - idx - (t.length - q.length) * 0.1; }

    // a word within the name that starts with the query — matches "position of the word"
    for (const word of tokens(target)) {
        if (word.startsWith(q)) { return 700 - word.length; }
    }

    if (isSubsequence(q, t)) { return 500 - (t.length - q.length); }

    // typo tolerance: against the whole name and against its best single word
    const budget = maxEdits(q.length);
    let best = levenshtein(q, t, budget);
    for (const word of tokens(target)) {
        best = Math.min(best, levenshtein(q, word, budget));
        if (best === 0) { break; }
    }
    if (best <= budget) { return 300 - best * 50; }

    return -1;
}

export interface Scored<T> { item: T; score: number; }

/**
 * Filters and ranks `items` by fuzzy match of `query` against `key(item)`. An empty
 * query returns every item in its original order.
 */
export function fuzzyRank<T>(query: string, items: readonly T[], key: (item: T) => string): T[] {
    if (!query.trim()) { return [...items]; }
    const scored: Scored<T>[] = [];
    for (const item of items) {
        const s = score(query, key(item));
        if (s >= 0) { scored.push({ item, score: s }); }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.item);
}

/** Convenience predicate: does `query` match `target` at all? */
export function matches(query: string, target: string): boolean {
    return score(query, target) >= 0;
}
