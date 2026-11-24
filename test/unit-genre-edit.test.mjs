import test from 'node:test'
import assert from 'node:assert/strict'
import { createMPfy } from '../server/app.mjs'
import { tmpDir, cleanup, request, json, makeMp3, testWhoIs } from './helpers.mjs'

test('the genres a person writes are the song\'s: answered, kept over the tags, empty leaves it to the catalogs', async (t) => {
  const c = cleanup(t)
  const app = c.close(await createMPfy({ dataDir: c.dir(tmpDir()), port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs }))
  await app.jobsStarted
  const port = app.ports.http
  const tcon = [['TCON', Buffer.concat([Buffer.from([0]), Buffer.from('Rock', 'latin1')])]]
  const up = json(await request(port, 'PUT', '/api/upload/a.mp3', { body: makeMp3({ frames: 60, title: 'Uno', artist: 'A', album: 'B', extraFrames: tcon }) })).track
  assert.deepEqual(up.genres, ['Rock'])
  let r = await request(port, 'PATCH', '/api/tracks/' + up.id, { body: { genres: ['Anime', ' J-Pop ', 'anime'] } })
  assert.equal(r.status, 200)
  assert.deepEqual(json(r).track.genres, ['Anime', 'J-Pop'], 'cleaned, one of each')
  assert.deepEqual(app.library.getTrack(up.id).genres, ['Anime', 'J-Pop'])
  r = await request(port, 'PATCH', '/api/tracks/' + up.id, { body: { genres: 'Soundtrack; Musical' } })
  assert.deepEqual(json(r).track.genres, ['Soundtrack', 'Musical'], 'a text is cut like a tag')
  r = await request(port, 'PATCH', '/api/tracks/' + up.id, { body: { genres: [] } })
  assert.equal(json(r).track.genres, undefined, 'none: left to the catalogs')
  assert.deepEqual(app.library.getTrack(up.id).genres, [])
})
