/** Per-engine differences the UI needs to know about. */
export type ProviderId = 'postgres' | 'clickhouse';

/** Which catalog call a tree folder maps to, independent of its display label. */
export type FolderKind = 'tables' | 'views' | 'routines' | 'types';

export interface FolderSpec {
    label: string;
    kind: FolderKind;
}

export interface ProviderInfo {
    id: ProviderId;
    label: string;
    /** Placeholder shown when asking for a connection string. */
    example: string;
    folders: readonly FolderSpec[];
    /** PL/pgSQL debugging and routine invocation are Postgres-only. */
    supportsDebug: boolean;
    supportsRunRoutine: boolean;
    quote: '"' | '`';
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
    postgres: {
        id: 'postgres',
        label: 'PostgreSQL',
        example: 'Host=localhost;Port=5432;Database=mydb;Username=postgres;Password=...',
        folders: [
            { label: 'Tables', kind: 'tables' },
            { label: 'Views', kind: 'views' },
            { label: 'Routines', kind: 'routines' },
            { label: 'Data Types', kind: 'types' },
        ],
        supportsDebug: true,
        supportsRunRoutine: true,
        quote: '"',
    },
    clickhouse: {
        id: 'clickhouse',
        label: 'ClickHouse',
        // the worker talks to ClickHouse over HTTP(S), so no driver install is needed
        example: 'Host=localhost;Port=8123;Database=default;Username=default;Password=...;Protocol=http',
        folders: [
            { label: 'Tables', kind: 'tables' },
            { label: 'Views', kind: 'views' },
            // ClickHouse UDFs are cluster-wide, and there are no user-defined named types
            { label: 'Functions', kind: 'routines' },
        ],
        supportsDebug: false,
        supportsRunRoutine: false,
        quote: '`',
    },
};

export function providerInfo(id: ProviderId | undefined): ProviderInfo {
    return PROVIDERS[id ?? 'postgres'] ?? PROVIDERS.postgres;
}

export function isProviderId(v: string): v is ProviderId {
    return v === 'postgres' || v === 'clickhouse';
}

/** Quotes an identifier the way the given engine expects. */
export function quoteIdent(provider: ProviderId | undefined, name: string): string {
    const q = providerInfo(provider).quote;
    return q === '`' ? `\`${name.replace(/`/g, '\\`')}\`` : `"${name.replace(/"/g, '""')}"`;
}

/**
 * Builds a semicolon-delimited key=value connection string, quoting values that
 * contain a delimiter (the Npgsql convention, which the worker's parser mirrors).
 */
