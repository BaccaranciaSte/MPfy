// Audio quality: three settings (streaming on Wi-Fi, streaming on mobile
// data, download), each Automatica, Bassa, Normale, Alta or Max, and the "Automatica" decision,
// taken per track when it starts.
//
// Levels on the wire (?q= and X-MPfy-Quality): low (Opus 48 kbps), normal (96), high (160), max
// (the original file). The server serves the closest ready level and says which one it served.

import { native, nativeJson, onNative } from './native.js';
import { sources } from './sources.js';
import { lsGet, lsSet } from './util.js';

const LS_KEY = 'mpfy.quality.v1';
const REBUFFER_WINDOW_MS = 5 * 60 * 1000;

export const LEVELS = ['low', 'normal', 'high', 'max'];

// One line each, in plain words, with the approximate MB per minute.
export const CHOICES = [
  { value: 'auto', label: 'Automatica', desc: 'Si adatta alla rete' },
  { value: 'low', label: 'Bassa', desc: 'Risparmia dati, circa 0,4 MB al minuto' },
  { value: 'normal', label: 'Normale', desc: 'Circa 0,7 MB al minuto' },
  { value: 'high', label: 'Alta', desc: 'Circa 1,2 MB al minuto' },
  { value: 'max', label: 'Max', desc: 'Il file originale, MB secondo il file' },
];

export const KINDS = [
  { key: 'wifi', label: 'Streaming con Wi-Fi' },
  { key: 'cellular', label: 'Streaming con dati mobili' },
  { key: 'download', label: 'Download' },
];

const DEFAULTS = { wifi: 'auto', cellular: 'auto', download: 'max' };
const CHIP = { max: 'MAX', high: 'ALTA', normal: 'NORMALE', low: 'BASSA' };

const isChoice = (v) => CHOICES.some((c) => c.value === v);
let settings = { ...DEFAULTS };
{
  const saved = lsGet(LS_KEY, null);
  if (saved && typeof saved === 'object') for (const k of Object.keys(DEFAULTS)) if (isChoice(saved[k])) settings[k] = saved[k];
}

let net = null; // { type, metered } from the app
let lastRebuffer = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('quality listener', err);
    }
  }
}

const NET_TYPES = ['wifi', 'cellular', 'ethernet', 'none'];
function setNet(m) {
  if (!m || !NET_TYPES.includes(m.type)) return;
  const next = { type: m.type, metered: !!m.metered };
  if (net && net.type === next.type && net.metered === next.metered) return;
  net = next;
  emit();
}

export const quality = {
  get settings() {
    return settings;
  },
  set(kind, value) {
    if (!(kind in DEFAULTS) || !isChoice(value)) return;
    settings = { ...settings, [kind]: value };
    lsSet(LS_KEY, settings);
    emit();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  labelOf: (value) => CHOICES.find((c) => c.value === value)?.label || '',
  /** The text of the Now Playing chip for a served level, or '' when unknown. */
  chip: (level) => CHIP[level] || '',

  /** Starts listening to network changes: the app's bridge, else navigator.connection. */
  init() {
    if (native) {
      setNet(nativeJson('getNetwork'));
      // The event's own "type" is "network", so the network kind cannot sit in "type" there:
      // read the current state with getNetwork() again; fall back to the usual field names.
      onNative(
        'network',
        (m) => {
          const now = nativeJson('getNetwork');
          if (now && NET_TYPES.includes(now.type)) return setNet(now);
          const n = m.network && typeof m.network === 'object' ? m.network : m;
          const t = [n.networkType, n.network, n.kind, n.transport, n.net].find((x) => NET_TYPES.includes(x));
          if (t) setNet({ type: t, metered: n.metered });
          return undefined;
        },
        { replay: true }
      );
    } else if (navigator.connection?.addEventListener) {
      navigator.connection.addEventListener('change', emit);
    }
  },

  /** 'wifi' | 'cellular' | 'ethernet' | 'none'. Without any information: Wi-Fi. */
  networkType() {
    if (net) return net.type;
    const t = typeof navigator !== 'undefined' ? navigator.connection?.type : undefined;
    if (t === 'cellular') return 'cellular';
    if (t === 'ethernet') return 'ethernet';
    if (t === 'none') return 'none';
    return 'wifi';
  },

  /** The player saw the music stall while it was playing (not at a start or after a seek). */
  noteRebuffer() {
    lastRebuffer = Date.now();
  },

  /**
   * The level to ask for a track from a source (or from the best of several). purpose 'stream' uses the Wi-Fi or the mobile
   * data setting by the current network; 'download' uses the download setting.
   * Automatica: on Wi-Fi (and ethernet) max when the source's measured throughput is at least
   * 1.5 times the original bitrate, or not measured yet, otherwise high. On mobile data high with
   * at least 400 kbps and no stall in the last 5 minutes, normal with at least 200, low below;
   * normal while the throughput is not measured yet (the first seconds of a session).
   */
  decide(track, src, purpose = 'stream') {
    const cellular = quality.networkType() === 'cellular';
    const kind = purpose === 'download' ? 'download' : cellular ? 'cellular' : 'wifi';
    const v = settings[kind];
    if (v !== 'auto') return v;
    // A song with versions on several sources: the best known throughput among them.
    const tp = (Array.isArray(src) ? src : src ? [src] : []).reduce((m, id) => Math.max(m, sources.get(id)?.throughputKbps || 0), 0) || null;
    const known = Number.isFinite(tp) && tp > 0;
    if (!cellular) {
      const kbps = (Number(track?.bitrate) || 0) / 1000;
      return !known || !kbps || tp >= 1.5 * kbps ? 'max' : 'high';
    }
    if (!known) return 'normal';
    const stalled = lastRebuffer && Date.now() - lastRebuffer < REBUFFER_WINDOW_MS;
    if (tp >= 400 && !stalled) return 'high';
    if (tp >= 200) return 'normal';
    return 'low';
  },
};
