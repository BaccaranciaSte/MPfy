// The profile photo: its menu on the Profilo page ("Cambia foto", and "Rimuovi foto" when there
// is one) and the crop screen. Done: "Foto aggiornata" or "Foto rimossa".
//
// The crop: the picked image under a circular window (280 px, smaller on a small screen), upright as
// its camera took it (the img element and the canvas both follow its EXIF orientation). One finger
// moves it, two fingers zoom around their middle, the mouse wheel zooms around the pointer; it
// always covers the circle, from just covering it to 4 times that. A third finger does nothing, a
// finger lifted from a pinch leaves the other moving the image from where it is. "Salva" makes a
// 320 x 320 JPEG of the circle's square (quality 0.85, then 0.75, 0.65 and 0.5 while it is above
// 48 KB; a picture still above it is "Immagine non valida") and gives it to the core: one upload
// however fast it is tapped. Back, Escape and the close button leave without keeping anything.

import { h, oneAtATime, repeatTap } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { profile } from '../js/profile.js';
import { localWords } from '../js/words.js';
import { openSheet, openPanel } from './sheet.js';
import { pickImage } from './cover-edit.js';
import { toast } from './toast.js';

const SIDE = 320; // px of the photo made
const MAX_BYTES = 48 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.5];
const WINDOW = 280; // px of the circle, when the screen has room
const MARGIN = 16;
const MAX_ZOOM = 4;

/** The photo's menu: "Cambia foto", and "Rimuovi foto" when there is one. */
export function openPhotoMenu() {
  return openSheet({
    label: 'Foto del profilo',
    items: [
      { icon: 'image', label: 'Cambia foto', onSelect: () => changePhoto() },
      profile.data?.photo && { icon: 'trash', label: 'Rimuovi foto', danger: true, onSelect: () => removePhoto() },
    ].filter(Boolean),
  });
}

const removePhoto = oneAtATime(async () => {
  try {
    await profile.removePhoto();
    toast('Foto rimossa');
  } catch (err) {
    toast(localWords(err));
  }
});

/** The picked file as a loaded img element, and its address (revoked when the crop closes). */
function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    img.className = 'crop-img';
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) resolve({ img, url });
      else {
        URL.revokeObjectURL(url);
        reject(new Error('immagine vuota'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('immagine non valida'));
    };
    img.src = url;
  });
}

/** "Cambia foto": the system picker, then the crop screen. */
export async function changePhoto() {
  const file = await pickImage();
  if (!file) return;
  let picked;
  try {
    picked = await readImage(file);
  } catch {
    toast('Immagine non valida');
    return;
  }
  openCrop(picked);
}

