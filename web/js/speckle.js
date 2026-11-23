// The logo's speckle: a 256x256 tile drawn ONCE at startup with a seeded random, turned
// into a PNG data URL and tiled by CSS (--speckle on the app background, bottom nav, mini player,
// sheets and cards; --speckle-dark, darker and fainter, on the silver play button and accents).
// It is a background image: never animated, never above covers or text, no SVG filters.

import { seeded } from './util.js';

const SIZE = 256;

function tile({ seed, grain, grainV, grainA, specks, speckV, speckA, big, bigA }) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  const between = (lo, hi) => lo + rnd() * (hi - lo);

  // Fine grain: single pixels at low alpha.
  const img = g.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let i = 0; i < grain; i++) {
    const o = ((Math.floor(rnd() * SIZE) * SIZE) + Math.floor(rnd() * SIZE)) * 4;
    const v = Math.round(between(grainV[0], grainV[1]));
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = Math.round(between(grainA[0], grainA[1]) * 255);
  }
  g.putImageData(img, 0, 0);

  // Draws a dot also on the opposite edges, so the tile repeats without a seam.
  const dot = (x, y, r, fill) => {
    g.fillStyle = fill;
    for (const dx of [0, -SIZE, SIZE]) {
      for (const dy of [0, -SIZE, SIZE]) {
        const px = x + dx;
        const py = y + dy;
        if (px < -4 || py < -4 || px > SIZE + 4 || py > SIZE + 4) continue;
        if (r <= 1) g.fillRect(px, py, r === 1 ? 2 : 1, r === 1 ? 2 : 1);
        else {
          g.beginPath();
          g.arc(px, py, r, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  };

  // A few dozen specks of 1 or 2 px, grey between speckV[0] and speckV[1].
  for (let i = 0; i < specks; i++) {
    const v = Math.round(between(speckV[0], speckV[1]));
    const a = between(speckA[0], speckA[1]).toFixed(3);
    dot(Math.floor(rnd() * SIZE), Math.floor(rnd() * SIZE), rnd() < 0.55 ? 0 : 1, `rgba(${v},${v},${v},${a})`);
  }
  // A couple slightly larger, soft ones.
  for (let i = 0; i < big; i++) {
    const v = Math.round(between(speckV[0], speckV[1]));
    dot(rnd() * SIZE, rnd() * SIZE, between(1.4, 1.9), `rgba(${v},${v},${v},${bigA})`);
  }
  return c.toDataURL('image/png');
}

/** Draws both tiles and publishes them as CSS custom properties on the root element. */
export function applySpeckle() {
  try {
    const light = tile({
      seed: 0x6d50f1,
      grain: 2200,
      grainV: [0x9a, 0xd0],
      grainA: [0.035, 0.09],
      specks: 40,
      speckV: [0x9a, 0xd0],
      speckA: [0.14, 0.32],
      big: 3,
      bigA: 0.26,
    });
    const dark = tile({
      seed: 0x6d50f2,
      grain: 1600,
      grainV: [0x30, 0x5a],
      grainA: [0.04, 0.1],
      specks: 36,
      speckV: [0x3a, 0x66],
      speckA: [0.16, 0.3],
      big: 2,
      bigA: 0.24,
    });
    const root = document.documentElement.style;
    // Quoted url(): an unquoted data URL can be dropped by the CSS parser.
    root.setProperty('--speckle', `url("${light}")`);
    root.setProperty('--speckle-dark', `url("${dark}")`);
  } catch (err) {
    console.warn('speckle', err); // no canvas: the plain colors stay
  }
}
