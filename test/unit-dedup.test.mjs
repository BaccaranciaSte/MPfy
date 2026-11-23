// Duplicates: the bit error rate of two fingerprints at the best offset, the
// thresholds, the quality score and "better", fpcalc's JSON; and the upload
// pipeline with a fake fpcalc and a fake ffmpeg: byte identical, the same
// recording better (replaced) or worse (a claim), the tail check before
// replacing someone else's original, "maybe" parked and answered or expired,
// and callers that cannot be asked. The real quality (the spectrum, the null
// test) is in unit-quality.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { versionWords, differentVersions } from '../server/versions.mjs'
import { berAt, bestOffset, minPairsOf, classify, parseFpcalc, popcount32, signatureOf } from '../server/fingerprint.mjs'
import { scoreOf, isBetter, codecOf } from '../server/quality.mjs'
import {
  tmpDir, cleanup, request, json, makeWav, makeMp3, makeAdts, makeProfile, device, testWhoIs, fakeTool, fakeFfmpeg, hash24, fingerprintOf, makeZip, waitFor,
  shardPath, treeFiles
} from './helpers.mjs'
import { tailArgs } from '../server/ffmpeg.mjs'
import { HttpError } from '../server/errors.mjs'

const body = (r) => json(r)

test('BER: pairs at an offset, the best offset with enough pairs, the thresholds', () => {
  assert.equal(popcount32(0xffffffff), 32)
  assert.equal(popcount32(0x80000001), 2)
  const a = fingerprintOf('a', { n: 100 })
  assert.deepEqual(berAt(a, a, 0), { ber: 0, n: 100 })
  const shifted = fingerprintOf('a', { n: 100, shift: 3 }) // a without its first 3 items
  assert.deepEqual(bestOffset(a, shifted, 10), { ber: 0, k: -3, n: 97 }, 'A[i] pairs with B[i + k]')
  assert.equal(minPairsOf(a, a), 80)
  assert.equal(minPairsOf(a.slice(0, 50), a), 40, '0.8 x the shorter')
  // The true alignment (k = 10) leaves 20 pairs, fewer than 0.8 x 30: it does not count.
  const late = [...fingerprintOf('rumore', { n: 10 }), ...a.slice(0, 20)]
  const best = bestOffset(a.slice(0, 30), late, 10)
  assert.notEqual(best.k, 10)
  assert.ok(best.ber > 0.3, 'only unrelated offsets are left: ' + best.ber)
  assert.equal(berAt(a.slice(0, 30), late, 10).ber, 0)
  const near = fingerprintOf('a', { n: 100, flip: 3 })
  assert.equal(bestOffset(a, near, 10).ber, 3 / 32)
  assert.equal(classify(0.10, 1.5), 'same')
  assert.equal(classify(0.10, 1.6), 'maybe', 'too far apart in length to be the same')
  assert.equal(classify(0.11, 0), 'maybe')
  assert.equal(classify(0.18, 3), 'maybe')
  assert.equal(classify(0.18, 3.1), null)
  assert.equal(classify(0.181, 0), null)
})

test('score and "better"; codecs', () => {
  assert.equal(scoreOf({ lossless: true, bitDepth: 16, sampleRate: 44100 }), 1016441)
  assert.equal(scoreOf({ lossless: true, bitDepth: 24, sampleRate: 96000 }), 1024960)
  assert.equal(scoreOf({ lossless: true }), 1016441, 'unknown depth and rate: 16 and 44.1')
  assert.equal(scoreOf({ lossless: true, fakeLossless: true, equivKbps: 192 }), 192)
  assert.equal(scoreOf({ codec: 'mp3', bitrate: 320000 }), 320)
  assert.equal(scoreOf({ codec: 'aac', bitrate: 256000 }), 332.8)
  assert.equal(scoreOf({ codec: 'opus', bitrate: 160000 }), 256)
  assert.equal(scoreOf({ codec: 'vorbis', bitrate: null, size: 1500000, duration: 100 }), 156, 'from size and duration')
  assert.equal(scoreOf({ codec: 'mp3', bitrate: null, size: 0, duration: null }), 0)
  assert.equal(isBetter(336, 320), false, 'within 5% of a lossy file is not better')
  assert.equal(isBetter(337, 320), true)
  assert.equal(isBetter(1016441, 1016441), false)
  assert.equal(isBetter(1016442, 1016441), true)
  assert.equal(isBetter(1016441, 320), true)
  assert.equal(codecOf('m4a', true), 'alac')
  assert.equal(codecOf('m4a', false, 'MPEG-4/AAC'), 'aac')
  assert.equal(codecOf('ogg', false, 'Vorbis I'), 'vorbis')
})

