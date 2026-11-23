// A fake fpcalc for the tests (fpcalc is not installed on the build PC). The
// server runs it as MPFY_FPCALC (a .mjs command is run with Node).
//
// Read at every call from fake-fpcalc.json NEXT TO THIS FILE:
//   { "missing": false,     -version fails (no fpcalc)
//     "prints": { "<key>": { "duration": 245.31, "fingerprint": [...] } },
//     "raw": { "<key>": "<literal stdout>" },
//     "fail": ["<key>"],    exit 1 for these
//     "default": "fail",    unknown files fail (otherwise a fingerprint of their own)
//     "delayMs": 0 }        wait this long before answering (a { key, started }
//                           line is logged when it starts waiting)
// <key> is the first 24 hex of the SHA-256 of the file, or "tail:<that of the
// file the fake ffmpeg cut the tail from>" for a tail WAV (fake-ffmpeg.mjs).
// An unknown file gets 970 items derived from its key and the duration of its
// WAV header (or 200 s). Without -raw the fingerprint is a string, "FP" + the key
// (the real one is compressed). Every call appends { args, key } to
// fake-fpcalc-calls.log.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let control = {}
try {
  control = JSON.parse(fs.readFileSync(path.join(here, 'fake-fpcalc.json'), 'utf8'))
} catch {}

function record (key) {
  fs.appendFileSync(path.join(here, 'fake-fpcalc-calls.log'), JSON.stringify({ args, key }) + '\n')
}

if (args.includes('-version')) {
  record(null)
  if (control.missing) process.exit(1)
  process.stdout.write('fpcalc version 1.5.1 (fake)\n')
  process.exit(0)
}

const file = args[args.length - 1]
let data
try {
  data = fs.readFileSync(file)
} catch {
  record(null)
  process.stderr.write('ERROR: Could not open the input file\n')
  process.exit(2)
}
const key = data.subarray(0, 5).toString('latin1') === 'TAIL:'
  ? 'tail:' + data.subarray(5, 29).toString('latin1')
  : crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)
if (control.delayMs) {
  fs.appendFileSync(path.join(here, 'fake-fpcalc-calls.log'), JSON.stringify({ args, key, started: true }) + '\n')
  await new Promise((resolve) => setTimeout(resolve, control.delayMs))
}
record(key)

if ((control.fail || []).includes(key)) process.exit(1)
if (control.raw && control.raw[key] !== undefined) {
  process.stdout.write(control.raw[key])
  process.exit(0)
}
let out = control.prints && control.prints[key]
if (!out) {
  if (control.default === 'fail') process.exit(1)
  let duration = 200
  if (data.length >= 44 && data.subarray(0, 4).toString('latin1') === 'RIFF') {
    const byteRate = data.readUInt32LE(28)
    if (byteRate > 0) duration = Math.round(((data.length - 44) / byteRate) * 100) / 100
  }
  const fingerprint = []
  for (let i = 0; fingerprint.length < 970; i++) {
    const block = crypto.createHash('sha256').update('fake-fp:' + key + ':' + i).digest()
    for (let j = 0; j < 32 && fingerprint.length < 970; j += 4) fingerprint.push(block.readInt32LE(j))
  }
  out = { duration, fingerprint }
}
if (!args.includes('-raw')) out = { duration: out.duration, fingerprint: 'FP' + key.replace(/[^0-9a-z]/g, '') }
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
