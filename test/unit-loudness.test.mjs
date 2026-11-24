import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loudFromTags, loudFromScan, validLoud, gainOf, TARGET_LUFS } from '../web/js/loudness.js'

test('loudness from the tags: ReplayGain against -18 LUFS, R128 (Q7.8) against -23, the peak in dBFS', () => {
  assert.deepEqual(loudFromTags({ trackGain: -6.52, trackPeak: 0.988 }), { lufs: -11.48, peak: -0.1, album: null, from: 'tag' })
  assert.deepEqual(loudFromTags({ trackGain: 3.1, albumGain: -2, albumPeak: 1.2 }), { lufs: -21.1, peak: null, album: -16, from: 'tag' })
  assert.deepEqual(loudFromTags({ r128Track: -1234, r128Album: 512 }), { lufs: -18.18, peak: null, album: -25, from: 'tag' })
  assert.equal(loudFromTags({ trackGain: -9, r128Track: 100 }).lufs, -9, 'ReplayGain first')
  for (const bad of [null, undefined, {}, { trackPeak: 0.5 }, { trackGain: NaN }, { trackGain: -200 }, { r128Track: 1.5 }]) assert.equal(loudFromTags(bad), null)
})

test('loudness measured, and as stored', () => {
  assert.deepEqual(loudFromScan(-9.234, -0.31), { lufs: -9.23, peak: -0.31, album: null, from: 'scan' })
  assert.deepEqual(loudFromScan(-30, NaN), { lufs: -30, peak: null, album: null, from: 'scan' })
  assert.equal(loudFromScan(-Infinity, 0), null)
  assert.deepEqual(validLoud({ lufs: -12, peak: -1, album: -11, from: 'tag', extra: 1 }), { lufs: -12, peak: -1, album: -11, from: 'tag' })
  for (const bad of [null, {}, { lufs: -12, from: 'guess' }, { lufs: 'x', from: 'tag' }]) assert.equal(validLoud(bad), null)
})

test('the volume plays every song at the target, only ever down', () => {
  assert.equal(TARGET_LUFS, -14)
  assert.equal(gainOf({ lufs: -8, peak: -0.1, album: null, from: 'scan' }), 0.5012, '6 dB louder: half the amplitude')
  assert.equal(gainOf({ lufs: -14, peak: null, album: null, from: 'tag' }), 1)
  assert.equal(gainOf({ lufs: -20, peak: -6, album: null, from: 'tag' }), 1, 'quieter: never raised')
  assert.equal(gainOf({ lufs: -8, peak: null, album: -11, from: 'tag' }, { album: true }), 0.7079, 'the album\'s when asked')
  assert.equal(gainOf(null), 1)
})
