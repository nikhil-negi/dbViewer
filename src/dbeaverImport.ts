import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProviderId, buildConnectionString } from './providers';

/**
 * Reads DBeaver's workspace configuration and turns its data sources into PGNet
 * connections.
 *
 * DBeaver keeps connections in `<workspace>/<project>/.dbeaver/data-sources.json`
 * and, when "save password" is on, credentials in `credentials-config.json` next to
 * it. That file is AES-128-CBC encrypted with a key that is hard-coded in DBeaver
 * itself (it is local obfuscation, not a secret between us and the user), so their
 * own passwords can be carried over instead of retyped.
 */

const DBEAVER_LOCAL_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');
const ZERO_IV = Buffer.alloc(16);

/** DBeaver provider/driver ids we can drive, mapped to ours. */
const PROVIDER_MAP: Record<string, ProviderId> = {
    postgresql: 'postgres',
    postgres: 'postgres',
    clickhouse: 'clickhouse',
};

export interface DbeaverConnection {
    id: string;
    name: string;
    provider: ProviderId;
    host: string;
    port: string;
    database: string;
    user?: string;
    password?: string;
    /** Source file, shown in the picker so multi-project workspaces stay legible. */
    origin: string;
    connectionString: string;
}

/** A DBeaver script file and the connection it was last used with. */
export interface DbeaverBinding {
    file: string;
    connection: string;
}

export interface DbeaverScan {
    connections: DbeaverConnection[];
    /** Per-script connection bindings from project-metadata.json. */
    bindings: DbeaverBinding[];
    /** Data sources found but not importable, with the reason. */
    skipped: { name: string; reason: string }[];
    /** Config files that were read. */
    sources: string[];
    /** True when a credentials file was present but could not be decrypted. */
    credentialsUnreadable: boolean;
}

/** Candidate DBeaver workspace roots, newest layout first. */
export function workspaceRoots(): string[] {
    const home = os.homedir();
    const env = process.env.DBEAVER_WORKSPACE;
    const roots = [
        ...(env ? [env] : []),
        path.join(home, '.local', 'share', 'DBeaverData'),
        path.join(home, '.var', 'app', 'io.dbeaver.DBeaverCommunity', 'data', 'DBeaverData'),
        path.join(home, 'snap', 'dbeaver-ce', 'current', '.local', 'share', 'DBeaverData'),
        path.join(home, 'Library', 'DBeaverData'),                          // macOS
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'DBeaverData')] : []),
        path.join(home, 'DBeaverData'),
    ];
    return [...new Set(roots)];
}

async function exists(file: string): Promise<boolean> {
    try { await fs.stat(file); return true; } catch { return false; }
}

async function readJson(file: string): Promise<any | undefined> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return undefined;
    }
}

/** Finds every `.dbeaver/data-sources.json` under the known workspace roots. */
async function findConfigFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const root of workspaceRoots()) {
        if (!await exists(root)) { continue; }
        // DBeaverData/workspace6/<project>/.dbeaver/data-sources.json — and older
        // layouts where the workspace root is passed directly
        for (const workspace of await childDirs(root, /^workspace/)) {
            for (const project of await childDirs(workspace)) {
                const file = path.join(project, '.dbeaver', 'data-sources.json');
                if (await exists(file)) { found.push(file); }
            }
        }
        for (const project of await childDirs(root)) {
            const file = path.join(project, '.dbeaver', 'data-sources.json');
            if (await exists(file)) { found.push(file); }
        }
    }
    return [...new Set(found)];
}

async function childDirs(dir: string, match?: RegExp): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.metadata') &&
                         (!match || match.test(e.name)))
            .map(e => path.join(dir, e.name));
    } catch {
        return [];
    }
}

/**
 * Decrypts DBeaver's credentials file. It is AES-128-CBC with a fixed key that
 * ships inside DBeaver (local obfuscation, not a secret between us and the user)
 * and an all-zero IV. DBeaver prefixes the plaintext with one random 16-byte block,
 * so the first decrypted block is discarded and the JSON begins after it.
 */
export function decryptCredentials(raw: Buffer): Record<string, any> | undefined {
    const asText = tryParse(raw.toString('utf8'));
    if (asText) { return asText; } // secure storage disabled: the file is plain JSON

    if (raw.length <= 16) { return undefined; }
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', DBEAVER_LOCAL_KEY, ZERO_IV);
        const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
        // drop the random leading block; the remainder is the credentials JSON
        return tryParse(plain.subarray(16).toString('utf8'));
    } catch {
        return undefined;
    }
}

