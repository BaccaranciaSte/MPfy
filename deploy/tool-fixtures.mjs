// Makes, on the PC, the archives the real-tool checks need and the phone cannot
// make by itself (deploy/tool-check.sh uses them):
//   nea.rar, nea-enc.rar   the album as RAR5, plain and with encrypted headers
//                          (needs a rar command: WinRAR's Rar.exe or rarlinux)
//   dict1536.7z            1650 MiB of sparse data (about 40:1, so the ratio rules
//                          let it through) in one solid LZMA2 block whose header
//                          declares a 1536 MiB dictionary: 7-Zip asks for that
//                          much memory, which the prlimit cap refuses
//
//   node deploy/tool-fixtures.mjs --nea <album dir> --out <dir> --7z <7z> [--rar <rar>]

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

function arg (name) {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? null : process.argv[i + 1]
}

const nea = arg('nea')
const out = arg('out')
const sevenZip = arg('7z')
const rar = arg('rar')
if (!nea || !out || !sevenZip) {
  console.error('uso: node deploy/tool-fixtures.mjs --nea <album> --out <cartella> --7z <7z> [--rar <rar>]')
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })

function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts })
  if (r.status !== 0) throw new Error(cmd + ' exited ' + r.status + ': ' + String(r.stdout).slice(-400) + String(r.stderr).slice(-400))
}

const album = fs.readdirSync(nea).sort().map((n) => path.join(nea, n))

if (rar) {
  for (const [name, extra] of [['nea.rar', []], ['nea-enc.rar', ['-hpSegreto']]]) {
    const file = path.join(out, name)
    if (fs.existsSync(file)) continue
    // -ep: no paths; -ma5: RAR5; -m3: normal compression.
    run(rar, ['a', '-ep', '-ma5', '-m3', '-idq', ...extra, file, ...album])
    console.log('made ' + name)
  }
}

// Mostly zeros with about 0.8% random bytes: LZMA packs it near 40:1.
function sparse (file, mib, seed) {
  const fd = fs.openSync(file, 'w')
  let state = crypto.createHash('sha256').update('sparse:' + seed).digest()
  const share = 0.0083
  for (let m = 0; m < mib; m++) {
    const block = Buffer.alloc(1024 * 1024)
    let i = 0
    while (i < block.length) {
      state = crypto.createHash('sha256').update(state).digest()
      for (let j = 0; j + 2 < state.length && i < block.length; j += 3) {
        i += Math.floor(-Math.log((((state[j] << 8) | state[j + 1]) + 1) / 65537) / share)
        if (i < block.length) block[i++] = state[j + 2] | 1
      }
    }
    fs.writeSync(fd, block)
  }
  fs.closeSync(fd)
}

// The LZMA2 coder's dictionary byte in a plain (uncompressed) 7z header, with
// both CRCs made again. 37 is (2 | 1) << (37 / 2 + 11) = 1536 MiB.
function patchDictionary (file, prop) {
  const buf = fs.readFileSync(file)
  const start = 32 + Number(buf.readBigUInt64LE(12))
  const header = buf.subarray(start, start + Number(buf.readBigUInt64LE(20)))
  if (header[0] !== 0x01) throw new Error('the 7z header is not plain')
  let found = 0
  for (let i = 0; i + 3 < header.length; i++) {
    if (header[i] === 0x21 && header[i + 1] === 0x21 && header[i + 2] === 0x01) {
      header[i + 3] = prop
      found++
    }
  }
  if (found === 0) throw new Error('no LZMA2 coder in the header')
  buf.writeUInt32LE(zlib.crc32(header) >>> 0, 28)
  buf.writeUInt32LE(zlib.crc32(buf.subarray(12, 32)) >>> 0, 8)
  fs.writeFileSync(file, buf)
}

const dict = path.join(out, 'dict1536.7z')
if (!fs.existsSync(dict)) {
  const tmp = fs.mkdtempSync(path.join(out, 'sparse-'))
  try {
    const parts = ['a.bin', 'b.bin', 'c.bin'].map((n) => path.join(tmp, n))
    parts.forEach((p, i) => sparse(p, 550, 'part' + i))
    run(sevenZip, ['a', '-t7z', '-m0=LZMA2:d=1m', '-mx3', '-ms=on', '-mhc=off', '-mhe=off', dict, ...parts])
    patchDictionary(dict, 37)
    console.log('made dict1536.7z (' + Math.round(fs.statSync(dict).size / 1048576) + ' MiB)')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
