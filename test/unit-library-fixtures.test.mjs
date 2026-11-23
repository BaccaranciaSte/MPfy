// The library answers stay the same: every history of fixtures-library.mjs is
// played again on this code, and every answer it keeps must equal its saved file
// under test/fixtures/library-v3/, byte for byte once versions, times and the
// ETag are masked (see the top of fixtures-library.mjs). None of these requests
// sends the delta parameters, so a source that answers deltas must still give
// exactly these answers to them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { HISTORIES, runHistory, savedFiles, firstDifference, maskBody, maskEtag, maskTime, CLOCK_BASE } from './fixtures-library.mjs'

test('the masks: times on the step clock, versions, the ETag; a body not in canonical form is refused', () => {
  assert.equal(maskTime(CLOCK_BASE + 12000), '@12')
  assert.equal(maskTime(CLOCK_BASE - 1500), '@-1.5')
  assert.equal(maskEtag('W/"owner.1767225600001.1767225600002"'), 'W/"owner.*"')
  assert.equal(maskEtag('W/"0123456789abcdef0123456789abcdef.1.2.0011223344556677.8899aabbccddeeff"'), 'W/"0123456789abcdef0123456789abcdef.*"')
  const body = JSON.stringify({ version: 5, userVersion: 6, tracks: [{ id: 'a', addedAt: CLOCK_BASE + 3000, duration: 4 }], likes: [{ id: 'b', at: CLOCK_BASE }] })
  assert.equal(maskBody(body, { library: true }), '{"version":"<version>","userVersion":"<userVersion>","tracks":[{"id":"a","addedAt":"@3","duration":4}],"likes":[{"id":"b","at":"@0"}]}')
  assert.equal(maskBody('{"version":5}'), '{"version":5}', 'versions are masked in library answers only')
  assert.throws(() => maskBody('{ "a": 1 }'), /JSON.stringify/)
})

for (const name of Object.keys(HISTORIES)) {
  test('library answers as saved: ' + name, async () => {
    const saved = savedFiles(name)
    const got = await runHistory(name)
    assert.ok(saved.length > 0, 'saved answers of ' + name)
    assert.deepEqual(got.map((f) => f.name), saved.map((f) => f.name), 'the same exchanges, in the same order')
    for (let i = 0; i < saved.length; i++) {
      const diff = firstDifference(saved[i].text, got[i].text)
      if (diff !== null) assert.fail(name + '/' + saved[i].name + ' differs ' + diff)
    }
  })
}