test('fpcalc JSON: two decimals, signed items taken as u32, unusable output fails; the signature', () => {
  const fp = parseFpcalc(JSON.stringify({ duration: 245.318, fingerprint: [-1, 5, -2147483648, ...Array(13).fill(7)] }))
  assert.equal(fp.duration, 245.32)
  assert.deepEqual([...fp.items.slice(0, 3)], [4294967295, 5, 2147483648])
  assert.equal(parseFpcalc('DURATION=245\nFINGERPRINT=1,2,3'), null, 'not JSON')
  assert.equal(parseFpcalc('{"duration": 10}'), null, 'no fingerprint')
  assert.equal(parseFpcalc(JSON.stringify({ duration: 10, fingerprint: Array(15).fill(1) })), null, 'fewer than 16 items')
  assert.equal(parseFpcalc(JSON.stringify({ duration: 10, fingerprint: [...Array(15).fill(1), 1.5] })), null)
  const items = Array.from({ length: 70 }, (_, i) => i)
  const sig = signatureOf(items, 245.36)
  assert.deepEqual([sig.d, sig.b], [245.4, 6], 'b = min(32, len - 64)')
  assert.equal(Buffer.from(sig.s, 'base64').readUInt32LE(0), 6)
  assert.equal(signatureOf(items.slice(0, 40), 9).b, 0)
  assert.equal(Buffer.from(signatureOf(items.slice(0, 40), 9).s, 'base64').length, 160)
})

// A source with a fake fpcalc and a fake ffmpeg, an owner and a member. Every
// file decodes to the same samples (one version of one song) unless told.
const ONE_VERSION = { seed: 'one version' }
async function start (t, { fp = {}, pcm = ONE_VERSION, pcmFor = {}, opts = {} } = {}) {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-tools-'))
  const fpcalc = fakeTool(work, 'fpcalc', fp)
  const ff = fakeFfmpeg(work, { pcm, pcmFor })
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: ff.command, fpcalc: fpcalc.command, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  await app.jobsStarted
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  return { app, dir, owner, sara, fpcalc, ff }
}

// Two files of one "recording": a 128 kbps mp3 (worse) and a WAV (better). They
// decode alike up to the mp3's cut at 16 kHz (`pcm`, for the fake ffmpeg).
function pair (seed, { flip = 2, tailFlip = 2, tags = {} } = {}) {
  const mp3 = makeMp3({ frames: 120, title: tags.title || seed, artist: tags.artist })
  const wav = makeWav({ seconds: 3, sampleRate: 8000, freq: 200 + (parseInt(hash24(Buffer.from(seed)).slice(0, 4), 16) % 900), tags: tags.wavTags || null })
  const prints = {
    [hash24(mp3)]: { duration: 3.13, fingerprint: fingerprintOf(seed) },
    [hash24(wav)]: { duration: 3.0, fingerprint: fingerprintOf(seed, { flip }) },
    ['tail:' + hash24(mp3)]: { duration: 3.13, fingerprint: fingerprintOf(seed + '-coda') },
    ['tail:' + hash24(wav)]: { duration: 3.0, fingerprint: fingerprintOf(seed + '-coda', { flip: tailFlip }) }
  }
  const pcm = { [hash24(mp3)]: { seed, cutoffHz: 16000 }, [hash24(wav)]: { seed } }
  return { mp3, wav, prints, pcm }
}

test('dedup: byte identical adds the claim; the same recording better replaces (id kept, file, fingerprint and transcodes new, edits kept, empty tags filled); worse is a claim', async (t) => {
  const p = pair('canzone', { tags: { title: 'Canzone', wavTags: { title: 'Titolo del wav', artist: 'Artista', album: 'Album del wav' } } })
  const { app, dir, owner, sara, fpcalc } = await start(t, { fp: { prints: p.prints }, pcmFor: p.pcm })
  const first = body(await owner.call('PUT', '/api/upload/c.mp3', { body: p.mp3 }))
  assert.equal(first.outcome, 'added')
  const id = first.track.id
  await app.jobs.idle()
  const oldTranscodes = treeFiles(dir, 'transcodes').sort()
  assert.ok(oldTranscodes.length > 0)
  assert.ok(fs.existsSync(path.join(dir, 'fingerprints', id + '.fp')))
  // Byte identical, from Sara: her claim, nothing stored.
  let r = body(await sara.call('PUT', '/api/upload/copia.mp3', { body: p.mp3 }))
  assert.deepEqual([r.outcome, r.duplicate, r.track.id, r.track.mine], ['duplicate', true, id, true])
  assert.deepEqual(app.library.getTrack(id).uploaders, [owner.profile.id, sara.profile.id])
  await owner.call('PATCH', '/api/tracks/' + id, { body: { title: 'Titolo mio' } })

  // The WAV is better: it replaces the file under the same id (the original is the owner's
  // too: the tails are checked, and they match).
  r = body(await sara.call('PUT', '/api/upload/c.wav', { body: p.wav }))
  assert.equal(r.outcome, 'replaced')
  assert.equal(r.duplicate, true)
  const t2 = r.track
  assert.equal(t2.id, id, 'the id never changes')
  assert.equal(t2.fileHash, hash24(p.wav))
  assert.deepEqual([t2.format, t2.codec, t2.lossless], ['wav', 'wav', true])
  assert.equal(t2.title, 'Titolo mio', 'the edit stays')
  assert.equal(t2.artist, 'Artista', 'an empty tag is filled from the better file')
  assert.equal(t2.album, 'Album del wav')
  assert.deepEqual(treeFiles(dir, 'library'), [id + '.wav'], 'the old file is gone')
  assert.ok(!fs.existsSync(path.join(dir, 'fingerprints', id + '.fp')), 'its fingerprint too')
  assert.ok(fs.existsSync(path.join(dir, 'fingerprints', hash24(p.wav) + '.fp')))
  await app.jobs.idle()
  const made = treeFiles(dir, 'transcodes').sort()
  assert.ok(made.length > 0)
  for (const name of made) assert.match(fs.readFileSync(shardPath(dir, 'transcodes', name), 'latin1'), new RegExp(id + '\\.wav'), 'made again from the new file')
  assert.equal(fpcalc.calls().filter((c) => c.key && c.key.startsWith('tail:')).length, 2, 'tails checked: the track is not hers alone')

  // The mp3 again (worse now), from a third person: a claim, the file discarded.
  const marco = device(app, { profile: makeProfile(), name: 'Marco' })
  r = body(await marco.call('PUT', '/api/upload/vecchio.mp3', { body: p.mp3 }))
  assert.deepEqual([r.outcome, r.track.id], ['duplicate', id], 'the mp3 is the old file of that track: byte identical? no, its id: the same recording, worse')
  assert.ok(app.library.getTrack(id).uploaders.includes(marco.profile.id))
  assert.deepEqual(treeFiles(dir, 'library'), [id + '.wav'])
})

