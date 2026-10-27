import { useEffect, useRef } from 'react';

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

// may be called only once per webview, so it lives at module scope
const api = acquireVsCodeApi();

/** Posts a message to the extension host. Pass the view's message union as T for checking. */
export function postToHost<T>(message: T): void {
    api.postMessage(message);
}

/**
 * Host messages are buffered from the moment this module loads until a listener subscribes.
 * The host may post right after setting the HTML, and React registers effects only after
 * its first render — without the buffer those early messages would be lost.
 */
const pending: unknown[] = [];
let listener: ((message: unknown) => void) | undefined;
window.addEventListener('message', (e: MessageEvent) => {
    if (listener) { listener(e.data); } else { pending.push(e.data); }
});

/** Subscribes to host messages (one subscriber per view); flushes anything buffered first. */
export function useHostMessages<T>(handler: (message: T) => void): void {
    const latest = useRef(handler);
    latest.current = handler;
    useEffect(() => {
        const fn = (m: unknown) => latest.current(m as T);
        listener = fn;
        for (const m of pending.splice(0)) { fn(m); }
        return () => { if (listener === fn) { listener = undefined; } };
    }, []);
}

/** Reads the `init` payload the host embedded in the page (see src/webview/webviewHtml.ts). */
export function readInit<T>(): T {
    return JSON.parse(document.getElementById('init')?.textContent || 'null') as T;
}
