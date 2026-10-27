import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ConnectionFields } from '../../src/providers';
import type { EditorForm, EditorFromWebview, EditorLoad, EditorToWebview } from '../../src/webview/protocol';
import { postToHost, useHostMessages } from '../shared/vscode';

const post = (m: EditorFromWebview) => postToHost(m);

const EMPTY: ConnectionFields = {
    host: '', port: '', database: '', username: '', password: '',
    protocol: '', sslMode: '', others: '',
};
const FIELD_KEYS = Object.keys(EMPTY) as (keyof ConnectionFields)[];

interface Status { text: string; kind?: 'ok' | 'err'; }

/**
 * Add/edit form for one connection: labelled inputs per setting, a paste-to-fill bar for
 * whole connection strings, a live preview of the string that will be saved, and Test.
 * Parsing, assembling, testing and saving all happen in the host (src/connectionEditor.ts).
 */
export function ConnectionEditor() {
    const [load, setLoad] = useState<EditorLoad>();
    const [name, setName] = useState('');
    const [provider, setProvider] = useState('postgres');
    const [fields, setFields] = useState<ConnectionFields>(EMPTY);
    const [paste, setPaste] = useState('');
    const [showPw, setShowPw] = useState(false);
    const [connstr, setConnstr] = useState('');
    const [status, setStatus] = useState<Status>({ text: '' });
    const [testing, setTesting] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);
    const hostRef = useRef<HTMLInputElement>(null);
    const pwRef = useRef<HTMLInputElement>(null);

    useHostMessages<EditorToWebview>(m => {
        switch (m.type) {
            case 'load':
                setLoad(m);
                setName(m.name);
                setProvider(m.provider);
                setFields({ ...EMPTY, ...m.fields });
                setPaste('');
                setShowPw(false);
                setTesting(false);
                setStatus({ text: '' });
                break;
            case 'fill':
                // only overwrite what the pasted string actually set
                setFields(f => {
                    const next = { ...f };
                    for (const k of FIELD_KEYS) { if (m.fields[k]) { next[k] = m.fields[k]; } }
                    return next;
                });
                if (m.provider) { setProvider(m.provider); }
                setStatus({ text: 'Form filled from the pasted string.', kind: 'ok' });
                break;
            case 'connstr':
                setConnstr(m.value);
                break;
            case 'testResult':
                setTesting(false);
                setStatus({ text: m.message, kind: m.success ? 'ok' : 'err' });
                break;
            case 'saveResult':
                setStatus({ text: m.message, kind: m.success ? 'ok' : 'err' });
                break;
        }
    });

    useEffect(() => { post({ type: 'ready' }); }, []);

    // each load (including the next one in a queue) focuses the first editable field
    useEffect(() => {
        if (load) { (load.mode === 'edit' ? hostRef : nameRef).current?.focus(); }
    }, [load]);

    const form = (): EditorForm => ({ ...fields, name, provider });

    // live preview: the host assembles the exact string that would be saved
    useEffect(() => {
        if (load) { post({ type: 'preview', form: form() }); }
    }, [load, name, provider, fields]);

    const mode = load?.mode ?? 'add';
    const ch = provider === 'clickhouse';
    const nameTaken = mode === 'add' && (load?.existingNames ?? []).includes(name.trim());
    const setField = (k: keyof ConnectionFields) =>
        (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
            const value = e.target.value;
            setFields(f => ({ ...f, [k]: value }));
        };
    const fill = () => post({ type: 'parse', text: paste });

    return (
        <div className="card">
            <h2>
                {mode === 'add'
                    ? 'New Connection'
                    : `Edit Connection — ${load?.name}${load?.progress ? `  (${load.progress})` : ''}`}
            </h2>
            <div className="subtitle">
                {mode === 'add'
                    ? 'Fill in the server details, or paste a connection string below.'
                    : 'Update the details for this connection, or paste a connection string below.'}
            </div>

            <div className="pastebar">
                <input
                    value={paste}
                    onChange={e => setPaste(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { fill(); } }}
                    placeholder="host=...;port=...;database=...;uid=...;pwd=...   (paste to fill the form)"
                />
                <button className="secondary" onClick={fill}>Fill</button>
            </div>

            <div className="grid">
                <label htmlFor="name">Name <span className="req">*</span></label>
                <input id="name" ref={nameRef} value={name} disabled={mode === 'edit'}
                    onChange={e => setName(e.target.value)} placeholder="local-dev" />
                {nameTaken && (
                    <div className="name-warn">A connection with this name exists — saving will overwrite it.</div>
                )}

                <label htmlFor="provider">Database type</label>
                <select id="provider" value={provider} onChange={e => setProvider(e.target.value)}>
                    {(load?.providers ?? []).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>

                <div className="rule" />

                <label htmlFor="host">Host <span className="req">*</span></label>
                <input id="host" ref={hostRef} value={fields.host} onChange={setField('host')} placeholder="localhost" />

                <label htmlFor="port">Port</label>
                <input id="port" value={fields.port} onChange={setField('port')}
                    placeholder={ch ? (fields.protocol === 'https' ? '8443' : '8123') : '5432'} />

                <label htmlFor="database">Database</label>
                <input id="database" value={fields.database} onChange={setField('database')}
                    placeholder={ch ? 'default' : 'postgres'} />

                <label htmlFor="username">Username</label>
                <input id="username" value={fields.username} onChange={setField('username')}
                    placeholder={ch ? 'default' : 'postgres'} />

                <label htmlFor="password">Password</label>
                <div className="pwwrap">
                    <input id="password" ref={pwRef} type={showPw ? 'text' : 'password'} autoComplete="off"
                        value={fields.password} onChange={setField('password')} />
                    <button type="button" className={`reveal${showPw ? ' on' : ''}`}
                        title="Show/hide password" aria-label="Show or hide password"
                        onClick={() => { setShowPw(s => !s); pwRef.current?.focus(); }}>👁</button>
                </div>

                {ch ? (
                    <>
                        <label htmlFor="protocol">Protocol</label>
                        <select id="protocol" value={fields.protocol} onChange={setField('protocol')}>
                            <option value="">Auto (https on port 443/8443, else http)</option>
                            <option value="http">http</option>
                            <option value="https">https</option>
                        </select>
                    </>
                ) : (
                    <>
                        <label htmlFor="sslMode">SSL mode</label>
                        <select id="sslMode" value={fields.sslMode} onChange={setField('sslMode')}>
                            <option value="">server default</option>
                            <option value="Require">Require</option>
                            <option value="Prefer">Prefer</option>
                            <option value="Disable">Disable</option>
                        </select>
                    </>
                )}

                <label htmlFor="others">Other options</label>
                <input id="others" value={fields.others} onChange={setField('others')}
                    placeholder="key=value;key2=value2  (optional)" />
            </div>

            <div className="connstr">
                <div className="connstr-head">
                    <label htmlFor="connstr">Connection string</label>
                    <button type="button" className="secondary tiny"
                        onClick={() => navigator.clipboard?.writeText(connstr).then(
                            () => setStatus({ text: 'Connection string copied.', kind: 'ok' }), () => {})}>
                        Copy
                    </button>
                </div>
                <textarea id="connstr" readOnly rows={2} spellCheck={false} value={connstr}
                    title="The exact connection string that will be saved (includes the password)" />
            </div>

            <div className="actions">
                <button className="secondary" disabled={testing} onClick={() => {
                    setStatus({ text: 'Testing connection…' });
                    setTesting(true);
                    post({ type: 'test', form: form() });
                }}>Test Connection</button>
                <div className="spacer" />
                <button className="secondary" onClick={() => post({ type: 'cancel' })}>
                    {load?.inQueue ? 'Skip' : 'Cancel'}
                </button>
                <button className="primary" onClick={() => post({ type: 'save', form: form() })}>Save</button>
            </div>
            <div className={`status ${status.kind ?? ''}`}>{status.text}</div>
        </div>
    );
}
