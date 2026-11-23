#!/usr/bin/env node
// A copy of the MPfy release signing key, sealed with a passphrase only its owner knows. Losing the key
// means the installed apps can never be updated again: this copy is the way back.
//
//   node android/key-backup.mjs export <file>         seals the keystore and its password (passphrase typed twice)
//   node android/key-backup.mjs check <file>          opens a copy and says whether it holds the key the releases use
//   node android/key-backup.mjs restore <file> [dir]  puts the key back for this Windows user (default ~/.mpfy-sign),
//                                                    never over a keystore already there
//
// The passphrase is typed in the terminal with the echo off. The keystore password never reaches the screen,
// a file in clear or a command line. Argon2id (libsodium crypto_pwhash) derives the key, XChaCha20-Poly1305
// seals, and the header (format, cost, salt, nonce) is authenticated with the rest.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sodium from 'sodium-native'

const here = path.dirname(fileURLToPath(import.meta.url))

const MAGIC = Buffer.from('MPFYKEY1', 'latin1')
const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const SALT_AT = MAGIC.length + 8
const NONCE_AT = SALT_AT + SALT_BYTES
export const HEADER_BYTES = NONCE_AT + NONCE_BYTES

// The cost of a new copy, and the most a copy may ask for when it is opened: a damaged header must not make
// the opening take minutes or all the memory.
export const COST = { ops: sodium.crypto_pwhash_OPSLIMIT_MODERATE, mem: sodium.crypto_pwhash_MEMLIMIT_MODERATE }
const MAX_OPS = 10
const MAX_MEM = 2 ** 31
export const MIN_PASSPHRASE = 12

const ALIAS = 'mpfy'
const KEYSTORE_NAME = 'mpfy-release.jks'
const PASS_NAME = 'mpfy-release.pass.dpapi'
// The notes kept next to the key travel with it; nothing else is ever written back from a copy.
const NOTES = ['LEGGIMI.txt']

// What android/release.sh runs to read the password (kept byte for byte like the one made with the key).
const PASS_PS1 =
  '\ufeff# Prints the MPfy release keystore password (DPAPI, this Windows user only). For build scripts: never log it.\n' +
  'Add-Type -AssemblyName System.Security\n' +
  '$enc = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "mpfy-release.pass.dpapi"))\n' +
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))\r\n'

const MESSAGES = {
  exists: (p) => `C'è già ${p}: non lo tocco.`,
  no_terminal: () => 'Serve un terminale vero, per scrivere la frase senza che si veda.',
  cancelled: () => 'Annullato.',
  no_passphrase: () => 'Nessuna frase valida: niente copia.',
  wrong_passphrase: () => 'La frase non apre la copia: è sbagliata, oppure il file è rovinato.',
  not_a_copy: () => 'Questo file non è una copia della chiave MPfy, oppure è rovinato.',
  bad_contents: () => 'La copia si apre ma il contenuto non è quello atteso.',
  password_mismatch: () => 'La password non apre il keystore.',
  not_release_key: () => 'Questa non è la chiave con cui sono firmate le versioni MPfy.',
  no_keytool: (p) => `Manca keytool (${p}): serve Android Studio, oppure JAVA_HOME.`,
  no_password: () => 'Non riesco a leggere la password del keystore (pass.ps1).',
  verify_failed: () => 'La copia appena scritta non si riapre uguale: l\'ho tolta.',
  windows_only: () => 'Il ripristino si fa su Windows: la password va protetta per l\'utente che firma.',
  protect_failed: () => 'Non riesco a proteggere la password per questo utente (DPAPI).',
  restore_failed: () => 'La chiave rimessa non si legge come quella della copia: controlla la cartella.',
}

export class BackupError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const colons = (hex) => hex.toUpperCase().match(/../g).join(':')

function deriveKey(passphrase, salt, ops, mem) {
  const key = sodium.sodium_malloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  sodium.crypto_pwhash(key, passphrase, salt, ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13)
  return key
}

