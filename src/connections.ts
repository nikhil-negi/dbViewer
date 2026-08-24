import * as vscode from 'vscode';
import { ProviderId, isProviderId } from './providers';

const LEGACY_NAMES_KEY = 'dbviewer.connectionNames';
const CONNECTIONS_KEY = 'dbviewer.connections';

export interface ConnectionMeta {
    name: string;
    provider: ProviderId;
}

/**
 * Connection names and their provider live in globalState; connection strings live
 * in SecretStorage. Entries saved before multi-engine support are read as Postgres.
 */
export class ConnectionStore {
    constructor(private readonly ctx: vscode.ExtensionContext) {}

    list(): ConnectionMeta[] {
        const stored = this.ctx.globalState.get<ConnectionMeta[]>(CONNECTIONS_KEY);
        if (stored) {
            return stored.map(c => ({
                name: c.name,
                provider: isProviderId(c.provider) ? c.provider : 'postgres',
            }));
        }
        return this.ctx.globalState.get<string[]>(LEGACY_NAMES_KEY, [])
            .map(name => ({ name, provider: 'postgres' as ProviderId }));
    }

    names(): string[] {
        return this.list().map(c => c.name);
    }

    has(name: string): boolean {
        return this.list().some(c => c.name === name);
    }

    provider(name: string): ProviderId {
        return this.list().find(c => c.name === name)?.provider ?? 'postgres';
    }

    async get(name: string): Promise<string | undefined> {
        return this.ctx.secrets.get(`dbviewer.conn.${name}`);
    }

    /** Resolves both halves at once, since almost every call site needs the pair. */
    async resolve(name: string): Promise<{ provider: ProviderId; connStr: string } | undefined> {
        const connStr = await this.get(name);
        return connStr ? { provider: this.provider(name), connStr } : undefined;
    }

    async add(name: string, connStr: string, provider: ProviderId = 'postgres'): Promise<void> {
        await this.ctx.secrets.store(`dbviewer.conn.${name}`, connStr);
        const others = this.list().filter(c => c.name !== name);
        await this.save([...others, { name, provider }]);
    }

    async remove(name: string): Promise<void> {
        await this.ctx.secrets.delete(`dbviewer.conn.${name}`);
        await this.save(this.list().filter(c => c.name !== name));
    }

    private async save(connections: ConnectionMeta[]): Promise<void> {
        await this.ctx.globalState.update(CONNECTIONS_KEY, connections);
        // keep the legacy key in step so a downgrade still finds the names
        await this.ctx.globalState.update(LEGACY_NAMES_KEY, connections.map(c => c.name));
    }
}