/** Parses JSON that may be surrounded by junk bytes from the encryption framing. */
function tryParse(text: string): Record<string, any> | undefined {
    const start = text.indexOf('{');
    if (start < 0) { return undefined; }
    const end = text.lastIndexOf('}');
    if (end <= start) { return undefined; }
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        return value && typeof value === 'object' ? value : undefined;
    } catch {
        return undefined;
    }
}

/** `jdbc:postgresql://host:5432/db?x=y` / `jdbc:clickhouse://host:8443/db` */
function parseJdbcUrl(url: string | undefined): { host?: string; port?: string; database?: string; secure?: boolean } {
    if (!url) { return {}; }
    const m = /^jdbc:[^:]+:(?:\/\/)?(?:(https?):\/\/)?([^:/?;]+)(?::(\d+))?(?:\/([^?;]*))?/i.exec(url);
    if (!m) { return {}; }
    return {
        host: m[2],
        port: m[3],
        database: m[4] || undefined,
        secure: m[1]?.toLowerCase() === 'https' || /ssl=true|sslmode=require/i.test(url),
    };
}

/** Reads every DBeaver config we can find and maps the data sources we support. */
export async function scanDbeaver(): Promise<DbeaverScan> {
    const result: DbeaverScan = {
        connections: [], bindings: [], skipped: [], sources: [], credentialsUnreadable: false,
    };

    for (const file of await findConfigFiles()) {
        const config = await readJson(file);
        const sources = config?.connections;
        if (!sources || typeof sources !== 'object') { continue; }
        result.sources.push(file);

        let credentials: Record<string, any> = {};
        const credFile = path.join(path.dirname(file), 'credentials-config.json');
        if (await exists(credFile)) {
            const decrypted = decryptCredentials(await fs.readFile(credFile));
            if (decrypted) { credentials = decrypted; }
            else { result.credentialsUnreadable = true; }
        }

        for (const [id, ds] of Object.entries<any>(sources)) {
            const name = ds?.name ?? id;
            const provider = PROVIDER_MAP[String(ds?.provider ?? '').toLowerCase()];
            if (!provider) {
                result.skipped.push({ name, reason: `${ds?.provider ?? 'unknown'} is not supported yet` });
                continue;
            }
            const cfg = ds.configuration ?? {};
            const fromUrl = parseJdbcUrl(cfg.url);
            const host = cfg.host || fromUrl.host;
            if (!host) {
                result.skipped.push({ name, reason: 'no host in the DBeaver configuration' });
                continue;
            }
            const creds = credentials[id]?.['#connection'] ?? {};
            const secure = String(cfg.properties?.ssl ?? '') === 'true' ||
                String(cfg['provider-properties']?.ssl ?? '') === 'true' ||
                fromUrl.secure === true;
            const port = String(cfg.port || fromUrl.port || defaultPort(provider, secure));
            const database = cfg.database || fromUrl.database ||
                (provider === 'clickhouse' ? 'default' : 'postgres');

            result.connections.push({
                id,
                name,
                provider,
                host,
                port,
                database,
                user: creds.user,
                password: creds.password,
                origin: file,
                connectionString: buildConnectionString({
                    Host: host,
                    Port: port,
                    Database: database,
                    Username: creds.user,
                    Password: creds.password,
                    ...(provider === 'clickhouse'
                        ? { Protocol: secure || port === '8443' ? 'https' : 'http' }
                        : secure ? { 'SSL Mode': 'Require' } : {}),
                }),
            });
        }

        result.bindings.push(...await readScriptBindings(file, sources));
    }
    return result;
}

/**
 * DBeaver remembers which data source each script in the project was last run
 * against (`project-metadata.json`), which is the same idea as our per-file
 * connection context — so those bindings can come across with the connections.
 */
async function readScriptBindings(
    configFile: string, sources: Record<string, any>,
): Promise<DbeaverBinding[]> {
    const dbeaverDir = path.dirname(configFile);
    const projectDir = path.dirname(dbeaverDir);
    const metadata = await readJson(path.join(dbeaverDir, 'project-metadata.json'));
    const resources = metadata?.resources;
    if (!resources || typeof resources !== 'object') { return []; }

    const bindings: DbeaverBinding[] = [];
    for (const [relative, info] of Object.entries<any>(resources)) {
        const name = sources[info?.['default-datasource']]?.name;
        if (!name) { continue; }                       // data source since deleted
        const file = path.join(projectDir, relative);
        if (!await exists(file)) { continue; }         // script since deleted
        bindings.push({ file, connection: name });
    }
    return bindings;
}

export function defaultPort(provider: ProviderId, secure = false): string {
    if (provider === 'clickhouse') { return secure ? '8443' : '8123'; }
    return '5432';
}
