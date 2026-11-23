// Covers and transcodes with a FAKE ffmpeg (test/fake-ffmpeg.mjs;
// the real one is tested on the Mi A2): the background queue (one job at a time,
// covers then high, normal, low, exact arguments), levels skipped at >= 90% of the
// original bitrate, ?q= with its fallbacks and X-MPfy-Quality, Range on
// transcodes, the LRU cap, failures, ?size= on covers, no ffmpeg at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { FfmpegRunner, transcodeArgs, coverArgs } from '../server/ffmpeg.mjs'
import { fallbackOrder, isSkipped } from '../server/jobs.mjs'
import { saveCoverBytes, coverHashParts } from '../server/media.mjs'
import { makeWav, makeMp3, fakePng, tmpDir, cleanup, request, json, fakeFfmpeg, waitFor, shardPath, treeFiles } from './helpers.mjs'

const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)
// 1 s of 16-bit mono PCM at 44.1 kHz: 705.6 kbps, every level is worth making.
const hiWav = (freq) => makeWav({ seconds: 1, sampleRate: 44100, freq })
const jobCalls = (fake) => fake.calls().filter((c) => !c.args.includes('-encoders'))
// A transcode by its bitrate; the decode of the quality analysis; a cover.
const rateOf = (call) => (call.args.includes('libopus') ? call.args[call.args.indexOf('-b:a') + 1] : call.args.includes('f32le') ? 'quality' : 'cover')

// `dir`: a data dir the test made (and handed to cleanup(t).dir) to restart on.
async function start (t, { control = {}, cap, dir = null, ffmpeg } = {}) {
  const c = cleanup(t)
  const work = c.dir(tmpDir('mpfy-ff-'))
  const fake = fakeFfmpeg(work, control)
  const dataDir = dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir,
    port: 0,
    adminPort: 0,
    p2p: false,
    debounceMs: 10,
    ffmpeg: ffmpeg === undefined ? fake.command : ffmpeg,
    ...(cap !== undefined ? { transcodeCapBytes: cap } : {})
  }))
  await app.jobsStarted
  const port = app.ports.http
  const upload = async (name, body) => {
    const r = await request(port, 'PUT', '/api/upload/' + encodeURIComponent(name), { body })
    assert.equal(r.status, 200, r.body.toString())
    return json(r).track
  }
  return { app, dir: dataDir, port, fake, upload }
}

const transcodeFile = (dir, id, level) => shardPath(dir, 'transcodes', id + '.' + level + '.opus')

test('levels: fallback order and the 90% rule', () => {
  assert.deepEqual(fallbackOrder('high'), ['high', 'normal', 'low'])
  assert.deepEqual(fallbackOrder('normal'), ['normal', 'low', 'high'])
  assert.deepEqual(fallbackOrder('low'), ['low', 'normal', 'high'])
  const mp3 = { bitrate: 128000 }
  assert.equal(isSkipped(mp3, 'high'), true, '160 >= 0.9 * 128')
  assert.equal(isSkipped(mp3, 'normal'), false)
  assert.equal(isSkipped({ bitrate: 106000 }, 'normal'), true, '96 >= 0.9 * 106')
  assert.equal(isSkipped({ bitrate: 107000 }, 'normal'), false)
  assert.equal(isSkipped({ bitrate: null, size: 3_000_000, duration: 100 }, 'high'), false, '240 kbps estimated from size and duration')
  assert.equal(isSkipped({ bitrate: null, size: 2_000_000, duration: 100 }, 'high'), true, '160 kbps estimated: high saves nothing')
  assert.equal(isSkipped({ bitrate: null, size: 1_000_000, duration: 100 }, 'normal'), true, '80 kbps estimated')
  assert.equal(isSkipped({ bitrate: null, size: 10, duration: null }, 'low'), false, 'unknown: everything is made')
})

