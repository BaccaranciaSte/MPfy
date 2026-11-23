// A fake 7-Zip (7zz) for the tests. The server runs it as MPFY_7Z (a .mjs
// command is run with Node). It never reads the archive: what it lists and
// extracts comes from fake-7zz.json NEXT TO THIS FILE, read at every call:
//   { "version": "25.01",          the "i" header
//     "rar": true,                 Rar5 in the Codecs: section
//     "rarInFormats": true,        Rar5 in the Formats: section
//     "listing": "<text>",         the whole `l -slt` stdout, or:
//     "type": "7z", "entries": [{ path, size, packed, folder, attributes,
//                                 encrypted, symlink, hardlink }],
//     "listExit": 0, "listStderr": "", "slowBlocks": 0 (that many blocks, 20 ms apart),
//     "files": [{ "name", "from" (a file to copy) | "text" }], "extractExit": 0,
//     "grow": false,               keep writing past the declared size until killed
//     "growMax": 67108864 }        (or until this many bytes, or 60 s: then exit 3)
// Every call appends { args, start, end } to fake-7zz-calls.log.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const start = Date.now()
let control = {}
try {
  control = JSON.parse(fs.readFileSync(path.join(here, 'fake-7zz.json'), 'utf8'))
} catch {}

function finish (code) {
  fs.appendFileSync(path.join(here, 'fake-7zz-calls.log'), JSON.stringify({ args, start, end: Date.now() }) + '\n')
  process.exit(code)
}

const header = '\r\n7-Zip (z) ' + (control.version || '25.01') + ' (x64) : Copyright (c) 1999-2025 Igor Pavlov : 2025-08-03\r\n\r\n'

if (args[0] === 'i') {
  let out = header + 'Libs:\r\n 0 : 25.01 : 7z.dll\r\n\r\nFormats:\r\n'
  out += ' 0 C...F..........c.a.m+.. 7z       7z            7 z BC AF 27 1C\r\n'
  if (control.rarInFormats !== false) out += ' 0 ...F..................  Rar5     rar r00       R a r ! 1A 07 01 00\r\n'
  out += '\r\nCodecs:\r\n 0  ED        21 LZMA2\r\n 0  ED     30101 LZMA\r\n'
  if (control.rar !== false) out += ' 0   D     40305 Rar5\r\n'
  out += '\r\nHashers:\r\n 0    4        1 CRC32\r\n'
  process.stdout.write(out)
  finish(0)
}

function block (e) {
  const lines = ['Path = ' + e.path]
  lines.push('Folder = ' + (e.folder ? '+' : '-'))
  lines.push('Size = ' + (e.size === undefined ? 0 : e.size))
  lines.push('Packed Size = ' + (e.packed === undefined || e.packed === null ? '' : e.packed))
  lines.push('Modified = 2025-08-03 11:00:00')
  lines.push('Attributes = ' + (e.attributes || 'A -rw-r--r--'))
  lines.push('CRC = 00000000')
  lines.push('Encrypted = ' + (e.encrypted ? '+' : '-'))
  lines.push('Method = LZMA2:24')
  if (e.symlink !== undefined) lines.push('Symbolic Link = ' + e.symlink)
  if (e.hardlink !== undefined) lines.push('Hard Link = ' + e.hardlink)
  return lines.join('\r\n') + '\r\n\r\n'
}

if (args[0] === 'l') {
  if (control.listStderr) process.stderr.write(control.listStderr)
  if (control.listing !== undefined) {
    process.stdout.write(control.listing)
    finish(control.listExit || 0)
  }
  const archive = args[args.length - 1]
  let out = header + 'Scanning the drive for archives:\r\n1 file, 1 bytes\r\n\r\nListing archive: ' + archive + '\r\n\r\n--\r\n'
  out += 'Path = ' + archive + '\r\nType = ' + (control.type || '7z') + '\r\nPhysical Size = 1\r\nSolid = -\r\nBlocks = 1\r\n\r\n----------\r\n'
  if (control.slowBlocks) {
    process.stdout.write(out)
    let i = 0
    const next = () => {
      if (i >= control.slowBlocks) finish(0)
      process.stdout.write(block({ path: 'f' + i + '.mp3', size: 1000, packed: 1000 }))
      i++
      setTimeout(next, 2)
    }
    next()
  } else {
    for (const e of control.entries || []) out += block(e)
    process.stdout.write(out)
    finish(control.listExit || 0)
  }
}

if (args[0] === 'e') {
  const o = args.find((a) => a.startsWith('-o'))
  const dir = o.slice(2)
  if (control.grow) {
    // Runs detached: when the test that started it dies (a timeout, a broken
    // watchdog) nobody kills it, so it stops by itself past growMax bytes or
    // 60 s, and says so in the call log (a watchdog that works kills it far
    // earlier, and the call is never logged).
    const file = path.join(dir, 'grande.bin')
    const chunk = Buffer.alloc(256 * 1024, 7)
    const max = control.growMax || 64 * 1024 * 1024
    let written = 0
    const write = () => {
      if (written >= max || Date.now() - start > 60000) {
        fs.appendFileSync(path.join(here, 'fake-7zz-calls.log'), JSON.stringify({ args, start, end: Date.now(), capped: written }) + '\n')
        process.exit(3)
      }
      fs.appendFileSync(file, chunk)
      written += chunk.length
      setTimeout(write, 5)
    }
    write()
  } else {
    for (const f of control.files || []) {
      const dest = path.join(dir, f.name)
      if (f.from) fs.copyFileSync(f.from, dest)
      else fs.writeFileSync(dest, f.text || '')
    }
    finish(control.extractExit || 0)
  }
}