/** The sealed copy of `plain` (a Buffer) under `passphrase` (a Buffer). */
export function seal(plain, passphrase, cost = COST) {
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header.writeUInt32LE(cost.ops, MAGIC.length)
  header.writeUInt32LE(cost.mem, MAGIC.length + 4)
  const salt = header.subarray(SALT_AT, NONCE_AT)
  const nonce = header.subarray(NONCE_AT)
  sodium.randombytes_buf(salt)
  sodium.randombytes_buf(nonce)
  const key = deriveKey(passphrase, salt, cost.ops, cost.mem)
  try {
    const sealed = Buffer.alloc(plain.length + TAG_BYTES)
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(sealed, plain, header, null, nonce, key)
    return Buffer.concat([header, sealed])
  } finally {
    sodium.sodium_memzero(key)
  }
}

/** What `seal` sealed, or a BackupError: not_a_copy (not one, or a damaged header), wrong_passphrase. */
export function open(file, passphrase) {
  if (file.length < HEADER_BYTES + TAG_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('not_a_copy')
  }
  const ops = file.readUInt32LE(MAGIC.length)
  const mem = file.readUInt32LE(MAGIC.length + 4)
  if (ops < sodium.crypto_pwhash_OPSLIMIT_MIN || ops > MAX_OPS || mem < sodium.crypto_pwhash_MEMLIMIT_MIN || mem > MAX_MEM) {
    throw new BackupError('not_a_copy')
  }
  const header = file.subarray(0, HEADER_BYTES)
  const key = deriveKey(passphrase, header.subarray(SALT_AT, NONCE_AT), ops, mem)
  try {
    const plain = Buffer.alloc(file.length - HEADER_BYTES - TAG_BYTES)
    try {
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, file.subarray(HEADER_BYTES), header, header.subarray(NONCE_AT), key)
    } catch {
      throw new BackupError('wrong_passphrase')
    }
    return plain
  } finally {
    sodium.sodium_memzero(key)
  }
}

/** The key as the bytes that get sealed. */
export function packKey({ keystore, password, notes = {}, made = new Date().toISOString() }) {
  const encoded = {}
  for (const [name, bytes] of Object.entries(notes)) encoded[name] = bytes.toString('base64')
  return Buffer.from(JSON.stringify({ format: 1, made, alias: ALIAS, keystore: keystore.toString('base64'), password, notes: encoded }), 'utf8')
}

/** The key back from opened bytes; only the known notes, so a copy never names a file to write. */
export function unpackKey(plain) {
  let v
  try {
    v = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new BackupError('bad_contents')
  }
  const ok =
    v && v.format === 1 && v.alias === ALIAS && typeof v.made === 'string' &&
    typeof v.keystore === 'string' && v.keystore.length > 0 &&
    typeof v.password === 'string' && v.password.length > 0 &&
    v.notes && typeof v.notes === 'object' && Object.entries(v.notes).every(([n, b]) => NOTES.includes(n) && typeof b === 'string')
  if (!ok) throw new BackupError('bad_contents')
  const notes = {}
  for (const [name, b64] of Object.entries(v.notes)) notes[name] = Buffer.from(b64, 'base64')
  return { made: v.made, keystore: Buffer.from(v.keystore, 'base64'), password: v.password, notes }
}

/**
 * A line typed with the echo off. Backspace deletes, Ctrl+C cancels, arrow keys and other escape sequences
 * are ignored. Never on a pipe: a passphrase is typed by a person.
 */
export function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new BackupError('no_terminal'))
      return
    }
    output.write(question)
    let typed = ''
    let escape = 0 // 1 right after ESC, 2 inside a CSI or SS3 sequence
    const finish = (error) => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      if (error) reject(error)
      else resolve(typed)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape === 1) {
          escape = ch === '[' || ch === 'O' ? 2 : 0
          continue
        }
        if (escape === 2) {
          if (ch >= '@' && ch <= '~') escape = 0
          continue
        }
        if (ch === '\x1b') escape = 1
        else if (ch === '\r' || ch === '\n') return finish(null)
        else if (ch === '\x03') return finish(new BackupError('cancelled'))
        else if (ch === '\x7f' || ch === '\b') typed = Array.from(typed).slice(0, -1).join('')
        else if (ch >= ' ') typed += ch
      }
    }
    input.setEncoding('utf8')
    input.setRawMode(true)
    input.on('data', onData)
    input.resume()
  })
}

const asBytes = (passphrase) => Buffer.from(passphrase.normalize('NFC'), 'utf8')

