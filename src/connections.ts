import * as vscode from 'vscode';

const NAMES_KEY = 'pgnet.connectionNames';

/** Connection names live in globalState; connection strings live in SecretStorage. */
export class ConnectionStore {
    constructor(private readonly ctx: vscode.ExtensionContext) {}

    names(): string[] {
        return this.ctx.globalState.get<string[]>(NAMES_KEY, []);
    }

    async get(name: string): Promise<string | undefined> {
        return this.ctx.secrets.get(`pgnet.conn.${name}`);
    }

    async add(name: string, connStr: string): Promise<void> {
        await this.ctx.secrets.store(`pgnet.conn.${name}`, connStr);
        const names = this.names();
        if (!names.includes(name)) {
            await this.ctx.globalState.update(NAMES_KEY, [...names, name]);
        }
    }

    async remove(name: string): Promise<void> {
        await this.ctx.secrets.delete(`pgnet.conn.${name}`);
        await this.ctx.globalState.update(NAMES_KEY, this.names().filter(n => n !== name));
    }
}