test('ffmpeg: exact arguments; nice -n 19 on Linux; a .mjs command runs with Node', () => {
  const args = transcodeArgs('/in.flac', 160, '/tmp/out.part')
  assert.deepEqual(args, ['-nostdin', '-v', 'error', '-i', '/in.flac', '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', '160k', '-vbr', 'on', '-compression_level', '5', '-f', 'ogg', '/tmp/out.part'])
  assert.equal(new FfmpegRunner({ command: 'ffmpeg', nice: true }).commandLine(args),
    'nice -n 19 ffmpeg -nostdin -v error -i /in.flac -map 0:a:0 -vn -c:a libopus -b:a 160k -vbr on -compression_level 5 -f ogg /tmp/out.part')
  assert.match(new FfmpegRunner({ command: 'ffmpeg', nice: false }).commandLine(args), /^ffmpeg -nostdin /)
  assert.equal(new FfmpegRunner({ command: 'ffmpeg' }).nice, process.platform === 'linux')
  const viaNode = new FfmpegRunner({ command: '/x/fake.mjs', nice: true }).commandLine(['-version'])
  assert.ok(viaNode.endsWith(' /x/fake.mjs -version') && !viaNode.startsWith('nice'), viaNode)
  assert.deepEqual(coverArgs('/c.png', 160, '/o.part'), ['-nostdin', '-v', 'error', '-i', '/c.png', '-vf',
    "scale=w='min(160,iw)':h='min(160,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3',
    '-c:v', 'mjpeg', '-f', 'image2', '-update', '1', '/o.part'])
})

test('after an upload: covers first, then high, normal, low; ONE job at a time; exact arguments; qualities in the library', async (t) => {
  const { app, dir, port, fake, upload } = await start(t, { control: { delayMs: 120 } })
  assert.equal(json(await request(port, 'GET', '/api/health')).ffmpeg, true)
  const png = fakePng(3)
  const mp3 = await upload('a.mp3', makeMp3({ title: 'Mp3', cover: png, frames: 60 })) // 128 kbps
  const wav = await upload('b.wav', hiWav(330))
  assert.deepEqual(mp3.qualities, { low: false, normal: false, high: false }, 'nothing ready at upload time')
  const versionBefore = app.library.version
  await app.jobs.idle()

  const calls = jobCalls(fake)
  assert.deepEqual(calls.map(rateOf), ['cover', 'cover', 'quality', '96k', '48k', 'quality', '160k', '96k', '48k'],
    'mp3: covers, its quality analysis, normal, low (high skipped); wav: its analysis, then high, normal, low')
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].start >= calls[i - 1].end, 'job ' + i + ' started before job ' + (i - 1) + ' ended')
  }
  // Exact transcode arguments, into tmp/, from the original in library/.
  const high = calls[6].args
  const out = high[high.length - 1]
  assert.deepEqual(high.slice(0, -1), transcodeArgs(shardPath(dir, 'library', wav.id + '.wav'), 160, 'X').slice(0, -1))
  assert.equal(path.dirname(out), path.join(dir, 'tmp'))
  const smallCover = calls[0].args
  assert.equal(smallCover[smallCover.indexOf('-i') + 1], path.join(dir, 'covers', idOf(png) + '.png'))
  assert.ok(smallCover.includes("scale=w='min(160,iw)':h='min(160,ih)':force_original_aspect_ratio=decrease"))
  assert.ok(calls[1].args.includes("scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease"))

  for (const level of ['low', 'normal', 'high']) assert.ok(fs.existsSync(transcodeFile(dir, wav.id, level)), 'wav ' + level)
  assert.ok(!fs.existsSync(transcodeFile(dir, mp3.id, 'high')), 'mp3 high never made')
  assert.ok(fs.existsSync(path.join(dir, 'covers', idOf(png) + '.small.jpg')))
  assert.ok(fs.existsSync(path.join(dir, 'covers', idOf(png) + '.large.jpg')))
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'no temporary file left')

  const lib = json(await request(port, 'GET', '/api/library'))
  assert.ok(lib.version > versionBefore, 'new transcodes give a new library version')
  const byId = Object.fromEntries(lib.tracks.map((x) => [x.id, x]))
  assert.deepEqual(byId[mp3.id].qualities, { low: true, normal: true, high: false })
  assert.deepEqual(byId[wav.id].qualities, { low: true, normal: true, high: true })
  assert.equal(byId[mp3.id].lossless, false)
  assert.equal(byId[wav.id].lossless, true)
})

