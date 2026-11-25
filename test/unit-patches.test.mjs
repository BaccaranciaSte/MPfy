import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyPatch, hunksOf } from '../scripts/apply-patches.mjs'
import { tmpDir, cleanup } from './helpers.mjs'

const patchFile = new URL('../patches/hyperdht@6.36.0.patch', import.meta.url)
const installed = (f) => fs.readFileSync(new URL('../node_modules/hyperdht/lib/' + f, import.meta.url), 'utf8')

test('the installed hyperdht carries the LAN shortcut fix', () => {
  assert.ok(installed('connect.js').includes('c.lanPending = true'))
  assert.ok(installed('server.js').includes('MPfy patch: the client races its LAN ping'))
})

test('a patch applies once, a second run changes nothing, another version stops it', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const patch = fs.readFileSync(patchFile, 'utf8')
  fs.mkdirSync(path.join(dir, 'lib'))
  // The files as they were before the fix: each hunk's text before it.
  const before = {}
  for (const h of hunksOf(patch)) before[h.file] = (before[h.file] || '') + h.from + '\n// between\n'
  for (const [f, s] of Object.entries(before)) fs.writeFileSync(path.join(dir, f), s)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hyperdht', version: '6.36.0' }))
  assert.equal(applyPatch(patch, dir, '6.36.0'), hunksOf(patch).length)
  const once = fs.readFileSync(path.join(dir, 'lib/server.js'), 'utf8')
  assert.equal(applyPatch(patch, dir, '6.36.0'), 0)
  assert.equal(fs.readFileSync(path.join(dir, 'lib/server.js'), 'utf8'), once)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hyperdht', version: '6.37.0' }))
  assert.throws(() => applyPatch(patch, dir, '6.36.0'), /is 6\.37\.0, the patch is for 6\.36\.0/)
})

test('the phone gets the patches and what applies them', () => {
  const sh = fs.readFileSync(new URL('../deploy/push-to-phone.sh', import.meta.url), 'utf8')
  const listed = sh.split('\n').find((l) => l.includes('tar --force-local -cf')).split(/\s+/)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts.postinstall, 'node scripts/apply-patches.mjs')
  assert.ok(listed.includes('patches') && listed.includes('scripts/apply-patches.mjs'))
})
