// Writes web/js/emoji-data.js, the emoji of the picker by section, in Unicode's order: fully
// qualified, no skin tone (U+1F3FB..U+1F3FF) and no hair (U+1F9B0..U+1F9B3), nothing newer than
// Emoji 12.0 (what the Mi A2's font draws). Each emoji is written as its code points in hex: the
// app's text files hold no emoji themselves (check.mjs).
//
// From web/dev/emoji-test.txt (Unicode's emoji-test.txt 15.1, saved there by hand once): the
// "fully-qualified" lines whose E version is 12.0 or older, the groups as the sections (Component
// left out). Without that file (or with --icu): the same from the ICU data of a Java ICU4J
// (MPFY_ICU4J=<icu4j jar>, MPFY_JAVA=<java>; Android Studio ships both): the RGI emoji set in the
// emoji collation order (the order of emoji-test.txt), split where each group's first emoji
// stands, the Unicode age of every code point, and the sequences that came after 12.0 although
// their code points are older (named below).
//
//   node web/dev/emoji-build.mjs [--icu]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'js', 'emoji-data.js');
const TEST = path.join(HERE, 'emoji-test.txt');
const MAX_VERSION = 12.0;
const ZWJ = 0x200d;

const SECTIONS = [
  ['Smileys & Emotion', 'Faccine ed emozioni', 0x1f600],
  ['People & Body', 'Persone e corpo', 0x1f44b],
  ['Animals & Nature', 'Animali e natura', 0x1f435],
  ['Food & Drink', 'Cibo e bevande', 0x1f347],
  ['Travel & Places', 'Viaggi e luoghi', 0x1f30d],
  ['Activities', 'Attivit\u00e0', 0x1f383],
  ['Objects', 'Oggetti', 0x1f453],
  ['Symbols', 'Simboli', 0x1f3e7],
  ['Flags', 'Bandiere', 0x1f3c1],
];

const has = (cps, lo, hi = lo) => cps.some((c) => c >= lo && c <= hi);
const variant = (cps) => has(cps, 0x1f3fb, 0x1f3ff) || has(cps, 0x1f9b0, 0x1f9b3);

function fromTestFile() {
  const sections = [];
  let cur = null;
  for (const line of fs.readFileSync(TEST, 'utf8').split('\n')) {
    const g = /^# group: (.+?)\s*$/.exec(line);
    if (g) {
      const s = SECTIONS.find((x) => x[0] === g[1]);
      cur = s ? { name: s[1], list: [] } : null;
      if (cur) sections.push(cur);
      continue;
    }
    const m = /^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*\S+\s+E(\d+\.\d+)/.exec(line);
    if (!m || !cur) continue;
    const cps = m[1].split(' ').map((h) => parseInt(h, 16));
    if (Number(m[2]) > MAX_VERSION || variant(cps)) continue;
    cur.list.push(cps);
  }
  return sections;
}

// Sequences of Emoji 13.0 and later whose code points are all older (the ICU path only: the test
// file says each line's version itself).
const LATER = [
  [0x2764, 0xfe0f, ZWJ, 0x1f525], [0x2764, 0xfe0f, ZWJ, 0x1fa79], [0x1f62e, ZWJ, 0x1f4a8], [0x1f635, ZWJ, 0x1f4ab],
  [0x1f636, ZWJ, 0x1f32b, 0xfe0f], [0x1f43b, ZWJ, 0x2744, 0xfe0f], [0x1f408, ZWJ, 0x2b1b], [0x1f426, ZWJ, 0x2b1b],
  [0x1f426, ZWJ, 0x1f525], [0x1f34b, ZWJ, 0x1f7e9], [0x1f344, ZWJ, 0x1f7eb], [0x26d3, 0xfe0f, ZWJ, 0x1f4a5],
  [0x1f1e8, 0x1f1f6], // the flag of Sark (16.0)
];
const same = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
function later(cps) {
  if (has(cps, 0x26a7)) return true; // the transgender symbol became an emoji in 13.0
  if (LATER.some((x) => same(x, cps))) return true;
  if (!cps.includes(ZWJ)) return false;
  // Gender-neutral people (12.1 and later), except "people holding hands" (12.0).
  if (cps.includes(0x1f9d1) && !same(cps, [0x1f9d1, ZWJ, 0x1f91d, ZWJ, 0x1f9d1])) return true;
  // Bearded, in a tuxedo and with a veil by gender (13.0, 13.1), feeding a baby (13.0).
  if ([0x1f9d4, 0x1f935, 0x1f470].includes(cps[0]) || cps.includes(0x1f37c)) return true;
  // Facing right, shaking the head (15.1).
  return has(cps, 0x27a1) || has(cps, 0x2194, 0x2195);
}