test('stream ?q=: the level asked, else the next lower, else the next higher, else the original; X-MPfy-Quality; Range and HEAD on transcodes', async (t) => {
  const { app, dir, port, fake, upload } = await start(t)
  const wav = await upload('w.wav', hiWav(440))
  const mp3 = await upload('m.mp3', makeMp3({ frames: 60 }))
  await app.jobs.idle()
  const url = (track, q) => '/api/stream/' + track.id + (q ? '?q=' + q : '')

  const normal = fs.readFileSync(transcodeFile(dir, wav.id, 'normal'))
  let r = await request(port, 'GET', url(wav, 'normal'))
  assert.equal(r.status, 200)
  assert.equal(r.headers['x-mpfy-quality'], 'normal')
  assert.equal(r.headers['content-type'], 'audio/ogg')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  // A transcode made again (evicted, or by another ffmpeg) is other bytes under the
  // same URL: never cached for good, revalidated with its ETag.
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.ok(r.body.equals(normal))
  const tag = r.headers.etag
  assert.equal((await request(port, 'GET', url(wav, 'normal'), { headers: { 'if-none-match': tag } })).status, 304)

  // Range on a transcode.
  const low = fs.readFileSync(transcodeFile(dir, wav.id, 'low'))
  r = await request(port, 'GET', url(wav, 'low'), { headers: { range: 'bytes=100-1999' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], 'bytes 100-1999/' + low.length)
  assert.equal(r.headers['x-mpfy-quality'], 'low')
  assert.ok(r.body.equals(low.subarray(100, 2000)))
  r = await request(port, 'GET', url(wav, 'low'), { headers: { range: 'bytes=-50' } })
  assert.ok(r.body.equals(low.subarray(low.length - 50)))
  r = await request(port, 'GET', url(wav, 'low'), { headers: { range: 'bytes=' + low.length + '-' } })
  assert.equal(r.status, 416)
  r = await request(port, 'HEAD', url(wav, 'high'))
  assert.equal(r.status, 200)
  assert.equal(r.headers['x-mpfy-quality'], 'high')
  assert.equal(Number(r.headers['content-length']), fs.statSync(transcodeFile(dir, wav.id, 'high')).size)
  assert.equal(r.body.length, 0)

  // max, or no q at all: the original untouched, its ETag its file hash; for
  // good only when the request names that file (?f=).
  for (const q of ['max', null]) {
    r = await request(port, 'GET', url(wav, q))
    assert.equal(r.headers['x-mpfy-quality'], 'max')
    assert.equal(r.headers['content-type'], 'audio/wav')
    assert.equal(r.headers.etag, '"' + wav.fileHash + '"')
    assert.equal(r.headers['cache-control'], 'no-cache')
    assert.equal(r.body.length, wav.size)
  }
  r = await request(port, 'GET', url(wav, 'max') + '&f=' + wav.fileHash)
  assert.match(r.headers['cache-control'], /immutable/)

  // high is never made for a 128 kbps MP3: the next lower ready level, not cached for good.
  r = await request(port, 'GET', url(mp3, 'high'))
  assert.equal(r.headers['x-mpfy-quality'], 'normal')
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.equal((await request(port, 'GET', url(wav, 'loud'))).status, 400)

  // low failed for this track: the next HIGHER ready level.
  fake.control({ fail: '48k' })
  const wav2 = await upload('w2.wav', hiWav(550))
  await app.jobs.idle()
  assert.deepEqual(app.library.publicTrack(app.library.getTrack(wav2.id)).qualities, { low: false, normal: true, high: true })
  r = await request(port, 'GET', url(wav2, 'low'))
  assert.equal(r.headers['x-mpfy-quality'], 'normal')
  // normal failed, low and high ready: the next LOWER one first.
  fake.control({ fail: '96k' })
  const wav4 = await upload('w4.wav', hiWav(770))
  await app.jobs.idle()
  assert.deepEqual(app.library.publicTrack(app.library.getTrack(wav4.id)).qualities, { low: true, normal: false, high: true })
  r = await request(port, 'GET', url(wav4, 'normal'))
  assert.equal(r.headers['x-mpfy-quality'], 'low')
  // Nothing ready for a track whose every job fails: the original.
  fake.control({ fail: 'libopus' })
  const wav3 = await upload('w3.wav', hiWav(660))
  await app.jobs.idle()
  r = await request(port, 'GET', url(wav3, 'normal'))
  assert.equal(r.headers['x-mpfy-quality'], 'max')
  assert.equal(r.headers['content-type'], 'audio/wav')
})

// Run `fn` with the clock (Date only, no timers) moved `minutes` ahead of `from`.
async function atMinutes (t, from, minutes, fn) {
  t.mock.timers.enable({ apis: ['Date'], now: from + minutes * 60 * 1000 })
  try {
    return await fn()
  } finally {
    t.mock.timers.reset()
  }
}

test('not ready yet: the original now, the level made on demand first; a playback keeps its representation, HEAD and re-reads from 0 included', async (t) => {
  const { app, port, fake, upload } = await start(t, { control: { delayMs: 400 } })
  const wav = await upload('lento.wav', hiWav(250))
  const url = '/api/stream/' + wav.id + '?q=low'
  const level = async (method, headers = {}) => (await request(port, method, url, { headers })).headers['x-mpfy-quality']
  // A job is running now (the quality analysis); low is asked for: original now, low jumps the queue.
  const first = await request(port, 'GET', url, { headers: { range: 'bytes=0-' } })
  assert.equal(first.headers['x-mpfy-quality'], 'max')
  assert.equal(first.headers['cache-control'], 'no-cache')
  await waitFor(() => app.jobs.qualities(app.library.getTrack(wav.id)).low, { what: 'low ready' })
  // low is ready now. The web UI reads the level with a HEAD on the same URL: it
  // names what this playback gets, and changes nothing...
  assert.equal(await level('HEAD'), 'max')
  // ...so the player's next seek still gets the original's bytes.
  const seek = await request(port, 'GET', url, { headers: { range: 'bytes=1000-' } })
  assert.equal(seek.status, 206)
  assert.equal(seek.headers['x-mpfy-quality'], 'max')
  assert.equal(seek.headers['content-range'], 'bytes 1000-' + (wav.size - 1) + '/' + wav.size)
  // A re-read from 0 inside the playback (Chrome probing, a seek back to the
  // start), with bytes=0- or with no Range at all, is the same file too.
  assert.equal(await level('GET', { range: 'bytes=0-' }), 'max')
  assert.equal(await level('GET'), 'max')
  // Minutes later a request from 0 is a new playback: it gets the transcode, and
  // a HEAD says so first (what a new playback would get).
  const now = Date.now()
  await atMinutes(t, now, 6, async () => {
    assert.equal(await level('HEAD'), 'low')
    assert.equal(await level('GET', { range: 'bytes=0-' }), 'low')
  })
  await app.jobs.idle()
  assert.deepEqual(jobCalls(fake).map(rateOf), ['quality', '48k', '160k', '96k'], 'the demanded level ran right after the job already running')
})

test('a playback keeps its representation while a response of it is open, however long; then for a while after it', async (t) => {
  const { app, upload } = await start(t, { control: { delayMs: 200 } })
  const wav = await upload('lungo.wav', hiWav(260))
  const track = app.library.getTrack(wav.id)
  const pick = (opts) => app.jobs.pick(track, 'low', { who: 'telefono', ...opts }).level
  const first = app.jobs.pick(track, 'low', { who: 'telefono' })
  assert.equal(first.level, 'max', 'nothing ready yet: the original')
  const release = app.jobs.hold(first) // its response is being sent
  await waitFor(() => app.jobs.qualities(track).low, { what: 'low ready' })
  const now = Date.now()
  // 45 minutes into a long playback (a paused player keeps its response open).
  await atMinutes(t, now, 45, () => {
    assert.equal(pick({ continuation: true }), 'max')
    assert.equal(pick({}), 'max', 'from 0, while the response is open')
    assert.equal(pick({ peek: true }), 'max')
    assert.equal(app.jobs.pick(track, 'low', { who: 'pc' }).level, 'low', 'another requester chooses for itself')
    release()
    release() // twice is harmless
  })
  // After the response ended: from 0 within RESTART_STICKY_MS, a seek within STICKY_MS.
  await atMinutes(t, now, 49, () => assert.equal(pick({}), 'max'))
  await atMinutes(t, now, 49 + 29, () => assert.equal(pick({ continuation: true }), 'max'))
  await atMinutes(t, now, 49 + 29 + 6, () => assert.equal(pick({ peek: true }), 'low', 'a HEAD from 0: a new playback would get low'))
  await atMinutes(t, now, 49 + 29 + 6, () => assert.equal(pick({ continuation: true }), 'max', 'the HEAD recorded nothing'))
  await atMinutes(t, now, 49 + 29 + 6 + 31, () => assert.equal(pick({ continuation: true }), 'low', 'paused over STICKY_MS: chosen afresh'))
})

test('LRU cap: least recently streamed go first, re-made on demand; the start-up fill only uses free room', async (t) => {
  // Fake sizes: high 16000, normal 9600, low 4800 bytes; 30400 per track.
  const dir = cleanup(t).dir(tmpDir())
  const CAP = 70000
  let { app, port, upload, fake } = await start(t, { cap: CAP, dir })
  const a = await upload('a.wav', hiWav(100))
  await app.jobs.idle()
  const b = await upload('b.wav', hiWav(200))
  await app.jobs.idle()
  // A's normal is streamed: it becomes the most recently used of A's and B's.
  assert.equal((await request(port, 'GET', '/api/stream/' + a.id + '?q=normal')).headers['x-mpfy-quality'], 'normal')
  const c = await upload('c.wav', hiWav(300))
  await app.jobs.idle()
  const exists = (track, level) => fs.existsSync(transcodeFile(dir, track.id, level))
  assert.ok(exists(a, 'normal'), 'the streamed transcode survived')
  assert.ok(!exists(a, 'high') && !exists(a, 'low'), "A's never streamed ones were the oldest")
  assert.ok(!exists(b, 'high'), "then B's oldest")
  assert.ok(exists(c, 'high') && exists(c, 'normal') && exists(c, 'low'), 'the new ones are kept')
  const total = treeFiles(dir, 'transcodes').reduce((n, f) => n + fs.statSync(shardPath(dir, 'transcodes', f)).size, 0)
  assert.ok(total <= CAP, 'transcodes/ within the cap: ' + total)
  assert.equal(app.jobs.totalBytes, total)
  assert.equal(app.jobs.stats.evicted, 3)
  assert.deepEqual(app.jobs.qualities(app.library.getTrack(a.id)), { low: false, normal: true, high: false })
  for (const x of [a, b, c]) assert.ok(fs.existsSync(shardPath(dir, 'library', x.id + '.wav')), 'originals are never evicted')

  // Asked again: served from what is there, and made again on demand.
  const r = await request(port, 'GET', '/api/stream/' + a.id + '?q=high')
  assert.equal(r.headers['x-mpfy-quality'], 'normal')
  await app.jobs.idle()
  assert.ok(exists(a, 'high'), 're-made on demand')
  const callsBefore = jobCalls(fake).length

  // Restart with the room taken: the start-up fill evicts nothing.
  await app.close()
  ;({ app, port, upload, fake } = await start(t, { cap: app.jobs.totalBytes, dir }))
  await app.jobs.idle()
  assert.ok(app.jobs.stats.skippedForCap >= 1, 'missing levels skipped for lack of room')
  assert.equal(app.jobs.stats.evicted, 0)
  assert.equal(jobCalls(fake).length, 0, 'no transcode at all')
  assert.ok(callsBefore > 0)
  await app.close()
  // With room again the missing levels are made at start.
  ;({ app } = await start(t, { cap: 10 * 1024 * 1024, dir }))
  await app.jobs.idle()
  for (const x of [a, b, c]) assert.deepEqual(app.jobs.qualities(app.library.getTrack(x.id)), { low: true, normal: true, high: true })
})

test('failures: logged with the command, not retried at once; garbage output refused', async (t) => {
  const { app, dir, port, fake, upload } = await start(t, { control: { fail: '96k' } })
  const logged = []
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')) })
  const wav = await upload('x.wav', hiWav(700))
  await app.jobs.idle()
  const line = logged.find((l) => l.includes('ffmpeg failed'))
  assert.ok(line, 'the failure is logged: ' + logged.join(' | '))
  assert.match(line, /command: .*fake-ffmpeg\.mjs'? -nostdin -v error -i .* -c:a libopus -b:a 96k -vbr on -compression_level 5 -f ogg /)
  assert.match(line, /failing on purpose/, 'with ffmpeg stderr')
  assert.equal(app.jobs.stats.failed, 1)
  const n = jobCalls(fake).length
  await request(port, 'GET', '/api/stream/' + wav.id + '?q=normal')
  await app.jobs.idle()
  assert.equal(jobCalls(fake).length, n, 'a failed level is not asked of ffmpeg again right away')

  fake.control({ garbage: true })
  const other = await upload('y.wav', hiWav(800))
  await app.jobs.idle()
  assert.ok(logged.some((l) => /output is not an Ogg file: .*-b:a 160k/.test(l)), 'invalid output logged with the command')
  assert.deepEqual(app.jobs.qualities(app.library.getTrack(other.id)), { low: false, normal: false, high: false })
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'failed outputs removed')
})

test('covers ?size=: the original until the JPEG versions exist, then them; a deleted track takes its covers, transcodes and queued jobs', async (t) => {
  const { app, dir, port, fake, upload } = await start(t, { control: { delayMs: 300 } })
  const png = fakePng(5)
  const coverId = idOf(png)
  const track = await upload('cop.mp3', makeMp3({ cover: png, frames: 60 }))
  let r = await request(port, 'GET', '/api/cover/' + coverId + '?size=small')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'image/png', 'not made yet: the original')
  assert.equal(r.headers['cache-control'], 'private, max-age=600')
  assert.ok(r.body.equals(png))
  await app.jobs.idle()
  for (const size of ['small', 'large']) {
    r = await request(port, 'GET', '/api/cover/' + coverId + '?size=' + size)
    assert.equal(r.headers['content-type'], 'image/jpeg')
    assert.match(r.headers['cache-control'], /immutable/)
    assert.equal(r.headers.etag, '"' + coverId + '.' + size + '"')
    assert.ok(r.body.equals(fs.readFileSync(path.join(dir, 'covers', coverId + '.' + size + '.jpg'))))
    assert.match(r.body.toString('latin1'), new RegExp('min\\(' + (size === 'small' ? 160 : 640) + ','))
  }
  r = await request(port, 'GET', '/api/cover/' + coverId)
  assert.equal(r.headers['content-type'], 'image/png')
  assert.equal((await request(port, 'GET', '/api/cover/' + coverId + '?size=huge')).status, 400)

  // Delete a track while its jobs are queued: the running one finishes, the rest never run.
  const wav = await upload('via.wav', hiWav(900))
  await waitFor(() => app.jobs.busy && jobCalls(fake).length >= 0, { what: 'busy' })
  assert.equal((await request(port, 'DELETE', '/api/tracks/' + wav.id)).status, 200)
  assert.equal((await request(port, 'DELETE', '/api/tracks/' + track.id)).status, 200)
  await app.jobs.idle()
  assert.deepEqual(treeFiles(dir, 'transcodes'), [], 'no transcode left behind')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'covers')), [], 'cover and its versions gone')
  const wavCalls = jobCalls(fake).filter((c) => c.args.some((a) => a.includes(wav.id)))
  assert.ok(wavCalls.length <= 1, 'at most the job already running: ' + wavCalls.length)
})

