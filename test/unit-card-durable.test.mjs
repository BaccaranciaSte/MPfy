// A file moved onto the memory card is on the card for good before its copy in
// internal memory goes: the rename is synced to the card first.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpDir, cleanup, shardPath } from './helpers.mjs'
import { cardEnv, startWithCard, useCard, settle, hiWav } from './card-env.mjs'

test('card: a moved original is synced under its new name on the card while its internal copy is still there', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const env = cardEnv(c, dir)
  const s = await startWithCard(c, env, dir)
  const a = await s.upload('a.wav', hiWav(730))
  await settle(s.app)
  const name = a.id + '.wav'
  let internalAtSync = null
  env.st.openHook = async (file, flags) => {
    if (flags === 'r+' && file.endsWith(name) && !file.includes('mv-') && internalAtSync === null) {
      internalAtSync = fs.existsSync(shardPath(dir, 'library', name))
    }
  }
  await useCard(s)
  const rename = env.st.log.findIndex((l) => l.startsWith('rename') && l.endsWith(name))
  assert.ok(rename !== -1, 'renamed into its shard on the card')
  const dest = env.st.log[rename].split(' -> ')[1]
  const synced = env.st.log.findIndex((l, i) => i > rename && l === 'fsync ' + dest)
  assert.ok(synced !== -1, 'synced at its new name after the rename: ' + JSON.stringify(env.st.log.slice(rename)))
  assert.equal(internalAtSync, true, 'the internal copy still there when the card copy is synced')
  assert.ok(!fs.existsSync(shardPath(dir, 'library', name)), 'then the internal copy goes')
})
