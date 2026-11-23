// "Cambia copertina" and "Ripristina copertina" for a track, an album or a playlist: pick an
// image, crop it to a centred square, resize it in a canvas to 640 and 160 px JPEG (quality 0.85)
// and upload both, large first: a playlist cover to the principal, a track or album cover to each
// source where the person may change it. Nothing leaves Bacca's devices.

import { srcApi, errorText } from '../js/api.js';
import { sources } from '../js/sources.js';
import { store, allowedVersion } from '../js/store.js';
import { toast } from './toast.js';

const SIZES = { large: 640, small: 160 };

/** Opens the system picker for one file of these types. Resolves the File, or null when cancelled. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.className = 'visually-hidden';
    let done = false;
    const finish = (f) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f || null);
    };
    input.addEventListener('change', () => finish(input.files?.[0]));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Opens the system picker for one image. Resolves the File, or null when cancelled. */
export const pickImage = () => pickFile('image/*');

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(Object.assign(new Error('immagine non valida'), { badImage: true }));
    };
    img.src = url;
  });
}

const toBlob = (canvas) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('conversione non riuscita'))), 'image/jpeg', 0.85));

/** The centred square of the image as { large, small } JPEG blobs (640 and 160 px). */
export async function squareJpegs(file) {
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw Object.assign(new Error('immagine non valida'), { badImage: true });
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  const draw = (source, x, y, s, size) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#141414'; // a transparent PNG gets the app background, not black
    g.fillRect(0, 0, size, size);
    g.drawImage(source, x, y, s, s, 0, 0, size, size);
    return c;
  };
  const large = draw(img, sx, sy, side, SIZES.large);
  // The small one from the large one (already cropped): a smaller jump than from a camera photo.
  const small = draw(large, 0, 0, SIZES.large, SIZES.small);
  return { large: await toBlob(large), small: await toBlob(small) };
}

/**
 * Where a custom cover of kind/id goes: a playlist cover is the person's own (the principal);
 * track and album covers are shared by everyone on a source, and go to every source where the
 * person may change them ([{ src, id }], the id on that source).
 */
function targetsOf(kind, id, { upOnly = true } = {}) {
  if (kind === 'playlist') {
    // Where the person's data lives: the phone's store too, while no real source holds it.
    const p = store.principalId;
    return p ? [{ src: p, id }] : [];
  }
  if (kind === 'track') {
    return store
      .versions(id)
      .filter((v) => allowedVersion(v) && (!upOnly || sources.isUp(v.sourceId)))
      .map((v) => ({ src: v.sourceId, id: v.trackId }));
  }
  return store
    .albumSources(id)
    .filter((src) => !upOnly || sources.isUp(src))
    .map((src) => ({ src, id }));
}

/** Uploads a picked (or given) image as the custom cover of kind/id. */
export async function changeCover(kind, id, file = null) {
  const targets = targetsOf(kind, id);
  if (!targets.length) {
    toast(sources.list.length ? 'Fonte non raggiungibile' : 'Nessuna fonte collegata');
    return false;
  }
  if (!file) file = await pickImage();
  if (!file) return false;
  let jpegs;
  try {
    jpegs = await squareJpegs(file);
  } catch {
    toast('Immagine non valida');
    return false;
  }
  toast('Caricamento copertina');
  let ok = 0;
  let lastErr = null;
  for (const t of targets) {
    try {
      const api = srcApi(t.src);
      await api.coverFor(kind, t.id, 'large', jpegs.large);
      const r = await api.coverFor(kind, t.id, 'small', jpegs.small);
      store.setCovers(t.src, r?.covers);
      ok++;
    } catch (err) {
      lastErr = err;
    }
  }
  if (ok) toast('Copertina aggiornata');
  else toast(lastErr?.status === 403 ? 'Qualcosa non ha funzionato' : errorText(lastErr, 'Copertina non cambiata'));
  if (lastErr?.status === 403) store.refreshSoon();
  return ok > 0;
}

/** Back to the automatic cover, wherever a custom one was set. */
export async function resetCover(kind, id) {
  const targets = targetsOf(kind, id).filter((t) => (kind === 'playlist' ? store.hasCustomCover(kind, id) : store.hasCustomCover(kind, id, [t.src])));
  if (!targets.length) return false;
  let ok = 0;
  let lastErr = null;
  for (const t of targets) {
    try {
      const r = await srcApi(t.src).resetCover(kind, t.id);
      store.setCovers(t.src, r?.covers);
      ok++;
    } catch (err) {
      lastErr = err;
    }
  }
  toast(ok ? 'Copertina ripristinata' : lastErr?.status === 403 ? 'Qualcosa non ha funzionato' : errorText(lastErr, 'Copertina non ripristinata'));
  if (lastErr?.status === 403) store.refreshSoon();
  return ok > 0;
}

/**
 * Menu items for a cover: "Cambia copertina", plus "Ripristina copertina" when a custom one
 * exists. None where the person may not change it (a member and someone else's track or album).
 */
export function coverMenuItems(kind, id) {
  const targets = targetsOf(kind, id, { upOnly: false });
  if (!targets.length) return [];
  const srcs = targets.map((t) => t.src);
  return [
    { icon: 'image', label: 'Cambia copertina', onSelect: () => changeCover(kind, id) },
    store.hasCustomCover(kind, id, kind === 'playlist' ? null : srcs) && { icon: 'reset', label: 'Ripristina copertina', onSelect: () => resetCover(kind, id) },
  ].filter(Boolean);
}