async function askNewPassphrase(d) {
  for (let tries = 0; tries < 3; tries++) {
    const first = await d.ask('Frase per la copia: ')
    if (Array.from(first).length < MIN_PASSPHRASE) {
      d.say(`Troppo corta: almeno ${MIN_PASSPHRASE} caratteri.`)
      continue
    }
    const again = await d.ask('Di nuovo, per conferma: ')
    if (again !== first) {
      d.say('Le due frasi non coincidono.')
      continue
    }
    return first
  }
  throw new BackupError('no_passphrase')
}

function keytoolPath() {
  const java = process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr'
  return path.join(java, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
}

/** The SHA-256 of the key's certificate (hex), or null when the password does not open the keystore. */
export function certDigest(keystoreFile, password, keytool = keytoolPath()) {
  const r = spawnSync(
    keytool,
    ['-list', '-keystore', keystoreFile, '-storetype', 'PKCS12', '-alias', ALIAS, '-storepass:env', 'MPFY_BACKUP_STOREPASS'],
    { env: { ...process.env, MPFY_BACKUP_STOREPASS: password }, encoding: 'latin1', windowsHide: true },
  )
  if (r.error) throw new BackupError('no_keytool', keytool)
  if (r.status !== 0) return null
  const m = /\(SHA-256\):\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/i.exec(r.stdout)
  return m ? m[1].replace(/:/g, '').toLowerCase() : null
}

// The same for keystore bytes not on disk yet: a private temporary folder, removed at once.
function digestOfBytes(keystore, password, keytool) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-key-'))
  try {
    const file = path.join(dir, KEYSTORE_NAME)
    fs.writeFileSync(file, keystore, { mode: 0o600 })
    return certDigest(file, password, keytool)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function releaseDigest() {
  const m = /^release_digest=([0-9a-f]{64})\r?$/m.exec(fs.readFileSync(path.join(here, 'release.sh'), 'utf8'))
  if (!m) throw new Error('android/release.sh has no release_digest')
  return m[1]
}

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/** The keystore password as android/release.sh reads it: pass.ps1 in `signDir`. */
export function readPassword(signDir) {
  const r = spawnSync('powershell.exe', [...POWERSHELL, '-File', path.join(signDir, 'pass.ps1')], { windowsHide: true })
  if (r.error || r.status !== 0) throw new BackupError('no_password')
  const password = r.stdout.toString('utf8').replace(/[\r\n]/g, '')
  if (!password) throw new BackupError('no_password')
  return password
}

// The password sealed with DPAPI for this Windows user, the way pass.ps1 reads it. It reaches PowerShell on
// its standard input (base64, so no code page can change it), never on a command line.
function protectPassword(password, file) {
  const script =
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; " +
    '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    '$e = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[IO.File]::WriteAllBytes($env:MPFY_BACKUP_OUT, $e)'
  const r = spawnSync('powershell.exe', [...POWERSHELL, '-Command', script], {
    input: Buffer.from(password, 'utf8').toString('base64'),
    env: { ...process.env, MPFY_BACKUP_OUT: file },
    windowsHide: true,
  })
  if (r.error || r.status !== 0) throw new BackupError('protect_failed')
}

async function openCopy(target, d) {
  const sealed = fs.readFileSync(path.resolve(target))
  const passphrase = asBytes(await d.ask('Frase della copia: '))
  d.say('Apro la copia...')
  try {
    const key = unpackKey(open(sealed, passphrase))
    const digest = digestOfBytes(key.keystore, key.password, d.keytool)
    if (digest === null) throw new BackupError('password_mismatch')
    if (digest !== d.releaseDigest) throw new BackupError('not_release_key')
    return { key, digest }
  } finally {
    passphrase.fill(0)
  }
}

async function exportCopy(target, d) {
  const out = path.resolve(target)
  if (fs.existsSync(out)) throw new BackupError('exists', out)
  const keystore = fs.readFileSync(d.keystore)
  const password = d.password()
  const digest = certDigest(d.keystore, password, d.keytool)
  if (digest === null) throw new BackupError('password_mismatch')
  if (digest !== d.releaseDigest) throw new BackupError('not_release_key')
  const notes = {}
  for (const name of NOTES) {
    try {
      notes[name] = fs.readFileSync(path.join(d.signDir, name))
    } catch {}
  }
  const passphrase = asBytes(await askNewPassphrase(d))
  d.say('Preparo la copia...')
  const plain = packKey({ keystore, password, notes })
  try {
    const sealed = seal(plain, passphrase, d.cost)
    fs.writeFileSync(out, sealed, { flag: 'wx', mode: 0o600 })
    // Called good only once the file on disk opens again, with the same passphrase, to the same key.
    let back = null
    try {
      back = unpackKey(open(fs.readFileSync(out), passphrase))
    } catch {}
    if (!back || !back.keystore.equals(keystore) || back.password !== password) {
      fs.rmSync(out, { force: true })
      throw new BackupError('verify_failed')
    }
    d.say(`Copia fatta e riaperta: ${out}`)
    d.say(`${sealed.length} byte, SHA-256 ${sha256(sealed)}`)
    d.say(`Chiave: ${colons(digest)}`)
    d.say('Si apre solo con la frase: tienila nel tuo gestore di password. Senza la frase la copia non serve.')
  } finally {
    plain.fill(0)
    passphrase.fill(0)
  }
}

async function checkCopy(target, d) {
  const { key, digest } = await openCopy(target, d)
  let mine
  try {
    mine = fs.readFileSync(d.keystore).equals(key.keystore) ? 'uguale' : 'diversa'
  } catch {
    mine = 'su questo PC non c\'è'
  }
  d.say(`La copia è buona: contiene la chiave delle versioni MPfy, copiata il ${key.made.slice(0, 10)}.`)
  d.say(`Chiave: ${colons(digest)}`)
  d.say(`Quella su questo PC: ${mine}.`)
}

async function restoreCopy(target, dir, d) {
  if (process.platform !== 'win32') throw new BackupError('windows_only')
  const into = path.resolve(dir || d.signDir)
  const keystoreFile = path.join(into, KEYSTORE_NAME)
  if (fs.existsSync(keystoreFile)) throw new BackupError('exists', keystoreFile)
  const { key } = await openCopy(target, d)
  fs.mkdirSync(into, { recursive: true })
  // The keystore is written last: a restore stopped halfway leaves no keystore, so it may simply run again.
  protectPassword(key.password, path.join(into, PASS_NAME))
  fs.writeFileSync(path.join(into, 'pass.ps1'), PASS_PS1)
  for (const [name, bytes] of Object.entries(key.notes)) fs.writeFileSync(path.join(into, name), bytes)
  fs.writeFileSync(keystoreFile, key.keystore, { flag: 'wx' })
  // Read back the way a release reads it: pass.ps1 gives the password, and it opens the keystore.
  let ok = false
  try {
    ok = readPassword(into) === key.password && certDigest(keystoreFile, key.password, d.keytool) === d.releaseDigest
  } catch {}
  if (!ok) throw new BackupError('restore_failed')
  d.say(`Chiave rimessa in ${into}: le prossime versioni si firmano di nuovo con questa.`)
}

const USAGE = [
  'node android/key-backup.mjs export <file>         copia cifrata della chiave di firma',
  'node android/key-backup.mjs check <file>          controlla una copia',
  'node android/key-backup.mjs restore <file> [dir]  rimette la chiave (Windows, di base in ~/.mpfy-sign)',
].join('\n')

export function defaultDeps() {
  const signDir = path.join(os.homedir(), '.mpfy-sign')
  return {
    signDir,
    keystore: process.env.MPFY_KEYSTORE || path.join(signDir, KEYSTORE_NAME),
    password: () => process.env.MPFY_KEYSTORE_PASS || readPassword(signDir),
    keytool: keytoolPath(),
    releaseDigest: releaseDigest(),
    cost: COST,
    ask: (question) => askHidden(question),
    say: (line) => console.log(line),
  }
}

/** The exit code: 0 done, 1 refused (the reason said), 2 how to use it. */
export async function run(argv, d = defaultDeps()) {
  const [cmd, file, dir] = argv
  try {
    if (cmd === 'export' && file) await exportCopy(file, d)
    else if (cmd === 'check' && file) await checkCopy(file, d)
    else if (cmd === 'restore' && file) await restoreCopy(file, dir, d)
    else {
      d.say(USAGE)
      return 2
    }
    return 0
  } catch (e) {
    if (e instanceof BackupError) {
      d.say(MESSAGES[e.code](e.detail))
      return 1
    }
    if (e && e.code === 'ENOENT') {
      d.say(`Non trovo ${e.path}.`)
      return 1
    }
    throw e
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()
if (invoked) process.exitCode = await run(process.argv.slice(2))
