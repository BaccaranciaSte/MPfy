import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyPatch, hunksOf } from '../scripts/apply-patches.mjs'
import { tmpDir, cleanup } from './helpers.mjs'

const PATCH = ['--- a/lib/x.js', '+++ b/lib/x.js', '@@ -1,3 +1,3 @@', ' uno', '-due', '+DUE', ' tre', ''].join('\n')

test('a patch applies once, a second run changes nothing, another version stops it', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'lib'))
  fs.writeFileSync(path.join(dir, 'lib/x.js'), 'zero\nuno\ndue\ntre\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
  assert.equal(hunksOf(PATCH).length, 1)
  assert.equal(applyPatch(PATCH, dir, '1.0.0'), 1)
  assert.equal(fs.readFileSync(path.join(dir, 'lib/x.js'), 'utf8'), 'zero\nuno\nDUE\ntre\n')
  assert.equal(applyPatch(PATCH, dir, '1.0.0'), 0)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0' }))
  assert.throws(() => applyPatch(PATCH, dir, '1.0.0'), /is 1\.1\.0, the patch is for 1\.0\.0/)
})

test('the phone gets the patches and what applies them', () => {
  const sh = fs.readFileSync(new URL('../deploy/push-to-phone.sh', import.meta.url), 'utf8')
  const listed = sh.split('\n').find((l) => l.includes('tar --force-local -cf')).split(/\s+/)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts.postinstall, 'node scripts/apply-patches.mjs')
  assert.ok(listed.includes('patches') && listed.includes('scripts/apply-patches.mjs'))
})
