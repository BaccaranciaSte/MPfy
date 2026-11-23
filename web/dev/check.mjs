// Static checks of web/ (no browser, no network):
//   1. node --check on every .js and .mjs file
//   2. every relative import resolves to a file, and every named import is exported there
//   3. the service worker's SHELL_FILES list equals the files on disk (web/dev excluded)
//   4. every text file, comments included, holds only ASCII and the Italian letters
//      à è é ì í ò ó ù ú and their capitals: no dashes, typographic quotes, ellipses, middle
//      dots, arrows, check marks or emoji
//   5. the old product name (the first one) appears nowhere
//   6. the app code (web/dev aside) uses nothing newer than the Mi A2's WebView (Chrome 81)
//   7. the music service the look follows is never named
//   8. one layout for every browser, Chrome 81 included: no flex gap (gap only on grid
//      containers), no inset, no color-mix(), every aspect-ratio with its @supports not
//      (aspect-ratio) fallback for the same selector, dvh/svh/lvh only inside @supports (height:
//      100dvh) after a vh rule, :focus-visible never in a selector list (Chrome 81 drops the rule),
//      no scroll snapping (a fling ends where it glides)
// Usage: node web/dev/check.mjs <web dir> <log file>. Exit code 1 when a problem was found.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const web = path.resolve(process.argv[2]);
const logFile = process.argv[3];
const out = [];
let problems = 0;
const log = (s) => out.push(s);

function walk(dir) {
  const r = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) r.push(...walk(p));
    else r.push(p);
  }
  return r;
}

const all = walk(web).sort();
const rel = (f) => path.relative(web, f).replace(/\\/g, '/');
const js = all.filter((f) => /\.(m?js)$/.test(f));

log('== node --check');
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status === 0) log(`OK   ${rel(f)}`);
  else {
    problems++;
    log(`FAIL ${rel(f)}\n${r.stderr}`);
  }
}

log('\n== imports and exports');
const exportsOf = new Map();
function exportNames(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  exportsOf.set(file, names);
  return names;
}
let importCount = 0;
for (const f of js) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    importCount++;
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) {
      problems++;
      log(`MISSING ${rel(f)} -> ${spec}`);
      continue;
    }
    const clause = (m[1] || '').trim();
    const named = /\{([\s\S]*)\}/.exec(clause);
    if (!named) continue;
    const have = exportNames(target);
    for (const part of named[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const name = p.split(/\s+as\s+/)[0].trim();
      if (!have.has(name)) {
        problems++;
        log(`NO EXPORT ${rel(f)}: '${name}' not exported by ${spec}`);
      }
    }
  }
}
log(`relative imports checked: ${importCount}`);

log('\n== service worker shell list vs disk');
const sw = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
const list = /const SHELL_FILES = \[([\s\S]*?)\];/.exec(sw)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
const onDisk = all.map((f) => '/' + rel(f)).filter((p) => !p.startsWith('/dev/') && p !== '/sw.js');
for (const p of list) if (!onDisk.includes(p)) {
  problems++;
  log(`LISTED BUT MISSING ${p}`);
}
for (const p of onDisk) if (!list.includes(p)) {
  problems++;
  log(`ON DISK BUT NOT LISTED ${p}`);
}
if (new Set(list).size !== list.length) {
  problems++;
  log('DUPLICATES in SHELL_FILES');
}
log(`shell files listed: ${list.length}, on disk: ${onDisk.length}`);