test('dedup: two lossy files of one recording: within 5% the kept one stays (a claim), clearly better replaces', async (t) => {
  const mp3 = makeMp3({ frames: 200, title: 'Lossy' })
  const close = makeAdts({ frames: 200, frameLength: 290 }) // aac 100 kbps: 130 against 128
  const better = makeAdts({ frames: 200, frameLength: 400 }) // aac 138 kbps: 179
  const prints = {}
  for (const [buf, flip] of [[mp3, 0], [close, 2], [better, 3]]) prints[hash24(buf)] = { duration: 5.0, fingerprint: fingerprintOf('lossy', { flip }) }
  const { owner } = await start(t, { fp: { prints } })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: mp3 })).track
  assert.equal(kept.score, 128)
  let r = body(await owner.call('PUT', '/api/upload/a.aac', { body: close }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['duplicate', kept.id, 'mp3'], '130 is not 5% over 128')
  r = body(await owner.call('PUT', '/api/upload/b.aac', { body: better }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['replaced', kept.id, 'aac'])
})

test('dedup: someone who is neither the owner nor an uploader replaces an original only when the last 120 s match too', async (t) => {
  const bad = pair('altra', { tailFlip: 16 })
  const good = pair('buona', { tailFlip: 1 })
  const sly = pair('furba', { tailFlip: 16 })
  const hers = pair('sua', { tailFlip: 16 })
  const { app, owner, sara, fpcalc, ff } = await start(t, { fp: { prints: { ...bad.prints, ...good.prints, ...sly.prints, ...hers.prints } }, pcmFor: { ...bad.pcm, ...good.pcm, ...sly.pcm, ...hers.pcm } })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: bad.mp3 })).track
  let r = body(await sara.call('PUT', '/api/upload/a.wav', { body: bad.wav }))
  assert.equal(r.outcome, 'added', 'the tail differs: decided "both", the original stays')
  assert.notEqual(r.track.id, kept.id)
  assert.deepEqual(app.library.getTrack(kept.id).notSame, [r.track.id])
  assert.deepEqual(app.library.getTrack(r.track.id).notSame, [kept.id])
  assert.equal(app.library.getTrack(kept.id).fileHash, kept.id, 'the original untouched')
  assert.equal(fpcalc.calls().filter((c) => c.key && c.key.startsWith('tail:')).length, 2, 'both tails fingerprinted')
  assert.deepEqual(fs.readdirSync(path.join(app.library.tmpDir)), [], 'tail files removed')

  const kept2 = body(await owner.call('PUT', '/api/upload/b.mp3', { body: good.mp3 })).track
  r = body(await sara.call('PUT', '/api/upload/b.wav', { body: good.wav }))
  assert.equal(r.outcome, 'replaced', 'the tail matches as well')
  assert.equal(r.track.id, kept2.id)
  for (const call of ff.calls().filter((c) => c.args.includes('-sseof'))) {
    assert.deepEqual(call.args.slice(-5), ['-t', '120', '-f', 'wav', call.args[call.args.length - 1]], 'two minutes at most, whatever the header says')
  }
  assert.deepEqual(tailArgs('/a.mp3', '/t.wav'), ['-nostdin', '-v', 'error', '-sseof', '-120', '-i', '/a.mp3', '-map', '0:a:0', '-vn', '-ac', '1', '-t', '120', '-f', 'wav', '/t.wav'])

  // Uploading the original's own bytes first makes Sara one of its uploaders, but it
  // stays the owner's too: her better file still needs the tail.
  const kept3 = body(await owner.call('PUT', '/api/upload/c.mp3', { body: sly.mp3 })).track
  r = body(await sara.call('PUT', '/api/upload/c-copia.mp3', { body: sly.mp3 }))
  assert.deepEqual([r.outcome, r.track.id], ['duplicate', kept3.id])
  r = body(await sara.call('PUT', '/api/upload/c.wav', { body: sly.wav }))
  assert.equal(r.outcome, 'added', 'not replaced: the tail differs')
  assert.equal(app.library.getTrack(kept3.id).fileHash, kept3.id, 'the original untouched')

  // A track that is hers alone: her better file replaces it, no tail asked.
  const kept4 = body(await sara.call('PUT', '/api/upload/d.mp3', { body: hers.mp3 })).track
  const tails = fpcalc.calls().filter((c) => c.key && c.key.startsWith('tail:')).length
  r = body(await sara.call('PUT', '/api/upload/d.wav', { body: hers.wav }))
  assert.deepEqual([r.outcome, r.track.id], ['replaced', kept4.id])
  assert.equal(fpcalc.calls().filter((c) => c.key && c.key.startsWith('tail:')).length, tails)
})

