// The copy of the release signing key (android/key-backup.mjs): the seal (any change to the file or a wrong
// passphrase opens nothing), the contents (a copy never names a file to write), the hidden prompt, and the
// three commands end to end on a throwaway keystore (export, check, restore; never over a key already there).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import sodium from 'sodium-native'
import {
  seal, open, packKey, unpackKey, askHidden, certDigest, readPassword, run,
  BackupError, HEADER_BYTES, MIN_PASSPHRASE,
} from '../android/key-backup.mjs'

const CHEAP = { ops: sodium.crypto_pwhash_OPSLIMIT_MIN, mem: sodium.crypto_pwhash_MEMLIMIT_MIN }
const pass = (s) => Buffer.from(s, 'utf8')
const refused = (fn, code) => assert.throws(fn, (e) => e instanceof BackupError && e.code === code)

test('a sealed copy opens with its passphrase and with nothing else', () => {
  const plain = Buffer.from('the key and its password')
  const file = seal(plain, pass('una frase lunga abbastanza'), CHEAP)
  assert.deepEqual(open(file, pass('una frase lunga abbastanza')), plain)
  refused(() => open(file, pass('una frase lunga abbastanzA')), 'wrong_passphrase')
  // Two copies of the same thing never look alike (fresh salt and nonce).
  assert.notDeepEqual(seal(plain, pass('una frase lunga abbastanza'), CHEAP), file)
})

test('every byte of a copy is covered: a change anywhere opens nothing', () => {
  const p = pass('una frase lunga abbastanza')
  const file = seal(Buffer.from('the key and its password'), p, CHEAP)
  for (let i = 0; i < file.length; i++) {
    const bad = Buffer.from(file)
    bad[i] ^= 1
    assert.throws(() => open(bad, p), (e) => e instanceof BackupError && (e.code === 'wrong_passphrase' || e.code === 'not_a_copy'), `byte ${i}`)
  }
  refused(() => open(file.subarray(0, HEADER_BYTES + 15), p), 'not_a_copy')
  refused(() => open(Buffer.alloc(0), p), 'not_a_copy')
})

test('a header asking for an absurd cost is refused before any work', () => {
  const p = pass('una frase lunga abbastanza')
  const file = seal(Buffer.from('x'), p, CHEAP)
  const ops = Buffer.from(file)
  ops.writeUInt32LE(1000, 8)
  refused(() => open(ops, p), 'not_a_copy')
  const mem = Buffer.from(file)
  mem.writeUInt32LE(0xffffffff, 12)
  refused(() => open(mem, p), 'not_a_copy')
})

test('the contents round trip, and a copy never names a file of its own choosing', () => {
  const keystore = Buffer.from([1, 2, 3, 250])
  const back = unpackKey(packKey({ keystore, password: 'pw', notes: { 'LEGGIMI.txt': Buffer.from('nota') } }))
  assert.deepEqual(back.keystore, keystore)
  assert.equal(back.password, 'pw')
  assert.equal(back.notes['LEGGIMI.txt'].toString(), 'nota')
  const forged = (o) => Buffer.from(JSON.stringify({ format: 1, made: 'x', alias: 'mpfy', keystore: 'AQ==', password: 'pw', notes: {}, ...o }))
  refused(() => unpackKey(forged({ notes: { '../pass.ps1': 'AA==' } })), 'bad_contents')
  refused(() => unpackKey(forged({ notes: { 'pass.ps1': 'AA==' } })), 'bad_contents')
  refused(() => unpackKey(forged({ password: '' })), 'bad_contents')
  refused(() => unpackKey(forged({ format: 2 })), 'bad_contents')
  refused(() => unpackKey(Buffer.from('not json')), 'bad_contents')
})

function fakeTerminal() {
  const input = new PassThrough()
  input.isTTY = true
  input.raw = []
  input.setRawMode = (on) => {
    input.raw.push(on)
    return input
  }
  const output = new PassThrough()
  let shown = ''
  output.on('data', (b) => (shown += b))
  return { input, output, shown: () => shown }
}

test('the prompt shows nothing typed, edits, ignores arrows, and leaves the terminal as it was', async () => {
  const t = fakeTerminal()
  const typed = askHidden('Frase: ', t)
  t.input.write('ab\x7fc')
  t.input.write('\x1b[D\x1bOH')
  t.input.write('dè\r')
  assert.equal(await typed, 'acdè')
  assert.equal(t.shown(), 'Frase: \n')
  assert.deepEqual(t.input.raw, [true, false])
  assert.equal(t.input.listenerCount('data'), 0)
})

test('the prompt stops on Ctrl+C and never reads a pipe', async () => {
  const t = fakeTerminal()
  const typed = askHidden('Frase: ', t)
  t.input.write('abc\x03')
  await assert.rejects(typed, (e) => e.code === 'cancelled')
  assert.deepEqual(t.input.raw, [true, false])
  const pipe = new PassThrough()
  await assert.rejects(askHidden('Frase: ', { input: pipe, output: new PassThrough() }), (e) => e.code === 'no_terminal')
})

