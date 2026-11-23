// Overall reachability, derived from the sources (sources.js polls the client core):
//   'ok'       at least one source is connected (or none is paired yet: nothing to reach)
//   'offline'  the device has no network at all (the app's getNetwork, or navigator.onLine)
//   'sources'  sources are paired but none is connected right now
//   'core'     the local client core itself does not answer (client-node stopped)
// isOnline() is true in the 'ok' state. Per track availability is decided by its own sources.

import { sources } from './sources.js';
import { quality } from './quality.js';

const listeners = new Set();

export function connState() {
  // With no real source there is nothing to reach: the phone's own music plays with no network.
  if (!sources.list.length && sources.phone) return sources.coreOk ? 'ok' : 'core';
  if (quality.networkType() === 'none' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'offline';
  if (!sources.coreOk) return 'core';
  // Before the core's first answer the cached list says nothing about links: no banner yet.
  if (sources.loaded && sources.list.length && !sources.anyUp()) return 'sources';
  return 'ok';
}

export const isOnline = () => connState() === 'ok' && sources.anyUp();

let last = connState();
let lastOnline = isOnline();

export function onConn(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function update() {
  const s = connState();
  const o = isOnline();
  if (s === last && o === lastOnline) return;
  last = s;
  lastOnline = o;
  for (const fn of listeners) {
    try {
      fn(o, s);
    } catch (err) {
      console.error('conn listener', err);
    }
  }
}
sources.subscribe(update);
quality.subscribe(update);
if (typeof window !== 'undefined') {
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}
