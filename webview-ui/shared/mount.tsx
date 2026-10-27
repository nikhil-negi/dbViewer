import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import './base.css';

/** Renders a view's root component into the shell's #root element. */
export function mount(view: ReactElement): void {
    createRoot(document.getElementById('root')!).render(<StrictMode>{view}</StrictMode>);
}