export function buildConnectionString(parts: Record<string, string | undefined>): string {
    return Object.entries(parts)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${quoteValue(v!)}`)
        .join(';');
}

function quoteValue(v: string): string {
    return /[;="']/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Parses a connection string back into its parts, honouring the same quoting
 * buildConnectionString emits. Keys keep their original spelling.
 */
export function parseConnectionString(connStr: string): Map<string, string> {
    const out = new Map<string, string>();
    let i = 0;
    while (i < connStr.length) {
        const eq = connStr.indexOf('=', i);
        if (eq < 0) { break; }
        const key = connStr.slice(i, eq).trim();
        i = eq + 1;
        while (connStr[i] === ' ') { i++; }
        let value: string;
        const quote = connStr[i];
        if (quote === '"' || quote === "'") {
            i++;
            let buf = '';
            while (i < connStr.length) {
                if (connStr[i] === quote) {
                    if (connStr[i + 1] === quote) { buf += quote; i += 2; continue; }
                    i++; break;
                }
                buf += connStr[i++];
            }
            value = buf;
            const semi = connStr.indexOf(';', i);
            i = semi < 0 ? connStr.length : semi + 1;
        } else {
            const semi = connStr.indexOf(';', i);
            const end = semi < 0 ? connStr.length : semi;
            value = connStr.slice(i, end).trim();
            i = semi < 0 ? connStr.length : semi + 1;
        }
        if (key) { out.set(key, value); }
    }
    return out;
}

/** Reads a value by any of its accepted spellings. */
export function connectionValue(connStr: string, ...keys: string[]): string | undefined {
    const parsed = parseConnectionString(connStr);
    for (const [k, v] of parsed) {
        if (keys.some(want => want.toLowerCase() === k.toLowerCase()) && v !== '') { return v; }
    }
    return undefined;
}

/** Returns connStr with the username/password replaced, preserving every other setting. */
export function withCredentials(connStr: string, username: string, password: string): string {
    const parsed = parseConnectionString(connStr);
    for (const key of [...parsed.keys()]) {
        if (/^(username|user|uid|password|pwd)$/i.test(key)) { parsed.delete(key); }
    }
    const parts: Record<string, string> = {};
    for (const [k, v] of parsed) { parts[k] = v; }
    parts.Username = username;
    if (password) { parts.Password = password; }
    return buildConnectionString(parts);
}

/** True when a connection string carries no password, so connecting will likely fail. */
export function needsPassword(connStr: string): boolean {
    return connectionValue(connStr, 'Password', 'Pwd') === undefined;
}

/**
 * Canonical spelling for the aliases the various tools emit — DBeaver, ADO.NET and
 * Npgsql all accept different names for the same setting (`server`/`host`,
 * `uid`/`user`, `pwd`/`password`). Unrecognised keys are preserved untouched.
 */
const KEY_ALIASES: Record<string, string> = {
    host: 'Host', server: 'Host', 'data source': 'Host',
    port: 'Port',
    database: 'Database', db: 'Database', 'initial catalog': 'Database',
    username: 'Username', user: 'Username', 'user id': 'Username', userid: 'Username', uid: 'Username',
    password: 'Password', pwd: 'Password', psw: 'Password',
    protocol: 'Protocol', scheme: 'Protocol',
    sslmode: 'SSL Mode', 'ssl mode': 'SSL Mode',
};

function canonicalKey(key: string): string {
    return KEY_ALIASES[key.trim().toLowerCase()] ?? key.trim();
}

/** Rewrites a connection string with canonical key names, keeping every value. */
export function normalizeConnectionString(connStr: string): string {
    const parts: Record<string, string> = {};
    for (const [k, v] of parseConnectionString(connStr)) { parts[canonicalKey(k)] = v; }
    return buildConnectionString(parts);
}

/**
 * Overlays `override` onto `base`, matching settings by canonical name so a pasted
 * `uid=...` replaces an existing `Username=...` instead of sitting beside it.
 */
export function mergeConnectionStrings(base: string, override: string): string {
    const parts: Record<string, string> = {};
    for (const [k, v] of parseConnectionString(base)) { parts[canonicalKey(k)] = v; }
    for (const [k, v] of parseConnectionString(override)) { parts[canonicalKey(k)] = v; }
    return buildConnectionString(parts);
}

/** True when text looks like a connection string rather than a bare username. */
export function looksLikeConnectionString(text: string): boolean {
    const t = text.trim();
    return t.includes('=') && (t.includes(';') || /\b(pwd|password|host|server)\s*=/i.test(t));
}

/** The named inputs the connection editor dialog shows; `others` holds leftover key=value pairs. */
export interface ConnectionFields {
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    protocol: string;
    sslMode: string;
    others: string;
}

const NAMED_FIELD_KEYS = new Set(['Host', 'Port', 'Database', 'Username', 'Password', 'Protocol', 'SSL Mode']);

/** Splits a connection string into the editor's named fields plus an "everything else" remainder. */
export function fieldsFromConnectionString(connStr: string): ConnectionFields {
    const parts: Record<string, string> = {};
    for (const [k, v] of parseConnectionString(connStr)) { parts[canonicalKey(k)] = v; }
    const others = Object.entries(parts)
        .filter(([k]) => !NAMED_FIELD_KEYS.has(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
    return {
        host: parts.Host ?? '',
        port: parts.Port ?? '',
        database: parts.Database ?? '',
        username: parts.Username ?? '',
        password: parts.Password ?? '',
        protocol: parts.Protocol ?? '',
        sslMode: parts['SSL Mode'] ?? '',
        others,
    };
}

/** Rebuilds a connection string from editor fields; named fields win over strays in `others`. */
export function connectionStringFromFields(f: ConnectionFields): string {
    const parts: Record<string, string> = {};
    for (const [k, v] of parseConnectionString(f.others ?? '')) { parts[canonicalKey(k)] = v; }
    const named: Record<string, string> = {
        Host: f.host, Port: f.port, Database: f.database, Username: f.username,
        Password: f.password, Protocol: f.protocol, 'SSL Mode': f.sslMode,
    };
    for (const [k, v] of Object.entries(named)) {
        const t = (v ?? '').trim();
        if (t) { parts[k] = t; } else { delete parts[k]; }
    }
    return buildConnectionString(parts);
}