test('dedup: the tail check needs room for its two WAVs above the disk floor; without it, both are kept', async (t) => {
  const GB = 1024 ** 3
  let free = GB + 64 * 1024 * 1024
  const statfs = async () => ({ bavail: free, bsize: 1, blocks: 100 * GB })
  const p = pair('stretta', { tailFlip: 1 })
  const q = pair('larga', { tailFlip: 1 })
  const { app, owner, sara, fpcalc } = await start(t, { fp: { prints: { ...p.prints, ...q.prints } }, pcmFor: { ...p.pcm, ...q.pcm }, opts: { statfs, minFreeBytes: GB } })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  free = GB + 10 * 1024 * 1024 // the upload fits, two minutes of WAV twice do not
  let r = body(await sara.call('PUT', '/api/upload/a.wav', { body: p.wav }))
  assert.equal(r.outcome, 'added', 'no room for the tail check: decided both')
  assert.equal(app.library.getTrack(kept.id).fileHash, kept.id)
  assert.equal(fpcalc.calls().filter((c) => c.key && c.key.startsWith('tail:')).length, 0)
  free = GB + 64 * 1024 * 1024
  const kept2 = body(await owner.call('PUT', '/api/upload/b.mp3', { body: q.mp3 })).track
  r = body(await sara.call('PUT', '/api/upload/b.wav', { body: q.wav }))
  assert.deepEqual([r.outcome, r.track.id], ['replaced', kept2.id], 'with room it runs and matches')
})

test('dedup: the kept track edited or deleted while its quality is checked: the edit stays, a deleted track never comes back', async (t) => {
  const wav = (freq) => makeWav({ seconds: 3, sampleRate: 44100, freq })
  const [a, b, c, d] = [wav(300), wav(301), wav(302), wav(303)]
  const prints = {
    [hash24(a)]: { duration: 3.0, fingerprint: fingerprintOf('x') },
    [hash24(b)]: { duration: 3.0, fingerprint: fingerprintOf('x', { flip: 1 }) },
    [hash24(c)]: { duration: 3.0, fingerprint: fingerprintOf('y') },
    [hash24(d)]: { duration: 3.0, fingerprint: fingerprintOf('y', { flip: 1 }) }
  }
  const { app, dir, owner, ff } = await start(t, { fp: { prints } })
  const decodes = () => ff.calls().filter((x) => x.args.includes('f32le')).length
  // A kept track whose own check has not run yet: the upload checks it, slowly.
  const keptUnchecked = async (bytes, name) => {
    const k = body(await owner.call('PUT', '/api/upload/' + name, { body: bytes })).track
    await app.jobs.idle()
    app.library.setTrack({ ...app.library.getTrack(k.id), qualityV: 0, fakeLossless: null, cutoffHz: null })
    return k
  }

  const kept = await keptUnchecked(a, 'a.wav')
  ff.control({ pcm: ONE_VERSION, delayMs: 250 })
  let n = decodes()
  let upload = owner.call('PUT', '/api/upload/b.wav', { body: b })
  await waitFor(() => decodes() >= n + 1, { what: 'the check of the kept track under way' })
  assert.equal((await owner.call('PATCH', '/api/tracks/' + kept.id, { body: { title: 'Titolo scritto ora' } })).status, 200)
  let r = body(await upload)
  assert.deepEqual([r.outcome, r.track.id], ['duplicate', kept.id])
  assert.equal(app.library.getTrack(kept.id).title, 'Titolo scritto ora', 'the edit made meanwhile stays')
  assert.equal(app.library.getTrack(kept.id).qualityV, 2, 'and the verdict is stored')

  ff.control({ pcm: ONE_VERSION })
  const kept2 = await keptUnchecked(c, 'c.wav')
  ff.control({ pcm: ONE_VERSION, delayMs: 250 })
  n = decodes()
  upload = owner.call('PUT', '/api/upload/d.wav', { body: d })
  await waitFor(() => decodes() >= n + 1, { what: 'the check of the kept track under way' })
  assert.equal(body(await owner.call('DELETE', '/api/tracks/' + kept2.id)).deleted, true)
  r = body(await upload)
  assert.equal(r.outcome, 'added', 'the kept track is gone: the upload is a track of its own')
  assert.equal(r.track.id, hash24(d))
  assert.equal(app.library.getTrack(kept2.id), null, 'never brought back')
  assert.ok(!treeFiles(dir, 'library').some((f) => f.startsWith(kept2.id)))
})

