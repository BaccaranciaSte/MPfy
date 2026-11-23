// client-node as a command: it runs when started through a junction or a
// symbolic link to its folder, the files next to its state (which hold the
// private key seed) are never picked up by git, and a profile code is read from
// its input, never from the command line. No network.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpDir, rmDir } from './helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_NODE = path.join(ROOT, 'client-node')

function run (script, args, dir) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MPFY_CLIENT_STATE: path.join(dir, 'state.json'), MPFY_CLIENT_PORT: '' }
  })
}

test('client-node runs when started through a junction or a symbolic link to its folder', (t) => {
  const dir = tmpDir('mpfy-cli-link-')
  const link = path.join(dir, 'client-node-link')
  fs.symlinkSync(CLIENT_NODE, link, 'junction') // a junction on Windows, a symlink elsewhere
  t.after(() => {
    // Remove the link itself, never what it points to; only then the folder.
    try {
      fs.unlinkSync(link)
    } catch {
      try {
        fs.rmdirSync(link)
      } catch {}
    }
    let gone = false
    try {
      fs.lstatSync(link)
    } catch (err) {
      gone = err.code === 'ENOENT'
    }
    if (gone) rmDir(dir)
  })
  assert.ok(fs.lstatSync(link).isSymbolicLink())

  const direct = run(path.join(CLIENT_NODE, 'index.mjs'), ['comando-inventato'], dir)
  assert.equal(direct.status, 1)
  assert.match(direct.stderr, /^Errore: comando sconosciuto: comando-inventato /)

  const linked = run(path.join(link, 'index.mjs'), ['comando-inventato'], dir)
  assert.equal(linked.status, 1, 'not a silent exit 0: ' + JSON.stringify(linked.stderr))
  assert.equal(linked.stderr, direct.stderr)
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'nothing written for a wrong command')
})

test('the files next to client-node/state.json are ignored by git, like the state itself', (t) => {
  const names = ['state.json', 'state.json.tmp', 'state.json.corrupt-1763390000000', 'state.json.lock', 'state.json.lock.1234.tmp']
  const r = spawnSync('git', ['check-ignore', '--no-index', '--verbose', ...names.map((n) => 'client-node/' + n)], { cwd: ROOT, encoding: 'utf8' })
  if (r.error || r.status === 128) {
    t.skip('git is not available here')
    return
  }
  const ignored = r.stdout.split('\n').filter(Boolean).map((line) => line.split('\t').pop().replace(/\\/g, '/'))
  assert.deepEqual(ignored.sort(), names.map((n) => 'client-node/' + n).sort(), r.stdout)
  const kept = spawnSync('git', ['check-ignore', '--no-index', '-q', 'client-node/index.mjs'], { cwd: ROOT })
  assert.equal(kept.status, 1, 'the code itself is not ignored')
})

test('client-node reads a profile code from its input: the first line, piped or typed; the process ends without waiting for more', async (t) => {
  const script = 'import(' + JSON.stringify(pathToFileURL(path.join(CLIENT_NODE, 'index.mjs')).href) + ')' +
    '.then((m) => m.readLine(process.stdin)).then((line) => console.log(JSON.stringify(line)))'
  const piped = spawnSync(process.execPath, ['-e', script], { input: '  mpfy-p-abcd efgh \r\naltro\n', encoding: 'utf8', timeout: 30000 })
  assert.equal(piped.status, 0, piped.stderr)
  assert.equal(piped.stdout, '"mpfy-p-abcd efgh"\n')
  const nothing = spawnSync(process.execPath, ['-e', script], { input: '', encoding: 'utf8', timeout: 30000 })
  assert.equal(nothing.status, 0, nothing.stderr)
  assert.equal(nothing.stdout, '""\n')

  // Typed: the input stays open after the line, and the process still ends.
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  const ended = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 15000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  child.stdin.write('MPFY-P-1234\n')
  assert.equal(await ended, 0)
  assert.equal(out, '"MPFY-P-1234"\n')

  // The command alone reads it too, and an empty line is a usage error.
  const dir = tmpDir('mpfy-cli-input-')
  t.after(() => rmDir(dir))
  const r = spawnSync(process.execPath, [path.join(CLIENT_NODE, 'index.mjs'), 'profile', 'import'], {
    input: '\n',
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MPFY_CLIENT_STATE: path.join(dir, 'state.json'), MPFY_CLIENT_PORT: '' }
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^Errore: uso: node client-node\/index\.mjs profile import /)
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false)
})