test('without ffmpeg (or without libopus): health says so, originals for every level, nothing queued', async (t) => {
  const { app, port, upload } = await start(t, { ffmpeg: 'mpfy-no-such-ffmpeg-' + process.pid })
  assert.equal(json(await request(port, 'GET', '/api/health')).ffmpeg, false)
  const png = fakePng(8)
  const mp3 = await upload('n.mp3', makeMp3({ cover: png, frames: 60 }))
  assert.equal(app.jobs.busy, false)
  const r = await request(port, 'GET', '/api/stream/' + mp3.id + '?q=low')
  assert.equal(r.headers['x-mpfy-quality'], 'max')
  assert.equal((await request(port, 'GET', '/api/cover/' + idOf(png) + '?size=small')).headers['content-type'], 'image/png')

  const noOpus = await start(t, { control: { noOpus: true } })
  assert.equal(json(await request(noOpus.port, 'GET', '/api/health')).ffmpeg, true, 'ffmpeg runs')
  assert.equal(noOpus.app.jobs.opusAvailable, false)
  await noOpus.upload('o.mp3', makeMp3({ cover: fakePng(9), frames: 60 }))
  await noOpus.app.jobs.idle()
  assert.deepEqual(jobCalls(noOpus.fake).map(rateOf), ['cover', 'cover', 'quality'], 'covers still resized, quality analysed, no transcode tried')
})