test('dedup: "maybe" parks the upload; "both" and "best" answers; expiry decides both; a caller without headers is never asked', async (t) => {
  const m1 = pair('forse', { flip: 5 })
  const m2 = pair('forse2', { flip: 5 })
  const m3 = pair('forse3', { flip: 5 })
  const m4 = pair('forse4', { flip: 5 })
  const prints = { ...m1.prints, ...m2.prints, ...m3.prints, ...m4.prints }
  const { app, owner, sara } = await start(t, { fp: { prints }, pcmFor: { ...m1.pcm, ...m2.pcm, ...m3.pcm, ...m4.pcm } })
  const k1 = body(await owner.call('PUT', '/api/upload/1.mp3', { body: m1.mp3 })).track
  let r = await sara.call('PUT', '/api/upload/1.wav', { body: m1.wav })
  const maybe = body(r)
  assert.equal(r.status, 200)
  assert.equal(maybe.outcome, 'maybe')
  assert.equal(maybe.track, undefined)
  assert.equal(maybe.pending.match.id, k1.id)
  assert.deepEqual(Object.keys(maybe.pending.candidate).sort(), ['album', 'artist', 'bitrate', 'codec', 'duration', 'format', 'lossless', 'score', 'title'])
  assert.ok(maybe.pending.expiresAt > Date.now() + 23 * 3600e3)
  assert.equal(app.library.tracks.size, 1, 'nothing added yet')
  assert.equal((await owner.call('POST', '/api/pending/' + maybe.pending.id, { body: { keep: 'both' } })).status, 404, 'only its uploader answers')
  r = await sara.call('POST', '/api/pending/' + maybe.pending.id, { body: { keep: 'both' } })
  assert.equal(body(r).outcome, 'added')
  assert.deepEqual(app.library.getTrack(k1.id).notSame, [body(r).track.id])
  r = await sara.call('POST', '/api/pending/' + maybe.pending.id, { body: { keep: 'both' } })
  assert.deepEqual(body(r), { error: 'Scelta scaduta', code: 'pending_gone' })

  // "best": decided as the same song (the WAV is better; Sara is not an uploader:
  // the tails of the pair match, so it replaces).
  const k2 = body(await owner.call('PUT', '/api/upload/2.mp3', { body: m2.mp3 })).track
  const p2 = body(await sara.call('PUT', '/api/upload/2.wav', { body: m2.wav })).pending
  r = body(await sara.call('POST', '/api/pending/' + p2.id, { body: { keep: 'best' } }))
  assert.equal(r.outcome, 'replaced')
  assert.equal(r.track.id, k2.id)

  // Unanswered for 24 h: decided both.
  const k3 = body(await owner.call('PUT', '/api/upload/3.mp3', { body: m3.mp3 })).track
  const p3 = body(await sara.call('PUT', '/api/upload/3.wav', { body: m3.wav })).pending
  app.pending._recs.get(p3.id).expiresAt = Date.now() - 1
  await app.sweep()
  assert.equal(app.library.tracks.size, 5)
  assert.ok(app.library.getTrack(k3.id).notSame.length === 1)
  assert.deepEqual(fs.readdirSync(app.pending.dir), [])

  // Local (or an older app): never asked, decided both at once.
  body(await owner.call('PUT', '/api/upload/4.mp3', { body: m4.mp3 }))
  r = body(await request(app.ports.http, 'PUT', '/api/upload/4.wav', { body: m4.wav }))
  assert.equal(r.outcome, 'added')
  assert.equal(body(await sara.call('PUT', '/api/upload/4b.wav', { body: Buffer.concat([m4.wav, Buffer.alloc(0)]) })).outcome, 'duplicate', 'byte identical to the one just added')
})

