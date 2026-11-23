// The person using this device, as the local core keeps it: the profile (name, photo, code), its
// file and the optional password recovery. GET /local/profile answers { profile, recovery,
// fileName }; a core without profiles answers 404 and the app works as before (supported: false).
// The photo is a JPEG the page makes (320 x 320, at most 48 KB), named by its SHA-256: the page
// shows it as /local/profile/photo?v=<hash>, so a new photo is a new address.
//
// Every call answers like the core does; a failure throws with the core's `code`, and the UI
// words come from that code (words.js), never from the core's text.

import { localRequest } from './sources.js';

let state = { profile: null, recovery: false, fileName: null };
let loaded = false;
let supported = true;
let inflight = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('profile listener', err);
    }
  }
}

const PHOTO_HASH = /^[0-9a-f]{64}$/;

function apply(data) {
  const p = data?.profile;
  const next = {
    profile:
      p && typeof p.id === 'string'
        ? { id: p.id, name: typeof p.name === 'string' ? p.name : '', nameUpdatedAt: Number(p.nameUpdatedAt) || 0, photo: typeof p.photo === 'string' && PHOTO_HASH.test(p.photo) ? p.photo : null }
        : null,
    recovery: !!data?.recovery,
    fileName: typeof data?.fileName === 'string' ? data.fileName : null,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(state) || !loaded;
  state = next;
  loaded = true;
  if (changed) emit();
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      apply(await localRequest('GET', '/local/profile', undefined, 8000));
      supported = true;
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) {
        supported = false;
        apply(null);
      }
      // Any other failure (the core not answering yet): keep what we know.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Calls that change the identity: the profile is read again afterwards. A read already under way
 * may have left before the change landed: it is let finish and the profile is read once more.
 */
async function change(method, path, body, timeout = 15000) {
  try {
    return await localRequest(method, path, body, timeout);
  } finally {
    if (inflight) await inflight;
    await refresh();
  }
}

export const profile = {
  get loaded() {
    return loaded;
  },
  /** The core knows profiles (false on a core that answers 404). */
  get supported() {
    return supported;
  },
  /** { id, name, nameUpdatedAt, photo } or null; photo is the photo's hash, or null. */
  get data() {
    return state.profile;
  },
  get name() {
    return state.profile?.name || '';
  },
  /** Where the page loads the photo from, or null without one. */
  photoUrl() {
    const hash = state.profile?.photo;
    return hash ? `/local/profile/photo?v=${hash}` : null;
  },
  get recovery() {
    return state.recovery;
  },
  /** The identity file's name ("Bacca.mpfy"), null without a profile. */
  get fileName() {
    return state.fileName;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  refresh,

  create: (name) => change('POST', '/local/profile', { name }),
  rename: (name) => change('PATCH', '/local/profile', { name }),
  /** The photo: a JPEG Blob of 320 x 320, at most 48 KB. */
  setPhoto: (blob) => change('PUT', '/local/profile/photo', blob, 20000),
  removePhoto: () => change('DELETE', '/local/profile/photo', undefined, 15000),
  /** { code: "MPFY-P-..." }: asked only when the person wants to see it. */
  code: () => localRequest('GET', '/local/profile/code', undefined, 8000),
  /** { fileName, identity } */
  exportFile: () => localRequest('GET', '/local/profile/export', undefined, 8000),
  importCode: (code) => change('POST', '/local/profile/import', { code }, 30000),
  importIdentity: (identity) => change('POST', '/local/profile/import', { identity }, 30000),
  /** Argon2id runs in the core: about a second on a phone. */
  enableRecovery: (password) => change('PUT', '/local/profile/recovery', { password }, 60000),
  disableRecovery: () => change('DELETE', '/local/profile/recovery', undefined, 15000),

  // recovery with the password, on a new device: code, then who, then the password
  recoveryStart: (code) => localRequest('POST', '/local/recovery', { code }, 90000),
  recoveryTry: (sessionId, entry, password) =>
    change('POST', `/local/recovery/${encodeURIComponent(sessionId)}`, { profileId: entry.profileId, device: entry.device, password }, 120000),
  recoveryCancel: (sessionId) => localRequest('DELETE', `/local/recovery/${encodeURIComponent(sessionId)}`, undefined, 8000).catch(() => null),
};