const JAVA_SRC = `import com.ibm.icu.text.*; import com.ibm.icu.lang.*; import com.ibm.icu.util.*; import java.util.*; import java.io.*;
public class Dump { public static void main(String[] a) throws Exception {
  UnicodeSet rgi = new UnicodeSet("[:RGI_Emoji:]"); List<String> all = new ArrayList<>();
  for (UnicodeSetIterator it = new UnicodeSetIterator(rgi); it.nextRange();) {
    if (it.codepoint == UnicodeSetIterator.IS_STRING) all.add(it.string);
    else for (int c = it.codepoint; c <= it.codepointEnd; c++) all.add(new String(Character.toChars(c))); }
  all.sort(Collator.getInstance(new ULocale("und-u-co-emoji")));
  try (PrintWriter w = new PrintWriter(new OutputStreamWriter(new FileOutputStream(a[0]), "UTF-8"))) {
    for (String s : all) { StringBuilder hex = new StringBuilder(); VersionInfo max = VersionInfo.getInstance(0);
      for (int i = 0; i < s.length();) { int cp = s.codePointAt(i); i += Character.charCount(cp);
        if (hex.length() > 0) hex.append(' '); hex.append(Integer.toHexString(cp));
        VersionInfo age = UCharacter.getAge(cp); if (age.compareTo(max) > 0) max = age; }
      w.println(hex + "\\t" + max.getMajor() + "." + max.getMinor()); } } } }`;

function fromIcu() {
  const jar = process.env.MPFY_ICU4J || 'C:/Program Files/Android/Android Studio/lib/module-intellij.libraries.icu4j.jar';
  const java = process.env.MPFY_JAVA || 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-emoji-'));
  fs.writeFileSync(path.join(dir, 'Dump.java'), JAVA_SRC);
  const dump = path.join(dir, 'dump.tsv');
  const r = spawnSync(java, ['-cp', jar, path.join(dir, 'Dump.java'), dump], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`java: ${r.stderr || r.error}`);
  const rows = fs.readFileSync(dump, 'utf8').trim().split('\n').map((l) => {
    const [hex, age] = l.split('\t');
    return { cps: hex.split(' ').map((x) => parseInt(x, 16)), age: Number(age) };
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const sections = [];
  let cur = null;
  for (const r of rows) {
    const start = (r.cps.length === 1 || (r.cps.length === 2 && r.cps[1] === 0xfe0f)) && SECTIONS.find((s) => s[2] === r.cps[0]);
    if (start) {
      cur = { name: start[1], list: [] };
      sections.push(cur);
    }
    if (!cur || variant(r.cps) || r.age > MAX_VERSION || later(r.cps)) continue;
    cur.list.push(r.cps);
  }
  if (sections.map((s) => s.name).join() !== SECTIONS.map((s) => s[1]).join()) throw new Error('the groups are not where they were expected');
  return sections;
}

const useIcu = process.argv.includes('--icu') || !fs.existsSync(TEST);
const sections = useIcu ? fromIcu() : fromTestFile();
const lines = [
  '// The emoji of the picker (components/emoji-picker.js), by section, in Unicode\'s order: fully',
  '// qualified, no skin tone and no hair, nothing newer than Emoji 12.0 (what the Mi A2\'s font draws).',
  '// Each emoji is its code points in hex joined by ".", the emoji apart by a space. Written by',
  `// web/dev/emoji-build.mjs (from ${useIcu ? 'the ICU emoji data' : "Unicode's emoji-test.txt"}); not edited by hand.`,
  '',
  'export const EMOJI_SECTIONS = [',
];
for (const s of sections) {
  const words = s.list.map((cps) => cps.map((c) => c.toString(16)).join('.'));
  const chunks = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + w.length + 1 > 90) {
      chunks.push(line);
      line = '';
    }
    line += (line ? ' ' : '') + w;
  }
  if (line) chunks.push(line);
  lines.push('  {', `    name: '${s.name}',`, '    list: [', ...chunks.map((c) => `      '${c}',`), "    ].join(' '),", '  },');
}
lines.push('];', '');
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`${OUT}: ${sections.map((s) => `${s.name} ${s.list.length}`).join(', ')}; total ${sections.reduce((n, s) => n + s.list.length, 0)} (${useIcu ? 'ICU' : 'emoji-test.txt'})`);