test('version words: only what stands in brackets, between tildes or after a dash counts; "original mix" and "album version" are the plain song', () => {
  const cases = [
    ['Kokoro (Glow Beyotch Remix)', ['remix']],
    ['Kokoro (Glow Beyotch Remix Instrumental)', ['instrumental', 'remix']],
    ['Live Forever', []],
    ['Song - Live at Budokan', ['live']],
    ['夜に駆ける (オフボーカル)', ['offvocal']],
    ['曲名 〜Instrumental〜', ['instrumental']],
    ['曲名～off vocal～', ['offvocal']],
    ['Pretender [TV Size]', ['tvsize']],
    ['Pretender (Short ver.)', ['short']],
    ['Song (Inst.)', ['instrumental']],
    ['Song (Karaoke)', ['karaoke']],
    ['Song (A Cappella)', ['acapella']],
    ['Song (Acoustic)', ['acoustic']],
    ['Song (Remastered 2015)', ['remaster']],
    ['Song (Original Mix)', []],
    ['Song (Album Version)', []],
    ['Song (Extended Mix)', ['extended', 'mix']],
    ['Song (feat. Someone)', []],
    ['Song (Explicit', ['explicit']],
    ['Song -off vocal-', ['offvocal']],
    ['Song -Instrumental-', ['instrumental']],
    ['Song (オフ・ボーカル)', ['offvocal']],
    ['Song (歌なし)', ['instrumental']],
    ['Song (Backing Track)', ['instrumental']],
    ['Song (without vocals)', ['offvocal']],
    ['Song (Dub Mix)', ['dub', 'mix']],
    ['曲名 (ショートケーキ)', []],
    ['曲名 (インストゥルメンタル)', ['instrumental']],
    ['A-ha - Take On Me', []],
    ['Twenty-One Pilots', []],
    ['', []],
    [null, []]
  ]
  for (const [title, words] of cases) assert.deepEqual(versionWords(title), words, String(title))
  assert.equal(differentVersions('Kokoro (Remix)', 'Kokoro (Remix Instrumental)'), true)
  assert.equal(differentVersions('Song', 'Song (Original Mix)'), false)
  assert.equal(differentVersions('Song (Live)', 'song (LIVE)'), false)
  // A file's name is mostly "artist - title": only brackets, tildes and dash pairs count there.
  assert.equal(differentVersions('Oasis - Live Forever', 'Live Forever', { aName: true }), false)
  assert.equal(differentVersions('Oasis - Live Forever', 'Live Forever'), true, 'as a tag it would be a live take')
  assert.equal(differentVersions('Song (Live)', 'Song', { aName: true }), true)
})

test('dedup: a title that names another version keeps both, whichever comes first: an instrumental never replaces its vocal mix, nor is it taken for it', async (t) => {
  const p = pair('kokoro', { tags: { title: 'Kokoro (Glow Remix)', wavTags: { title: 'Kokoro (Glow Remix Instrumental)' } } })
  const q = pair('kokoro2', { tags: { title: 'Kokoro (Cairo Remix)', wavTags: { title: 'Kokoro (Cairo Remix Instrumental)' } } })
  const { app, owner, ff } = await start(t, { fp: { prints: { ...p.prints, ...q.prints } }, pcmFor: { ...p.pcm, ...q.pcm } })
  const vocal = body(await owner.call('PUT', '/api/upload/03.mp3', { body: p.mp3 })).track
  let r = body(await owner.call('PUT', '/api/upload/09.wav', { body: p.wav }))
  assert.equal(r.outcome, 'added', 'a better file, but another version')
  assert.notEqual(r.track.id, vocal.id)
  assert.equal(app.library.getTrack(vocal.id).fileHash, vocal.id, 'the vocal mix untouched')
  assert.deepEqual(app.library.getTrack(vocal.id).notSame, [r.track.id])
  assert.equal(ff.calls().filter((c) => c.args.includes('f32le') && c.args.includes('2')).length, 0, 'told by the titles: nothing decoded')
  // The instrumental first, then its vocal mix in a worse file: not a claim.
  const instrumental = body(await owner.call('PUT', '/api/upload/09b.wav', { body: q.wav })).track
  r = body(await owner.call('PUT', '/api/upload/03b.mp3', { body: q.mp3 }))
  assert.equal(r.outcome, 'added', 'worse, but another version: kept')
  assert.equal(app.library.tracks.size, 4)
  assert.equal(app.library.getTrack(instrumental.id).fileHash, instrumental.id)
})

test('dedup: two files that sound different where the voice sits are two versions, both kept; a pair that cannot be compared is kept too, not marked', async (t) => {
  const p = pair('suono')
  const q = pair('muto')
  const pcmFor = {
    [hash24(p.mp3)]: { seed: 'suono', cutoffHz: 16000 }, [hash24(p.wav)]: { seed: 'suono', gap: [300, 3000] },
    [hash24(q.mp3)]: { seed: 'muto', cutoffHz: 16000 }, [hash24(q.wav)]: { silent: true }
  }
  const { app, owner } = await start(t, { fp: { prints: { ...p.prints, ...q.prints } }, pcmFor })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  let r = body(await owner.call('PUT', '/api/upload/a.wav', { body: p.wav }))
  assert.equal(r.outcome, 'added')
  assert.equal(app.library.getTrack(kept.id).fileHash, kept.id, 'the kept file untouched')
  assert.deepEqual(app.library.getTrack(kept.id).notSame, [r.track.id], 'told apart for good')
  const kept2 = body(await owner.call('PUT', '/api/upload/b.mp3', { body: q.mp3 })).track
  r = body(await owner.call('PUT', '/api/upload/b.wav', { body: q.wav }))
  assert.equal(r.outcome, 'added', 'silence: cannot tell, nothing destroyed')
  assert.deepEqual(app.library.getTrack(kept2.id).notSame, [], 'and not marked as another song')
})