log('\n== characters: ASCII and the Italian accented letters only');
const allowed = new Set([...'àèéìíòóùúÀÈÉÌÍÒÓÙÚ']);
let scanned = 0;
// Unicode's own emoji list (web/dev/emoji-test.txt, the source of js/emoji-data.js) is its data, not ours.
for (const f of all.filter((x) => /\.(m?js|css|html|webmanifest|json|md|txt|svg)$/.test(x) && rel(x) !== 'dev/emoji-test.txt')) {
  scanned++;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80 || allowed.has(ch)) continue;
      log(`BANNED ${rel(f)}:${i + 1} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      problems++;
    }
  });
}
log(`text files scanned: ${scanned}`);

// Built from its letters so that this file does not contain it either.
const OLD_NAME = new RegExp([115, 105, 114, 101, 110, 97].map((c) => String.fromCharCode(c)).join(''), 'i');
log('\n== the old name');
for (const f of all.filter((x) => /\.(m?js|css|html|webmanifest|md|json)$/.test(x))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (OLD_NAME.test(line)) {
      problems++;
      log(`OLD NAME ${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}

// The Mi A2's WebView is Chrome 81 and cannot be updated: the app's own code (not web/dev) uses
// nothing newer. A logical assignment there is a syntax error, and the whole module is lost.
const NEWER = [
  [/(\|\||&&|\?\?)=/, 'logical assignment (Chrome 85)'],
  [/\.(findLast|findLastIndex)\(/, 'findLast (Chrome 97)'],
  [/\.at\(-?\d/, 'Array.prototype.at (Chrome 92)'],
  [/\bObject\.hasOwn\(/, 'Object.hasOwn (Chrome 93)'],
  [/\bstructuredClone\(/, 'structuredClone (Chrome 98)'],
  [/\.replaceAll\(/, 'String.prototype.replaceAll (Chrome 85)'],
  [/\bPromise\.any\(/, 'Promise.any (Chrome 85)'],
];
log('\n== nothing newer than the Mi A2\'s WebView (Chrome 81)');
const stripStrings = (line) => line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
for (const f of js.filter((x) => !rel(x).startsWith('dev/'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = stripStrings(line);
    for (const [re, what] of NEWER) {
      if (re.test(code)) {
        problems++;
        log(`TOO NEW ${rel(f)}:${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
      }
    }
  });
}

// The music service the look follows is never named, in the chrome or in a comment; built from
// its letters for the same reason.
const SERVICE = new RegExp([115, 112, 111, 116, 105, 102, 121].map((c) => String.fromCharCode(c)).join(''), 'i');
log('\n== the service the look follows');
for (const f of all.filter((x) => /\.(m?js|css|html|webmanifest|md|json)$/.test(x))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (SERVICE.test(line)) {
      problems++;
      log(`NAMED ${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}

// ---- one layout for every browser ----
/** The rules of a stylesheet: { selector, decls: [{ prop, value }], line, ctx: [at-rule preludes] }. */
function parseCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const prelude = src.slice(start, i).trim().replace(/\s+/g, ' ');
      stack.push({ prelude, line: src.slice(0, i).split('\n').length, at: prelude.startsWith('@'), body: i + 1 });
      start = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (top && !top.at) {
        const decls = src
          .slice(top.body, i)
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d.includes(':'))
          .map((d) => ({ prop: d.slice(0, d.indexOf(':')).trim().toLowerCase(), value: d.slice(d.indexOf(':') + 1).trim() }));
        out.push({ selector: top.prelude, decls, line: top.line, ctx: stack.filter((x) => x.at).map((x) => x.prelude) });
      }
      start = i + 1;
    } else if (c === ';' && (!stack.length || stack[stack.length - 1].at)) start = i + 1;
  }
  return out;
}
/** A selector list split at its top-level commas. */
function selectorsOf(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
log('\n== one layout for every browser (Chrome 81 included)');
let cssRules = 0;
for (const f of all.filter((x) => /\.css$/.test(x) && !rel(x).startsWith('dev/'))) {
  const rules = parseCss(fs.readFileSync(f, 'utf8'));
  cssRules += rules.length;
  const bad = (r, what) => {
    problems++;
    log(`LAYOUT ${rel(f)}:${r.line}: ${what}: ${r.selector}`);
  };
  const displayOf = (sel) => rules.filter((r) => selectorsOf(r.selector).includes(sel)).flatMap((r) => r.decls.filter((d) => d.prop === 'display').map((d) => d.value));
  for (const r of rules) {
    const sels = selectorsOf(r.selector);
    for (const d of r.decls) {
      if (d.prop === 'inset') bad(r, 'inset (Chrome 87): top, right, bottom, left instead');
      if (/color-mix\(/.test(d.value)) bad(r, 'color-mix() (Chrome 111)');
      if (/^scroll-snap-(type|align)$/.test(d.prop) && d.value !== 'none') bad(r, `${d.prop}: after a fling on Android the row jumps back to the next item`);
      if (['gap', 'row-gap', 'column-gap'].includes(d.prop) && !/^0(px)?$/.test(d.value)) {
        const grid = sels.every((sel) => {
          const own = r.decls.filter((x) => x.prop === 'display').map((x) => x.value);
          return (own.length ? own : displayOf(sel)).some((v) => /^(inline-)?grid$/.test(v));
        });
        if (!grid) bad(r, `${d.prop} on a container that is not a grid (flex gap: Chrome 84)`);
      }
      if (/\d(dvh|svh|lvh)\b/.test(d.value)) {
        if (!r.ctx.some((c) => /^@supports \(height: ?100dvh\)$/.test(c))) bad(r, `${d.prop} with dvh/svh/lvh outside @supports (height: 100dvh)`);
        const before = rules.find((x) => x.line < r.line && x.selector === r.selector && x.decls.some((y) => y.prop === d.prop && /\dvh\b/.test(y.value)));
        if (!before) bad(r, `${d.prop} with dvh/svh/lvh and no vh rule before it`);
      }
      if (d.prop === 'aspect-ratio') {
        for (const sel of sels) {
          // The box keeps its shape from a ::before with a padding-top, its content placed over it.
          const fallback = rules.some((x) => x.ctx.some((c) => /^@supports not \(aspect-ratio/.test(c)) && selectorsOf(x.selector).includes(`${sel}::before`) && x.decls.some((d) => d.prop === 'padding-top'));
          if (!fallback) bad(r, `aspect-ratio (Chrome 88) without its @supports not (aspect-ratio) fallback for ${sel}`);
        }
      }
    }
    if (/:focus-visible/.test(r.selector) && sels.length > 1) bad(r, ':focus-visible in a selector list (Chrome 81 drops the whole rule)');
  }
}
for (const f of js.filter((x) => !rel(x).startsWith('dev/'))) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/color-mix\(|aspect-?ratio|aspectRatio|\d[dsl]vh\b|\b(gap|rowGap|columnGap|inset)\s*:|['"](row-gap|column-gap)['"]/.test(code)) {
      problems++;
      log(`LAYOUT ${rel(f)}:${i + 1}: a style newer than Chrome 81: ${line.trim().slice(0, 100)}`);
    }
  });
}
log(`css rules checked: ${cssRules}`);

log(`\nfiles=${all.length} problems=${problems}`);
fs.writeFileSync(logFile, out.join('\n') + '\n');
console.log(`problems=${problems} (see ${logFile})`);
process.exitCode = problems ? 1 : 0;