function openCrop({ img, url }) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const ring = h('div', { class: 'crop-window' });
  const stage = h('div', { class: 'crop-stage' }, img, ring);
  const save = h('button', { type: 'button', class: 'icon-btn crop-save', 'aria-label': 'Salva', title: 'Salva' }, icon('check', 26));

  // The circle: its side d and its corner (x0, y0) in the stage. The image: its scale s (screen px
  // per image px, from min to MAX_ZOOM x min) and its corner (tx, ty) from the circle's corner.
  let d = 0;
  let x0 = 0;
  let y0 = 0;
  let min = 1;
  let s = 1;
  let tx = 0;
  let ty = 0;

  const clamp = () => {
    s = Math.min(min * MAX_ZOOM, Math.max(min, s));
    tx = Math.min(0, Math.max(d - iw * s, tx));
    ty = Math.min(0, Math.max(d - ih * s, ty));
  };
  const paint = () => {
    img.style.width = `${iw * s}px`;
    img.style.height = `${ih * s}px`;
    img.style.transform = `translate(${x0 + tx}px, ${y0 + ty}px)`;
  };
  /** Zooms by f around the point (px, py) of the stage. */
  const zoomAt = (px, py, f) => {
    const next = Math.min(min * MAX_ZOOM, Math.max(min, s * f));
    const x = px - x0;
    const y = py - y0;
    tx = x - ((x - tx) * next) / s;
    ty = y - ((y - ty) * next) / s;
    s = next;
    clamp();
  };
  /** The circle fits the stage again; what was in it stays in it (its middle, its zoom). */
  const layout = () => {
    const w = stage.clientWidth;
    const hh = stage.clientHeight;
    if (!w || !hh) return;
    const side = Math.max(64, Math.min(WINDOW, w - 2 * MARGIN, hh - 2 * MARGIN));
    const cover = side / Math.min(iw, ih);
    if (d) {
      const cx = (d / 2 - tx) / s;
      const cy = (d / 2 - ty) / s;
      const zoom = s / min;
      d = side;
      min = cover;
      s = min * zoom;
      tx = d / 2 - cx * s;
      ty = d / 2 - cy * s;
    } else {
      d = side;
      min = cover;
      s = min;
      tx = (d - iw * s) / 2;
      ty = (d - ih * s) / 2;
    }
    x0 = (w - d) / 2;
    y0 = (hh - d) / 2;
    Object.assign(ring.style, { left: `${x0}px`, top: `${y0}px`, width: `${d}px`, height: `${d}px` });
    clamp();
    paint();
    if (pinch) pinch = { ...pair(), s, tx, ty }; // a pinch under way goes on from here
  };

  // ---- fingers and the mouse ----
  // One pointer moves the image by its steps. Two pinch it: from where they came down together
  // (pinch), the point of the image under their middle then stays under their middle, the zoom
  // follows their distance; measured from that start, not step by step, so the fingers' events
  // arriving one at a time never make it drift.
  const pts = new Map(); // pointerId -> { x, y }, client px: the first two pointers down
  let pinch = null; // { d, x, y, s, tx, ty } when the second pointer came down
  const inStage = (x, y) => {
    const r = stage.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };
  const pair = () => {
    const [a, b] = [...pts.values()];
    const m = inStage((a.x + b.x) / 2, (a.y + b.y) / 2);
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: m.x, y: m.y };
  };
  stage.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || pts.size >= 2) return;
    e.preventDefault();
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('grabbing');
    pinch = pts.size === 2 ? { ...pair(), s, tx, ty } : null;
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const q = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, q);
    if (!pinch) {
      tx += q.x - p.x;
      ty += q.y - p.y;
      clamp();
    } else {
      const now = pair();
      if (!(pinch.d > 0 && now.d > 0)) return;
      const u = (pinch.x - x0 - pinch.tx) / pinch.s;
      const v = (pinch.y - y0 - pinch.ty) / pinch.s;
      s = Math.min(min * MAX_ZOOM, Math.max(min, (pinch.s * now.d) / pinch.d));
      tx = now.x - x0 - u * s;
      ty = now.y - y0 - v * s;
      clamp();
    }
    paint();
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    pinch = null;
    if (!pts.size) stage.classList.remove('grabbing');
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('lostpointercapture', lift);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * stage.clientHeight : e.deltaY;
      const c = inStage(e.clientX, e.clientY);
      zoomAt(c.x, c.y, Math.min(2, Math.max(0.5, Math.exp(-dy * 0.002))));
      paint();
    },
    { passive: false }
  );
  const drop = () => {
    pts.clear();
    pinch = null;
    stage.classList.remove('grabbing');
  };

  // ---- the photo ----
  /** The circle's square as a JPEG of at most 48 KB, or null. */
  const encode = async () => {
    if (!d) layout();
    if (!d) return null;
    const c = document.createElement('canvas');
    c.width = SIDE;
    c.height = SIDE;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#141414'; // a transparent image gets the app background, not black
    g.fillRect(0, 0, SIDE, SIDE);
    const side = Math.min(d / s, iw, ih);
    const sx = Math.min(iw - side, Math.max(0, -tx / s));
    const sy = Math.min(ih - side, Math.max(0, -ty / s));
    g.drawImage(img, sx, sy, side, side, 0, 0, SIDE, SIDE);
    for (const q of QUALITIES) {
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    return null;
  };

  let layer = null;
  const saveOnce = oneAtATime(async () => {
    save.disabled = true;
    try {
      const blob = await encode();
      if (!blob) {
        toast('Immagine non valida');
        return;
      }
      await profile.setPhoto(blob);
      layer.close();
      toast('Foto aggiornata');
    } catch {
      toast('Foto non salvata');
    } finally {
      save.disabled = false;
    }
  });
  save.addEventListener('click', () => {
    if (layer.closed || repeatTap('photo-save')) return;
    saveOnce();
  });

  const panel = openPanel({
    label: 'Foto del profilo',
    cls: 'panel-crop',
    headerExtra: save,
    closeIcon: 'close',
    onClose: () => {
      window.removeEventListener('resize', layout);
      window.removeEventListener('blur', drop);
      drop();
      URL.revokeObjectURL(url);
    },
  });
  layer = panel.layer;
  panel.body.append(stage);
  window.addEventListener('resize', layout);
  window.addEventListener('blur', drop);
  layout();
  if (!d) requestAnimationFrame(layout); // the stage had no size yet
  return layer;
}
