// Compares the UI smoke screenshots of two runs, pixel by pixel: an older UI (before) and this one
// (after), every screen both took, at every size both took. The after run saved, next to each
// screenshot, the boxes of what may rightly differ (ui-<name>.boxes.json: "changed", the newer
// elements; "time", text that follows the clock or the run's timing). A difference inside a
// changed box is expected; inside a time box it is listed; anywhere else it is a defect, unless
// the same pixels also differ between two runs of the older UI (pass --noise <dir>): then it is
// timing, and listed as such. Writes diff-<name>.png (differences in red) for each screen that
// differs outside its boxes.
// Usage: node web/dev/shot-diff.mjs <before dir> <after dir> <out dir> [--noise <before run 2>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [beforeDir, afterDir, outDir] = process.argv.slice(2, 5).map((p) => path.resolve(p));
const noiseAt = process.argv.indexOf('--noise');
const noiseDir = noiseAt > 0 ? path.resolve(process.argv[noiseAt + 1]) : null;
const PAD = 3; // px around a marked box
const out = [];
const log = (s) => out.push(s);

/** A PNG as { w, h, px: RGBA bytes } (8 bit, colour types 2 and 6, not interlaced). */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let o = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: only 8 bit, not interlaced`);
      type = data[9];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`${file}: colour type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const cur = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      px[(y * w + x) * 4] = cur[x * bpp];
      px[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
      px[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      px[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = Buffer.from(cur);
  }
  return { w, h, px };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function writePng(file, w, h, px) {
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** Pixels that differ between two images of the same size, as a byte mask. */
function diffMask(a, b) {
  const m = new Uint8Array(a.w * a.h);
  for (let i = 0; i < m.length; i++) {
    const o = i * 4;
    if (a.px[o] !== b.px[o] || a.px[o + 1] !== b.px[o + 1] || a.px[o + 2] !== b.px[o + 2]) m[i] = 1;
  }
  return m;
}

/** Bounding boxes of the groups of marked pixels (8-neighbour, joined within 6 px). */
function regions(mask, w, h) {
  const cell = 6;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const cells = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) cells[Math.floor(y / cell) * cw + Math.floor(x / cell)] = 1;
  const seen = new Uint8Array(cw * ch);
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    let n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % cw;
      const cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const k = ny * cw + nx;
          if (cells[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    let px = 0;
    for (let y = y0 * cell; y < Math.min(h, (y1 + 1) * cell); y++) for (let x = x0 * cell; x < Math.min(w, (x1 + 1) * cell); x++) px += mask[y * w + x];
    out.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell, px });
  }
  return out;
}

const inBoxes = (boxes, x, y) => boxes.some(([l, t, r, b]) => x >= l - PAD && x < r + PAD && y >= t - PAD && y < b + PAD);
const pngs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^ui-.*\.png$/.test(f)) : []);

fs.mkdirSync(outDir, { recursive: true });
const before = new Set(pngs(beforeDir));
const after = pngs(afterDir);
const both = after.filter((f) => before.has(f)).sort();
log(`before: ${beforeDir} (${before.size} screenshots)`);
log(`after:  ${afterDir} (${after.length} screenshots)`);
if (noiseDir) log(`noise:  ${noiseDir} (a second run of the older UI)`);
log(`compared: ${both.length} screens both took\n`);
const tally = { same: 0, changed: 0, time: 0, timing: 0, defect: 0 };
for (const f of both) {
  const name = f.replace(/^ui-|\.png$/g, '');
  const a = readPng(path.join(beforeDir, f));
  const b = readPng(path.join(afterDir, f));
  if (a.w !== b.w || a.h !== b.h) {
    tally.defect++;
    log(`DEFECT ${name}: size ${a.w}x${a.h} before, ${b.w}x${b.h} after`);
    continue;
  }
  let boxes = { changed: [], time: [] };
  try {
    boxes = JSON.parse(fs.readFileSync(path.join(afterDir, `ui-${name}.boxes.json`), 'utf8'));
  } catch {
    /* no boxes: every difference counts */
  }
  const m = diffMask(a, b);
  let noise = null;
  if (noiseDir && fs.existsSync(path.join(noiseDir, f))) {
    const n = readPng(path.join(noiseDir, f));
    if (n.w === a.w && n.h === a.h) noise = diffMask(a, n);
  }
  const kinds = { changed: 0, time: 0, timing: 0, defect: 0 };
  const defect = new Uint8Array(m.length);
  const timing = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const x = i % a.w;
    const y = Math.floor(i / a.w);
    if (inBoxes(boxes.changed || [], x, y)) kinds.changed++;
    else if (inBoxes(boxes.time || [], x, y)) kinds.time++;
    else if (noise && noise[i]) {
      kinds.timing++;
      timing[i] = 1;
    } else {
      kinds.defect++;
      defect[i] = 1;
    }
  }
  const total = kinds.changed + kinds.time + kinds.timing + kinds.defect;
  if (!total) {
    tally.same++;
    log(`SAME   ${name}`);
    continue;
  }
  const parts = Object.entries(kinds).filter(([, v]) => v).map(([k, v]) => `${k} ${v} px`).join(', ');
  if (kinds.defect) {
    tally.defect++;
    const rs = regions(defect, a.w, a.h);
    log(`DEFECT ${name}: ${parts}; outside the marked boxes at ${rs.map((r) => `${r.x},${r.y} ${r.w}x${r.h} (${r.px} px)`).join('; ')}`);
    const px = Buffer.from(b.px);
    for (let i = 0; i < m.length; i++) {
      const o = i * 4;
      if (defect[i]) {
        px[o] = 255;
        px[o + 1] = 0;
        px[o + 2] = 0;
      } else if (m[i]) {
        px[o] = 255;
        px[o + 1] = 200;
        px[o + 2] = 0;
      } else {
        px[o] >>= 2;
        px[o + 1] >>= 2;
        px[o + 2] >>= 2;
      }
    }
    writePng(path.join(outDir, `diff-${name}.png`), a.w, a.h, px);
  } else if (kinds.timing) {
    tally.timing++;
    const rs = regions(timing, a.w, a.h);
    log(`TIMING ${name}: ${parts}; the same pixels differ between two runs of the older UI at ${rs.map((r) => `${r.x},${r.y} ${r.w}x${r.h}`).join('; ')}`);
  } else if (kinds.time) {
    tally.time++;
    log(`TIME   ${name}: ${parts} (text that follows the clock or the run's timing)`);
  } else {
    tally.changed++;
    log(`NEWER  ${name}: ${parts} (only inside the newer elements)`);
  }
}
const onlyAfter = after.filter((f) => !before.has(f));
log(`\nonly in the after run (new screens, not compared): ${onlyAfter.map((f) => f.replace(/^ui-|\.png$/g, '')).join(', ') || 'none'}`);
const onlyBefore = [...before].filter((f) => !after.includes(f));
log(`only in the before run: ${onlyBefore.map((f) => f.replace(/^ui-|\.png$/g, '')).join(', ') || 'none'}`);
log(`\nsame=${tally.same} newer=${tally.changed} time=${tally.time} timing=${tally.timing} defects=${tally.defect}`);
fs.writeFileSync(path.join(outDir, 'shot-diff.log'), out.join('\n') + '\n');
console.log(`defects=${tally.defect} (see ${path.join(outDir, 'shot-diff.log')})`);
process.exit(tally.defect ? 1 : 0);
