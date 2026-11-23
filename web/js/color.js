// Dominant color of a cover, computed in a small canvas (covers are same origin, so the canvas is
// not tainted). Used for the detail header gradient, Now Playing and the mini player,
// desaturated to about 35%, to sit with the greys of the logo.

import { coverHref } from './media.js';
import { hueOf, lsGet, lsSet, debounce } from './util.js';

const LS_KEY = 'mpfy.colors.v2';
const SATURATION = 0.35;
const saved = lsGet(LS_KEY, {});
const inflight = new Map();
const persist = debounce(() => {
  const keys = Object.keys(saved);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete saved[k];
  lsSet(LS_KEY, saved);
}, 2000);

/** Already known color for a cover, or null (lets a header paint the right color immediately). */
export const cachedColor = (coverId) => (coverId && saved[coverId]) || null;

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const fn = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [fn(0), fn(8), fn(4)].map((v) => Math.round(v * 255));
}

/** Picks the most prominent color, favouring saturated pixels over near black and near white. */
function pickDominant(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (max + min) / 510;
    let w = 1 + sat * 4;
    if (lum < 0.08 || lum > 0.93) w *= 0.12;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { w: 0, r: 0, g: 0, b: 0 }));
    e.w += w; e.r += r * w; e.g += g * w; e.b += b * w;
  }
  let best = null;
  for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
  if (!best) return null;
  return [best.r / best.w, best.g / best.w, best.b / best.w].map(Math.round);
}

/** Tones a raw dominant color into one that works as a background behind light text. */
function tone(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, Math.min(s, SATURATION), Math.min(0.4, Math.max(0.22, l * 0.85))]);
}

export function dominantColor(coverId) {
  if (!coverId) return Promise.resolve(null);
  return sample(coverId, () => coverHref(coverId, 'small'));
}

/**
 * The same for any image of this origin (a person's photo), kept under key (p:<photo hash>): a
 * photo is named by its hash, so its colour never changes.
 */
export function dominantColorOfUrl(url, key) {
  if (!url || !key) return Promise.resolve(null);
  return sample(key, () => url);
}

function sample(key, srcOf) {
  if (saved[key]) return Promise.resolve(saved[key]);
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 32, 32);
        const raw = pickDominant(ctx.getImageData(0, 0, 32, 32).data);
        const rgb = raw ? tone(raw) : null;
        if (rgb) {
          saved[key] = rgb;
          persist();
        }
        resolve(rgb);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    const src = srcOf();
    if (!src) {
      resolve(null);
      return;
    }
    img.src = src;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Fallback color for things without a cover: a stable hue from the name. */
export function nameColor(name) {
  return hslToRgb([hueOf(name), 0.3, 0.3]);
}

/** "Brani che ti piacciono": a violet, desaturated like every other header. */
export const LIKED_RGB = hslToRgb([252, SATURATION, 0.4]);
export const DEFAULT_RGB = [70, 70, 70];

/**
 * The colour of a song's lyrics, from its cover's (toned) colour: the same hue at saturation
 * min(0.6, s x 1.7) and lightness 0.29, so the white line being sung and the dark lines to come
 * both read on it. The toned colour keeps the cover's own saturation up to 0.35, so the factor
 * gives back the cover's own up to the cap.
 */
export function lyricsColor(rgb) {
  const [h, s] = rgbToHsl(rgb);
  return hslToRgb([h, Math.min(0.6, s * 1.7), 0.29]);
}

export const css = ([r, g, b], a = 1) => (a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`);
export const darken = (rgb, k) => rgb.map((v) => Math.round(v * k));