test('dedup: without the decoder nothing proves one version: both stay', async (t) => {
  const p = pair('senza')
  const { app, owner } = await start(t, { fp: { prints: p.prints }, opts: { ffmpeg: null } })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  const r = body(await owner.call('PUT', '/api/upload/a.wav', { body: p.wav }))
  assert.equal(r.outcome, 'added')
  assert.equal(app.library.getTrack(kept.id).fileHash, kept.id)
  assert.deepEqual(app.library.getTrack(kept.id).notSame, [])
  assert.equal(body(await owner.call('PUT', '/api/upload/c.mp3', { body: p.mp3 })).outcome, 'duplicate', 'the same bytes still are')
})

test('dedup: a title taken from a file named "artist - title" is not read as a version', async (t) => {
  const p = pair('nome', { tags: { title: 'Live Forever' } })
  const { app, owner } = await start(t, { fp: { prints: p.prints }, pcmFor: p.pcm })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  const r = body(await owner.call('PUT', '/api/upload/' + encodeURIComponent('Oasis - Live Forever.wav'), { body: p.wav }))
  assert.deepEqual([r.outcome, r.track.id], ['replaced', kept.id])
  assert.deepEqual(app.library.getTrack(kept.id).notSame, [])
})

test('dedup: "the same song" from the uploader is taken at their word, whatever the decoder hears', async (t) => {
  const m = pair('parola', { flip: 5 })
  const pcmFor = { [hash24(m.mp3)]: { seed: 'parola', cutoffHz: 16000 }, [hash24(m.wav)]: { seed: 'parola', gap: [300, 3000] } }
  const { owner, sara } = await start(t, { fp: { prints: m.prints }, pcmFor })
  const kept = body(await owner.call('PUT', '/api/upload/1.mp3', { body: m.mp3 })).track
  const pending = body(await sara.call('PUT', '/api/upload/1.wav', { body: m.wav })).pending
  const r = body(await sara.call('POST', '/api/pending/' + pending.id, { body: { keep: 'best' } }))
  assert.deepEqual([r.outcome, r.track.id], ['replaced', kept.id])
})

test('dedup: a replacement stops the job reading the old file; a transcode of a file replaced meanwhile is thrown away', async (t) => {
  const p = pair('lavori')
  const q = pair('lavori2')
  const control = { pcm: ONE_VERSION, pcmFor: { ...p.pcm, ...q.pcm } }
  const { app, dir, owner, ff } = await start(t, { fp: { prints: { ...p.prints, ...q.prints } }, pcmFor: control.pcmFor })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  await app.jobs.idle()
  // A transcode of the kept file that takes 20 s, under way when the better file comes.
  const transcodes = () => ff.started().filter((c) => c.args.includes('libopus')).length
  app.jobs.onTrackDeleted(app.library.getTrack(kept.id))
  let n = transcodes()
  ff.control({ ...control, delayFor: { libopus: 20000 }, inputFirst: true })
  app.jobs.requestTranscode(app.library.getTrack(kept.id), 'normal', 0)
  await waitFor(() => transcodes() > n, { what: 'the slow transcode under way' })
  ff.control(control)
  const t0 = Date.now()
  const r = body(await owner.call('PUT', '/api/upload/a.wav', { body: p.wav }))
  assert.deepEqual([r.outcome, r.track.id], ['replaced', kept.id])
  await app.jobs.idle()
  assert.ok(Date.now() - t0 < 10000, 'the old transcode was stopped, not waited for: ' + (Date.now() - t0) + ' ms')
  assert.equal(app.jobs.stats.failed, 0, 'a stopped job is not a failure')
  for (const name of treeFiles(dir, 'transcodes')) {
    assert.match(fs.readFileSync(shardPath(dir, 'transcodes', name), 'latin1'), new RegExp(kept.id + '\\.wav'), name + ': made from the new file')
  }

  // A transcode that ends after its file was replaced (by any path) is not kept.
  const kept2 = body(await owner.call('PUT', '/api/upload/b.mp3', { body: q.mp3 })).track
  await app.jobs.idle()
  app.jobs.onTrackDeleted(app.library.getTrack(kept2.id))
  n = transcodes()
  ff.control({ ...control, delayFor: { libopus: 1500 }, inputFirst: true })
  app.jobs.requestTranscode(app.library.getTrack(kept2.id), 'normal', 0)
  await waitFor(() => transcodes() > n, { what: 'the transcode under way' })
  ff.control(control)
  const newFile = path.join(app.library.tmpDir, 'nuovo.wav')
  fs.writeFileSync(newFile, q.wav)
  const before = app.library.getTrack(kept2.id)
  app.library.replaceFile(kept2.id, newFile, { ...before, format: 'wav', codec: 'wav', lossless: true, fileHash: hash24(q.wav), size: q.wav.length }, before)
  await waitFor(() => app.jobs._running === null, { what: 'the transcode over' })
  const last = ff.started().filter((c) => c.args.includes('libopus')).pop()
  assert.ok(ff.calls().some((c) => c.start === last.start && c.args.join() === last.args.join()), 'it ran to its end, from the old file')
  assert.equal(app.jobs._ready.get(kept2.id + '.normal'), undefined, 'made from the old file: thrown away')
  assert.ok(!fs.existsSync(app.jobs.transcodePath(kept2.id, 'normal')))
})

