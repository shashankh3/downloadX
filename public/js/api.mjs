'use strict';
/*
 * REST + SSE client for the local downloadX server.
 * The server exposes everything the UI can do over /api/*.
 */

/** Call the local API. Throws an Error with the server message on failure. */
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/**
 * Subscribe to the live snapshot stream.
 * Reconnects with an exponential back-off; `onStatus` reports the connection
 * state so the status bar can show it.
 */
export function connect({ onSnapshot, onStatus }) {
  let retryDelay = 1000;
  let source = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = new EventSource('/api/events');
    source.addEventListener('snapshot', (e) => {
      retryDelay = 1000;
      try { onSnapshot(JSON.parse(e.data)); } catch { /* partial frame */ }
    });
    source.onerror = () => {
      if (closed) return;
      if (onStatus) onStatus('reconnecting');
      try { source.close(); } catch { /* already closed */ }
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };
  };

  open();
  return () => { closed = true; try { source && source.close(); } catch { /* ignore */ } };
}
