// In-app updates (the Android app, bridge 4). The app looks for a newer release by itself and
// tells the page where it stands: none, available, downloading (progress 0..1) or installing.
// The page shows the button on Home and asks the app to start; a failure is said with one toast.

import { native, nativeCall, nativeJson, onNative, bridgeVersion } from './native.js';
import { clamp, APP_VERSION } from './util.js';
import { toast } from '../components/toast.js';

/**
 * Is this page older than the installed app? Right after an update the service worker still
 * serves the page it kept from before; the new one then replaces it as soon as it is in.
 */
export function olderThanApp(appVersion = native ? nativeCall('appVersion') : undefined, pageVersion = APP_VERSION) {
  return typeof appVersion === 'string' && appVersion !== '' && appVersion !== pageVersion;
}

/**
 * Whether a new version of the page may replace this one now (app.js). Never while it would cut
 * something open, an upload, a source being added (its naming step lives in this page) or music
 * the page plays itself. A hidden page goes. A visible one goes only when it is older than the
 * app, and not while the way in is up, a code from #aggiungi= waits to be used, or the person is
 * busy on the page.
 */
export function mayReload({ hidden = false, behind = false, layers = false, uploading = false, adding = false, playingHere = false, wayIn = false, code = false, busy = false } = {}) {
  if (layers || uploading || adding || playingHere) return false;
  return hidden || (behind && !wayIn && !code && !busy);
}

const STATES = ['none', 'available', 'downloading', 'installing'];

/** Length of the button's ring (r 9.2) and the offset of its arc for a progress 0..1. */
export const RING = 57.81;
export const ringOffset = (p) => Math.round(RING * (1 - clamp(Number(p) || 0, 0, 1)) * 100) / 100;

let st = { state: 'none', versionName: '', progress: 0 };
const listeners = new Set();

function take(m) {
  if (!m || !STATES.includes(m.state)) return;
  const next = { state: m.state, versionName: typeof m.versionName === 'string' ? m.versionName : '', progress: clamp(Number(m.progress) || 0, 0, 1) };
  if (next.state === st.state && next.versionName === st.versionName && next.progress === st.progress) return;
  st = next;
  for (const fn of listeners) {
    try {
      fn(st);
    } catch (err) {
      console.error('updates listener', err);
    }
  }
}

export const updates = {
  get state() {
    return st;
  },
  init() {
    if (!native || bridgeVersion() < 4) return;
    take(nativeJson('getUpdate'));
    onNative('update', (m) => {
      take(m);
      if (m.failed === true) toast('Aggiornamento non riuscito');
    });
  },
  /** Only from "available": while it downloads or installs a tap does nothing. */
  start() {
    if (st.state === 'available') nativeCall('startUpdate');
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