test('dedup: a replacement that fails leaves no fingerprint of the new file and queues again the job it stopped', async (t) => {
  const p = pair('fallita')
  const control = { pcm: ONE_VERSION, pcmFor: p.pcm }
  const { app, dir, owner, ff } = await start(t, { fp: { prints: p.prints }, pcmFor: p.pcm })
  const kept = body(await owner.call('PUT', '/api/upload/a.mp3', { body: p.mp3 })).track
  await app.jobs.idle()
  // A transcode of the kept file under way when the better file comes; the
  // replacement itself then fails, as when another program holds the file.
  const transcodes = () => ff.started().filter((c) => c.args.includes('libopus')).length
  app.jobs.onTrackDeleted(app.library.getTrack(kept.id))
  const n = transcodes()
  ff.control({ ...control, delayFor: { libopus: 20000 }, inputFirst: true })
  app.jobs.requestTranscode(app.library.getTrack(kept.id), 'normal', 0)
  await waitFor(() => transcodes() > n, { what: 'the transcode under way' })
  ff.control(control)
  const replaceFile = app.library.replaceFile
  app.library.replaceFile = () => {
    app.library.replaceFile = replaceFile
    throw new HttpError(409, 'Brano in uso, riprova tra poco')
  }
  const r = await owner.call('PUT', '/api/upload/a.wav', { body: p.wav })
  assert.equal(r.status, 409)
  assert.equal(app.library.getTrack(kept.id).fileHash, kept.id, 'the old file stays')
  assert.ok(!fs.existsSync(path.join(dir, 'fingerprints', hash24(p.wav) + '.fp')), 'no fingerprint of a file that is not there')
  await app.jobs.idle()
  assert.ok(app.jobs._ready.has(kept.id + '.normal'), 'the stopped transcode was made after all')
})

test('dedup: answering an archive\'s pending entry moves it into the archive\'s counts', async (t) => {
  const m = pair('nello-zip', { flip: 5 })
  const gone = pair('sparita', { flip: 5 })
  const other = makeWav({ seconds: 2, freq: 777 })
  const { app, owner, sara } = await start(t, { fp: { prints: { ...m.prints, ...gone.prints } } })
  const kept = body(await owner.call('PUT', '/api/upload/k.mp3', { body: m.mp3 })).track
  const zip = makeZip([{ name: 'Album/01 forse.wav', data: m.wav, method: 8 }, { name: 'Album/02 altra.wav', data: other }, { name: 'Album/cover.txt', data: 'x' }])
  let r = await sara.call('PUT', '/api/upload/album.zip', { body: zip })
  assert.equal(r.status, 202)
  const id = body(r).archive.id
  await app.archives.idle()
  let st = body(await sara.call('GET', '/api/archives/' + id))
  assert.deepEqual([st.state, st.total, st.done, st.added, st.pending.length], ['done', 2, 2, 1, 1])
  assert.equal(st.pending[0].match.id, kept.id)
  r = body(await sara.call('POST', '/api/pending/' + st.pending[0].id, { body: { keep: 'both' } }))
  assert.equal(r.outcome, 'added')
  st = body(await sara.call('GET', '/api/archives/' + id))
  assert.deepEqual([st.added, st.pending.length, st.trackIds.length], [2, 0, 2])
  assert.equal((await owner.call('GET', '/api/archives/' + id)).status, 404, 'only its uploader sees it')

  // A choice whose file vanished: the answer fails, and the archive does not wait for it for ever.
  body(await owner.call('PUT', '/api/upload/k2.mp3', { body: gone.mp3 }))
  r = await sara.call('PUT', '/api/upload/album2.zip', { body: makeZip([{ name: 'B/01.wav', data: gone.wav }]) })
  const id2 = body(r).archive.id
  await app.archives.idle()
  const pid = body(await sara.call('GET', '/api/archives/' + id2)).pending[0].id
  fs.unlinkSync(app.pending.filePath(app.pending.byId(pid)))
  assert.notEqual((await sara.call('POST', '/api/pending/' + pid, { body: { keep: 'both' } })).status, 200)
  assert.deepEqual(app.archives.record(id2).pending, [])
  assert.equal(body(await sara.call('GET', '/api/archives/' + id2)).ignored, 1)
  // An id whose record went some other way is dropped at the next sweep.
  app.archives.record(id2).pending.push('0123456789abcdef')
  app.archives.sweep()
  assert.deepEqual(app.archives.record(id2).pending, [])
})
