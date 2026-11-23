// QR codes for the codes the app shows (a profile, a source), drawn here with no library: byte
// mode, error correction level M, the smallest version (1 to 40) that holds the text, and the mask
// with the lowest penalty of the four rules of ISO/IEC 18004. qrMatrix() is pure (the unit checks
// compare it with reference matrices that a separate decoder reads back); qrSvg() draws it black on
// white with the 4 module quiet zone the standard asks for.

// Level M, by version (index 0 unused): error correction codewords per block, and blocks.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const LEVEL_M = 0; // the two format bits of level M

/** The modules that carry data and error correction in a version, function patterns left out. */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

/** The centres of the alignment patterns on each axis. */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// GF(256) with the polynomial 0x11D.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= gfMul(divisor[i], factor);
  }
  return out;
}

/** The text's bytes (UTF-8). */
const utf8 = (text) => Array.from(new TextEncoder().encode(text));

/** The data codewords of a version: mode, count, bytes, terminator, padding. */
function dataBits(bytes, ver) {
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(4, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

/** The codewords split in blocks, each with its error correction, then interleaved. */
function withEcc(data, ver) {
  const nBlocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= nShort) out.push(blocks[j][i]);
    }
  }
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.dark = [];
    this.fixed = [];
    for (let y = 0; y < this.size; y++) {
      this.dark.push(new Array(this.size).fill(false));
      this.fixed.push(new Array(this.size).fill(false));
    }
  }

  set(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  functionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = alignmentPositions(this.ver);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        // not on the three finders
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.format(0); // reserves the area; the real bits come with the mask
    this.version();
  }

  finder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
      }
    }
  }

  format(mask) {
    const data = (LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // the dark module
  }

  version() {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** The codewords in the zigzag of two module columns, right to left, skipping the timing column. */
  codewords(cw) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? n - 1 - vert : vert;
          if (!this.fixed[y][x] && i < cw.length * 8) {
            this.dark[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  /** Flips the data modules the mask selects (twice undoes it). */
  mask(m) {
    const f = MASKS[m];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (!this.fixed[y][x] && f(x, y)) this.dark[y][x] = !this.dark[y][x];
    }
  }

  /** The penalty of the four rules: runs of one colour, 2x2 blocks, finder-like runs, the dark share. */
  penalty() {
    const n = this.size;
    let score = 0;
    const lines = (get) => {
      for (let a = 0; a < n; a++) {
        let color = false;
        let run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          if (get(a, b) === color) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else {
            pushRun(hist, run, n);
            if (!color) score += finderLike(hist) * 40;
            color = get(a, b);
            run = 1;
          }
        }
        if (color) {
          pushRun(hist, run, n);
          run = 0;
        }
        pushRun(hist, run + n, n); // the light border after the line
        score += finderLike(hist) * 40;
      }
    };
    lines((y, x) => this.dark[y][x]);
    lines((x, y) => this.dark[y][x]);
    let dark = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = this.dark[y][x];
        if (c) dark++;
        if (x < n - 1 && y < n - 1 && c === this.dark[y][x + 1] && c === this.dark[y + 1][x] && c === this.dark[y + 1][x + 1]) score += 3;
      }
    }
    const total = n * n;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** One run into the history of a line; the first run of a line counts the light border before it. */
function pushRun(hist, run, n) {
  hist.pop();
  hist.unshift(hist[0] === 0 ? run + n : run);
}

/** Dark-light-dark-dark-dark-light-dark runs of 1:1:3:1:1 with 4 light on one side: 0, 1 or 2. */
function finderLike(h) {
  const n = h[1];
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
}

/**
 * The QR code of text: { version, mask, size, dark } with dark[y][x] true for a dark module.
 * Throws when the text does not fit in version 40.
 */
export function qrMatrix(text) {
  const bytes = utf8(String(text));
  let ver = 1;
  while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > 40) throw new Error('too long for a QR code');
  const g = new Grid(ver);
  g.functionPatterns();
  g.codewords(withEcc(dataBits(bytes, ver), ver));
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    g.mask(m);
    g.format(m);
    const p = g.penalty();
    if (p < bestScore) {
      best = m;
      bestScore = p;
    }
    g.mask(m);
  }
  g.mask(best);
  g.format(best);
  return { version: ver, mask: best, size: g.size, dark: g.dark };
}

const SVG = 'http://www.w3.org/2000/svg';
const QUIET = 4;

/** The code as an SVG element, black modules on white with its quiet zone; label names it for screen readers. */
export function qrSvg(text, label = '') {
  const { size, dark } = qrMatrix(text);
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; ) {
      if (!dark[y][x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < size && dark[y][x + w]) w++;
      d += `M${x + QUIET} ${y + QUIET}h${w}v1h-${w}z`;
      x += w;
    }
  }
  const side = size + QUIET * 2;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'qr');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  if (label) svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', String(side));
  bg.setAttribute('height', String(side));
  bg.setAttribute('fill', '#fff');
  const ink = document.createElementNS(SVG, 'path');
  ink.setAttribute('d', d);
  ink.setAttribute('fill', '#000');
  svg.append(bg, ink);
  return svg;
}
