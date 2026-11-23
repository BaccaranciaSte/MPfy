// Bridge with the Android app. window.MPfyNative exists only inside the app's WebView; every
// argument we pass is a string. The app talks back by calling window.__mpfyNative(msg), msg being
// a JSON string or an object, with { type: 'state' | 'downloads' | 'network' | 'error' |
// 'folder' | 'profileFile' | 'profileFileState' | 'storage' | 'update' | 'liked' | 'scanned', ... }. openExternal(url) opens an
// https:// link in the system browser (the WebView itself never leaves 127.0.0.1).

export const native = typeof window !== 'undefined' && window.MPfyNative ? window.MPfyNative : null;

const handlers = new Map();
const last = new Map();

window.__mpfyNative = (msg) => {
  let m = msg;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return;
    }
  }
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
  last.set(m.type, m);
  for (const fn of handlers.get(m.type) || []) {
    try {
      fn(m);
    } catch (err) {
      console.error('native handler', err);
    }
  }
};

/** Subscribe to one message type. With replay, the last message of that type is delivered now. */
export function onNative(type, fn, { replay = false } = {}) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  if (replay && last.has(type)) fn(last.get(type));
  return () => handlers.get(type).delete(fn);
}

/** Calls a bridge method with string arguments. Returns its result, or undefined on failure. */
export function nativeCall(name, ...args) {
  if (!native || typeof native[name] !== 'function') return undefined;
  try {
    return native[name](...args.map((a) => (typeof a === 'string' ? a : String(a))));
  } catch (err) {
    console.warn(`MPfyNative.${name} failed`, err);
    return undefined;
  }
}

let version = null;
/**
 * 7 for an app that keeps the car's library in pages (setBrowsePage, setBrowseIndex,
 * getBrowsePages); 6 for an app that tells of new messages (its notification, "Notifiche dei messaggi"); 5 for an
 * app whose own player tells the core what plays (the page does not); 4 with updates,
 * the heart in the notification and the car; 3 with versions, folders, the profile file and
 * Memoria; 2 for an older one; 0 in a browser. Always a number: compared as one.
 */
export function bridgeVersion() {
  if (version == null) version = !native ? 0 : Number(nativeCall('bridgeVersion')) || 2;
  return version;
}

/** Calls a bridge method that returns a JSON string and parses it. */
export function nativeJson(name, ...args) {
  const raw = nativeCall(name, ...args);
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Whether the app has the QR scanner (a method of the bridge, not a version of it). */
export const canScan = () => !!native && typeof native.scanCode === 'function';

/**
 * The app's QR scanner, full screen. Resolves { state: 'ok', text } with the text of a code of
 * ours, or { state: 'cancel' | 'denied' | 'error' }.
 */
export function scanCode() {
  return new Promise((resolve) => {
    const rid = nativeCall('scanCode');
    if (typeof rid !== 'string' || !rid) {
      resolve({ state: 'error' });
      return;
    }
    const off = onNative('scanned', (m) => {
      if (m.requestId !== rid) return;
      off();
      resolve(m.state === 'ok' && typeof m.text === 'string' ? { state: 'ok', text: m.text } : { state: m.state || 'cancel' });
    });
  });
}