// End to end on a keystore made for the test, the way the real one was made (PKCS12, alias mpfy).
const keytool = path.join(process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr', 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
const haveKeytool = fs.existsSync(keytool)

function throwawayKey(dir, password) {
  const file = path.join(dir, 'mpfy-release.jks')
  const r = spawnSync(keytool, [
    '-genkeypair', '-keystore', file, '-storetype', 'PKCS12', '-alias', 'mpfy', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '2', '-dname', 'CN=prova', '-storepass:env', 'P', '-keypass:env', 'P',
  ], { env: { ...process.env, P: password }, windowsHide: true })
  assert.equal(r.status, 0, String(r.stderr))
  return file
}

function deps(signDir, keystore, password, digest, answers, said) {
  return {
    signDir,
    keystore,
    password: () => password,
    keytool,
    releaseDigest: digest,
    cost: CHEAP,
    ask: async () => {
      assert.ok(answers.length > 0, 'asked more than expected')
      return answers.shift()
    },
    say: (line) => said.push(line),
  }
}

test('export, check and restore a key end to end', { skip: !haveKeytool && 'no keytool' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-keytest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const signDir = path.join(root, 'sign')
  fs.mkdirSync(signDir)
  const password = 'pw-' + Date.now()
  const keystore = throwawayKey(signDir, password)
  fs.writeFileSync(path.join(signDir, 'LEGGIMI.txt'), 'nota della chiave')
  fs.writeFileSync(path.join(signDir, 'keytool-list.log'), 'never copied')
  const digest = certDigest(keystore, password, keytool)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(certDigest(keystore, password + 'x', keytool), null)
  const phrase = 'una frase lunga abbastanza'
  const copy = path.join(root, 'copia.bin')

  // Too short first, then two that differ, then right: three tries.
  let said = []
  assert.equal(await run(['export', copy], deps(signDir, keystore, password, digest, ['corta', phrase, phrase + '!', phrase, phrase], said)), 0)
  assert.ok(said.some((l) => l.includes(`almeno ${MIN_PASSPHRASE}`)))
  assert.ok(said.some((l) => l.includes('non coincidono')))
  assert.ok(fs.existsSync(copy))
  const opened = unpackKey(open(fs.readFileSync(copy), pass(phrase)))
  assert.deepEqual(opened.keystore, fs.readFileSync(keystore))
  assert.equal(opened.password, password)
  assert.deepEqual(Object.keys(opened.notes), ['LEGGIMI.txt'])
  assert.ok(!fs.readFileSync(copy).includes(Buffer.from(password)), 'the password is sealed')

  // Never over a file already there; never a key that is not the release one; never a password that does not open it.
  said = []
  assert.equal(await run(['export', copy], deps(signDir, keystore, password, digest, [], said)), 1)
  assert.match(said.join('\n'), /già/)
  const other = path.join(root, 'altra.bin')
  assert.equal(await run(['export', other], deps(signDir, keystore, password, 'f'.repeat(64), [], (said = []))), 1)
  assert.match(said.join('\n'), /non è la chiave/)
  assert.equal(await run(['export', other], deps(signDir, keystore, password + 'x', digest, [], (said = []))), 1)
  assert.match(said.join('\n'), /non apre il keystore/)
  assert.equal(await run(['export', other], deps(signDir, keystore, password, digest, ['a', 'b', 'c'], (said = []))), 1)
  assert.ok(!fs.existsSync(other))

  // Check: the right phrase says good and same; a wrong one says so; another key is told apart.
  said = []
  assert.equal(await run(['check', copy], deps(signDir, keystore, password, digest, [phrase], said)), 0)
  assert.match(said.join('\n'), /La copia è buona/)
  assert.match(said.join('\n'), /: uguale\./)
  assert.equal(await run(['check', copy], deps(signDir, keystore, password, digest, [phrase + '?'], (said = []))), 1)
  assert.match(said.join('\n'), /frase non apre/)
  assert.equal(await run(['check', copy], deps(signDir, keystore, password, 'f'.repeat(64), [phrase], (said = []))), 1)
  assert.match(said.join('\n'), /non è la chiave/)
  assert.equal(await run(['check', path.join(root, 'nessuna.bin')], deps(signDir, keystore, password, digest, [], (said = []))), 1)
  assert.match(said.join('\n'), /Non trovo/)

  if (process.platform !== 'win32') return
  // Restore into an empty folder: the key, the password readable by pass.ps1 as release.sh reads it, the note.
  const into = path.join(root, 'nuovo')
  assert.equal(await run(['restore', copy, into], deps(signDir, keystore, password, digest, [phrase], (said = []))), 0)
  assert.match(said.join('\n'), /Chiave rimessa/)
  assert.deepEqual(fs.readFileSync(path.join(into, 'mpfy-release.jks')), fs.readFileSync(keystore))
  assert.equal(readPassword(into), password)
  assert.equal(fs.readFileSync(path.join(into, 'LEGGIMI.txt'), 'utf8'), 'nota della chiave')
  assert.ok(!fs.existsSync(path.join(into, 'keytool-list.log')))
  assert.ok(!fs.readFileSync(path.join(into, 'mpfy-release.pass.dpapi')).includes(Buffer.from(password)))
  // Never over a key already there, and the one there is left exactly as it was.
  const before = fs.readFileSync(path.join(into, 'mpfy-release.jks'))
  assert.equal(await run(['restore', copy, into], deps(signDir, keystore, password, digest, [phrase], (said = []))), 1)
  assert.match(said.join('\n'), /già/)
  assert.deepEqual(fs.readFileSync(path.join(into, 'mpfy-release.jks')), before)
  // A wrong phrase writes nothing at all.
  const empty = path.join(root, 'vuoto')
  assert.equal(await run(['restore', copy, empty], deps(signDir, keystore, password, digest, [phrase + '?'], (said = []))), 1)
  assert.ok(!fs.existsSync(empty))
})

test('the commands say how to use them when called wrong', async () => {
  const said = []
  assert.equal(await run([], { say: (l) => said.push(l) }), 2)
  assert.equal(await run(['export'], { say: (l) => said.push(l) }), 2)
  assert.match(said.join('\n'), /export <file>/)
})