// A small JPEG made of real segments: SOI, APP0, an optional APP1 (EXIF), the
// given extra segments, DQT, SOS with some scan bytes, EOI.
function jpeg ({ exif = null, extra = [], scan = 'scan-data-1' } = {}) {
  const seg = (marker, body) => {
    const b = Buffer.from(body)
    const h = Buffer.from([0xff, marker, 0, 0])
    h.writeUInt16BE(b.length + 2, 2)
    return Buffer.concat([h, b])
  }
  const parts = [Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0\x01\x01')]
  if (exif !== null) parts.push(seg(0xe1, 'Exif\0\0' + exif))
  for (const [m, body] of extra) parts.push(seg(m, body))
  parts.push(seg(0xdb, Buffer.alloc(65, 7)), seg(0xda, Buffer.alloc(10, 1)), Buffer.from(scan), Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

function png (chunks) {
  const out = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  for (const [type, body] of chunks) {
    const b = Buffer.from(body)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    out.push(len, Buffer.from(type, 'latin1'), b, Buffer.alloc(4))
  }
  return Buffer.concat(out)
}

test('cover id: the same picture with other metadata is one cover, another picture is not', (t) => {
  const dir = tmpDir('mpfy-cover-id-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = saveCoverBytes(jpeg({ exif: 'DateTime 2025:01:01' }), dir)
  const b = saveCoverBytes(jpeg({ exif: 'DateTime 2026:03:09' }), dir)
  const c = saveCoverBytes(jpeg(), dir)
  const d = saveCoverBytes(jpeg({ exif: 'x', extra: [[0xfe, 'a comment'], [0xed, 'IPTC']] }), dir)
  assert.match(a, /^[0-9a-f]{24}$/)
  assert.equal(b, a, 'another EXIF date')
  assert.equal(c, a, 'no EXIF at all')
  assert.equal(d, a, 'comments and IPTC')
  assert.equal(fs.readdirSync(dir).length, 1, 'stored once')
  assert.notEqual(saveCoverBytes(jpeg({ scan: 'scan-data-2' }), dir), a, 'other pixels')
  assert.notEqual(saveCoverBytes(jpeg({ extra: [[0xee, 'Adobe\0\x64\0\0\0\0\x01']] }), dir), a, 'Adobe changes the colours: kept')
  assert.notEqual(saveCoverBytes(jpeg({ extra: [[0xe2, 'ICC_PROFILE\0\x01\x01profile']] }), dir), a, 'ICC profile: kept')
  // The stored file is the bytes first seen, untouched.
  assert.deepEqual(fs.readFileSync(path.join(dir, a + '.jpg')), jpeg({ exif: 'DateTime 2025:01:01' }))

  const p1 = saveCoverBytes(png([['IHDR', 'header'], ['tEXt', 'Comment\0one'], ['IDAT', 'pixels'], ['IEND', '']]), dir)
  const p2 = saveCoverBytes(png([['IHDR', 'header'], ['tIME', '1234567'], ['IDAT', 'pixels'], ['IEND', '']]), dir)
  assert.equal(p2, p1, 'PNG text and time chunks')
  assert.notEqual(saveCoverBytes(png([['IHDR', 'header'], ['IDAT', 'pixelz'], ['IEND', '']]), dir), p1)

  // A JPEG that does not walk is hashed whole, never refused.
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from('short')])
  assert.deepEqual(coverHashParts(broken, 'jpg'), [broken])
  assert.match(saveCoverBytes(broken, dir), /^[0-9a-f]{24}$/)
})
