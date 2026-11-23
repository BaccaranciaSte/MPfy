// Log lines start with the local time as the shell scripts write it
// (date '+%Y-%m-%d %H:%M:%S'), in the zone the process runs with.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const util = new URL('../server/util.mjs', import.meta.url).href

test('log: a child with TZ=Asia/Tokyo prefixes its local time YYYY-MM-DD HH:MM:SS, no T, no Z; logError too', () => {
  const before = Date.now()
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'import { log, logError } from ' + JSON.stringify(util) + '; log("avvio"); logError("guasto")'], {
    env: { ...process.env, TZ: 'Asia/Tokyo' },
    cwd: fileURLToPath(new URL('..', import.meta.url))
  })
  const after = Date.now()
  assert.equal(r.status, 0, String(r.stderr))
  const out = String(r.stdout).trim()
  const err = String(r.stderr).trim()
  const re = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) /
  for (const [line, word] of [[out, 'avvio'], [err, 'guasto']]) {
    const m = re.exec(line)
    assert.ok(m, line)
    assert.equal(line.slice(m[0].length), word)
    assert.doesNotMatch(line, /T\d\d:|Z\b/)
    // Tokyo is UTC+9 all year: read the stamp as if it were UTC, minus 9 hours.
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 9 * 3600e3
    assert.ok(at >= Math.floor(before / 1000) * 1000 - 1000 && at <= after + 1000, line + ' is not Tokyo time')
  }
})
