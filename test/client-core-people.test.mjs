// The shared formats of the people part in the client core, byte for byte with
// the sources: the chat key, the social key, the profile ID, the conversation ids,
// the profile card, the message box and the sealed mutes (the published vectors),
// and the pure parts of the union: card checks, name tags, the newest of
// everything across sources with their clocks apart.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import sodium from 'sodium-native'
import { profileKeys, profileIdText } from '../client-core/identity.js'
import {
  makeCard, checkCard, cardBytes, cardWins, directId, groupId, nameTags, sameName, unitePeople, uniteRecent, PhotoCache, byName
} from '../client-core/people.js'
import { sealMutes, openMutes, sealBox, openBox, readMessage, cleanMutes } from '../client-core/seal.js'
import { normalizeState, defaultSocial, normalizeSocial } from '../client-core/state.js'
import { cardProblem } from '../server/social.mjs'
import { makeProfile } from './helpers.mjs'

const SECRET_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const SECRET_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i))
const A = profileKeys(SECRET_A)
const B = profileKeys(SECRET_B)
const hex = (b) => Buffer.from(b).toString('hex')
const T = (n) => n.toString(16).padStart(24, '0')
const BOX_VECTOR = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIGuLgZwv5YbBVmZYXBk6ywUtAblXDsqanLPvxSKltdsjV0dSeUGh4Si3RDK2uKYIgKtavYhq8dNwVsUPbCKAlxS9PcXtYospzv7F1jQJ+UPgKtMoMYgKiom76pIJmVHNuF1a9APTwsDdJH2h6/qIt1vCAGU68h+Zc/zu5IbnSl9xmqP2xZEDTRmR8x3RMCJCB+SpY0H3hlr7uRAcleJB9wT85hQjBQfrZo+animGE4ehGaZHmKZ1io34Hce8IA=='
// The mutes of A ({ <direct id of A and B>: 0 }) sealed with A's social key and a nonce of 24 x 0x44.
const MUTES_VECTOR = 'REREREREREREREREREREREREREREREREoRUJNkQ00t1TcTtlqxCluepO/SS7M9up9ugw28ytFw9rnAnokF7ON9XsMGF9f8OJwCUHLEoL'
const PLAIN = '{"v":1,"id":"00112233445566778899aabbccddeeff","from":"22de25661c578b57b919dfcada067bd4","at":1763380060000,"c":["ab25e6e72ec668e6e39fbbb7ff239a74"],"t":"text","text":"ciao"}'

test('vectors: chat keys, social key, profile ids and IDs, conversation ids', () => {
  const seed = Buffer.alloc(32)
  sodium.crypto_generichash(seed, Buffer.concat([Buffer.from('mpfy/chat-key/1'), SECRET_A]))
  assert.equal(seed.toString('hex'), '2e1d7b230aae72a8dfb9d0fa3147c28146086ca494c8d0d7deb1ff17a1b879c6')
  assert.equal(A.id, '22de25661c578b57b919dfcada067bd4')
  assert.equal(hex(A.chatPublicKey), 'd82c0f67c35fa61aff7e4eb051b36cd9758ca253d072f18d335218c86640b968')
  assert.equal(profileIdText(A.id), '4BF2-ASGW')
  assert.equal(B.id, '0b2b8f2b813476f9b1bea832400198fe')
  assert.equal(hex(B.chatPublicKey), '392d7df62eb65c01793171b4a9f39c6bfb6509f23725096b5abea688dfccf90f')
  assert.equal(profileIdText(B.id), '1CNR-YAW1')
  assert.equal(hex(A.socialKey), '22d6eae8cb26a732eb04fb0e665bc2b03e1fb51e948b023b120031106cd31672')
  assert.equal(A.chatSecretKey.byteLength, 32)
  assert.equal(directId(A.id, B.id), 'ab25e6e72ec668e6e39fbbb7ff239a74')
  assert.equal(directId(B.id, A.id), 'ab25e6e72ec668e6e39fbbb7ff239a74', 'the same from both sides')
  assert.equal(groupId('22'.repeat(32)), 'cac44b906c75b7bce7fd9f8b78224c35')
  // The ID: 8 Crockford digits of the first 40 bits, one hyphen, never the profile code.
  assert.equal(profileIdText('0'.repeat(32)), '0000-0000')
  assert.equal(profileIdText('ffffffffff' + '0'.repeat(22)), 'ZZZZ-ZZZZ')
  assert.equal(profileIdText('ffffffffff' + 'f'.repeat(22)), 'ZZZZ-ZZZZ', 'only the first 10 hex count')
  assert.equal(profileIdText('nope'), null)
  assert.equal(profileIdText(A.id.toUpperCase()), null)
})

test('vectors: the card of A, made here and checked by both sides', () => {
  const card = makeCard(A, 'Bacca', null, 1763380004000)
  assert.equal(Buffer.from(cardBytes(card)).toString('utf8'), 'mpfy/card/1[1,"22de25661c578b57b919dfcada067bd4","d82c0f67c35fa61aff7e4eb051b36cd9758ca253d072f18d335218c86640b968","Bacca",null,1763380004000]')
  assert.equal(card.sig, 'f092ac36a3c08c8cbfe2a1465461a62c2561e6359df8a0b56fdd9c928b6a83a98a009de11205ef32754476b45695065768038129b858fccb86620b9e9f52470c')
  assert.deepEqual(Object.keys(card), ['v', 'profileId', 'signPublicKey', 'chatPublicKey', 'name', 'photo', 'updatedAt', 'sig'])
  assert.equal(checkCard(card), true)
  assert.equal(cardProblem(card), null, 'the source takes it as it is')
  // A name with characters JSON escapes, and a photo: the same bytes on both sides.
  const odd = makeCard(B, 'Gi\u00f9lia "G" \\ \u{1F30A}', 'ab'.repeat(32), Date.now())
  assert.equal(checkCard(odd), true)
  assert.equal(cardProblem(odd), null)
})

test('cards: each rule of a valid card, and the newest wins', () => {
  const now = Date.now()
  const ok = makeCard(B, 'Giulia', null, now - 10)
  const other = profileKeys(crypto.randomBytes(32))
  const bad = [
    [{ ...ok, profileId: other.id }, 'the id of another key'],
    [{ ...ok, extra: 1 }, 'nine keys'],
    [makeCard(B, 'Giu\u0007lia', null, now), 'a control character'],
    [makeCard(B, 'x'.repeat(41), null, now), '41 characters'],
    [makeCard(B, 'Giulia ', null, now), 'not as cleaned'],
    [makeCard(B, 'Giulia', null, now + 6 * 60000), '6 minutes ahead'],
    [makeCard(B, 'Giulia', null, 0), 'time 0'],
    [{ ...ok, sig: '00'.repeat(64) }, 'a bad signature'],
    [{ ...ok, name: 'Giulio' }, 'renamed by a source'],
    [{ ...ok, chatPublicKey: hex(other.chatPublicKey) }, 'a chat key swapped by a source'],
    [{ ...ok, photo: 'xy' }, 'a photo that is not a hash'],
    [{ ...ok, v: 2 }, 'another version'],
    [null, 'null']
  ]
  for (const [card, what] of bad) assert.equal(checkCard(card, now), false, what)
  assert.equal(checkCard(makeCard(B, 'x'.repeat(40), null, now), now), true, '40 characters')
  assert.equal(checkCard(makeCard(B, '\u{1F30A}'.repeat(40), null, now), now), true, '40 code points, 80 UTF-16 units')
  const newer = makeCard(B, 'Giulia', null, now)
  assert.equal(cardWins(newer, ok), true)
  assert.equal(cardWins(ok, newer), false)
  const x = makeCard(B, 'Uno', null, now)
  const y = makeCard(B, 'Due', null, now)
  const [low, high] = x.sig < y.sig ? [x, y] : [y, x]
  assert.equal(cardWins(high, low), true, 'the same time: the greater signature')
  assert.equal(cardWins(low, high), false)
})

test('vectors: the box of A to B opens at B, and A drops the same box on its sender', () => {
  const nonce = Buffer.alloc(24, 0x33)
  const box = sealBox(PLAIN, B.chatPublicKey, A.chatSecretKey, nonce)
  assert.equal(box, BOX_VECTOR)
  const atB = openBox(box, A.chatPublicKey, B.chatSecretKey)
  assert.equal(Buffer.from(atB).toString('utf8'), PLAIN)
  const record = { id: '00112233445566778899aabbccddeeff', from: A.id, at: 1763380060000, conversation: 'ab25e6e72ec668e6e39fbbb7ff239a74' }
  assert.equal(readMessage(atB, record).text, 'ciao')
  // The key of A and B is the same both ways: at A the box opens "from B" too.
  const atA = openBox(box, B.chatPublicKey, A.chatSecretKey)
  assert.equal(Buffer.from(atA).toString('utf8'), PLAIN)
  assert.equal(readMessage(atA, { ...record, from: B.id }), null, 'dropped on from')
  assert.equal(readMessage(atB, { ...record, id: 'ff'.repeat(16) }), null, 'another id')
  assert.equal(readMessage(atB, { ...record, at: record.at + 1 }), null, 'another time')
  assert.equal(readMessage(atB, { ...record, conversation: 'cac44b906c75b7bce7fd9f8b78224c35' }), null, 'another conversation')
  const C = profileKeys(crypto.randomBytes(32))
  assert.equal(openBox(box, A.chatPublicKey, C.chatSecretKey), null, 'not for C')
  assert.equal(openBox('not base64', A.chatPublicKey, B.chatSecretKey), null)
  assert.equal(readMessage(Buffer.from('not json'), record), null)
  assert.equal(readMessage(Buffer.from(JSON.stringify({ ...JSON.parse(PLAIN), v: 2 })), record), null)
})

test('vectors: the mutes of A sealed with its social key; another device of A opens them, nobody else', () => {
  const map = { ab25e6e72ec668e6e39fbbb7ff239a74: 0 }
  const box = sealMutes(map, A.socialKey, Buffer.alloc(24, 0x44))
  assert.equal(box, MUTES_VECTOR, 'the whole box, byte for byte')
  assert.deepEqual(openMutes(box, profileKeys(SECRET_A).socialKey), map)
  assert.equal(openMutes(box, B.socialKey), null)
  const random = sealMutes({ ['cd'.repeat(16)]: 1763380060000 }, A.socialKey)
  assert.notEqual(random, sealMutes({ ['cd'.repeat(16)]: 1763380060000 }, A.socialKey), 'a random nonce each time')
  assert.deepEqual(openMutes(random, A.socialKey), { ['cd'.repeat(16)]: 1763380060000 })
  assert.equal(openMutes('AAAA', A.socialKey), null)
  assert.equal(openMutes(null, A.socialKey), null)
  assert.deepEqual(cleanMutes({ ['ab'.repeat(16)]: 5, nope: 1, ['cd'.repeat(16)]: -1, ['ef'.repeat(16)]: 1.5 }), { ['ab'.repeat(16)]: 5 })
})

test('names: tags only where names clash (you among them), all 8 characters when the first 4 clash too', () => {
  assert.equal(sameName('Giulia', 'giulia'), true)
  assert.equal(sameName('Giulia', 'Gi\u00fclia'), true, 'accents aside')
  assert.equal(sameName('Giulia', 'Giulio'), false)
  const me = { id: '22de25661c578b57b919dfcada067bd4', name: 'Bacca' }
  const g1 = { id: '0b2b8f2b813476f9b1bea832400198fe', name: 'Giulia' }
  const g2 = { id: 'aaaaaaaaaa' + '0'.repeat(22), name: 'GI\u00d9LIA' }
  const marco = { id: 'bbbbbbbbbb' + '0'.repeat(22), name: 'Marco' }
  let tags = nameTags([me, g1, g2, marco])
  assert.equal(tags.get(g1.id), '1CNR')
  assert.equal(tags.get(g2.id), profileIdText(g2.id).slice(0, 4))
  assert.equal(tags.get(marco.id), null)
  assert.equal(tags.get(me.id), null)
  // A clash with you: both of you get one.
  tags = nameTags([{ ...me, name: 'Marco' }, g1, marco])
  assert.equal(tags.get(me.id), '4BF2')
  assert.equal(tags.get(marco.id), profileIdText(marco.id).slice(0, 4))
  assert.equal(tags.get(g1.id), null)
  // The same name and the same first 4 characters: the whole ID.
  const twin1 = { id: '0000000001' + '0'.repeat(22), name: 'Anna' }
  const twin2 = { id: '0000000002' + '0'.repeat(22), name: 'anna' }
  tags = nameTags([me, twin1, twin2])
  assert.equal(tags.get(twin1.id), '0000-0001')
  assert.equal(tags.get(twin2.id), '0000-0002')
  // Order by name, then id.
  const sorted = [marco, g2, g1].sort(byName)
  assert.deepEqual(sorted.map((x) => x.id), [g1.id, g2.id, marco.id])
})

test('union: the newest card, a bad one dropped from its source only, now and last by this clock across sources 90 s apart, seen all over chat', () => {
  const now = Date.now()
  const g = makeProfile()
  const gk = profileKeys(g.secret)
  const older = makeCard(gk, 'Giulia', null, now - 60000)
  const newer = makeCard(gk, 'Giulia R.', null, now - 1000)
  const forged = { ...newer, name: 'Falsa' }
  const play = (n, at) => ({ trackId: T(n), title: 'Brano ' + n, artist: 'Lumen Marino', album: 'Ultimo traghetto', at })
  // Source 2's clock is 90 s behind: its times are 90 s smaller for the same moment.
  const answers = [
    { source: 's1', offset: 0, people: [{ profileId: g.id, card: older, seen: 'chat', now: play(1, now - 30000), last: { ...play(1, now - 30000), artistPage: true } }] },
    { source: 's2', offset: 90000, people: [{ profileId: g.id, card: newer, seen: 'all', now: play(2, now - 90000 - 10000), last: play(2, now - 90000 - 10000) }] }
  ]
  const bad = []
  let u = unitePeople(answers, { self: A.id, now, onBad: (s, id) => bad.push([s, id]) })
  const e = u.get(g.id)
  assert.equal(e.card.name, 'Giulia R.', 'the newest card')
  assert.equal(e.seen, 'all')
  assert.equal(e.now.trackId, T(2), 'newest by this clock (10 s ago against 30 s ago)')
  assert.equal(e.now.at, now - 10000)
  assert.deepEqual(e.last, { ...play(2, now - 10000), artistPage: false })
  assert.deepEqual(e.sources, ['s1', 's2'])
  assert.deepEqual(bad, [])

  // A forged card on one source: that source's word on the person goes, the other stays.
  u = unitePeople([{ ...answers[0] }, { ...answers[1], people: [{ ...answers[1].people[0], card: forged }] }], { self: A.id, now, onBad: (s, id) => bad.push([s, id]) })
  assert.equal(u.get(g.id).card.name, 'Giulia')
  assert.deepEqual(u.get(g.id).sources, ['s1'])
  assert.equal(u.get(g.id).now.trackId, T(1))
  assert.deepEqual(bad, [['s2', g.id]])
  // Only "chat" anywhere: chat.
  u = unitePeople([answers[0]], { self: A.id, now })
  assert.equal(u.get(g.id).seen, 'chat')
  // A "now" kept here past its time (a source that cannot be asked again) is no longer now.
  u = unitePeople([{ ...answers[0], offset: -200000 }], { self: A.id, now })
  assert.equal(u.get(g.id).now, null)
  assert.equal(u.get(g.id).last.trackId, T(1))
  // Yourself and malformed entries never count; a card under another profileId neither.
  const mine = makeCard(A, 'Bacca', null, now)
  u = unitePeople([{ source: 's1', offset: 0, people: [{ profileId: A.id, card: mine, seen: 'all' }, null, { profileId: 'x' }, { profileId: g.id, card: mine, seen: 'all' }] }], { self: A.id, now })
  assert.equal(u.size, 0)

  const recent = uniteRecent([
    { offset: 0, recent: [play(1, now - 5000), play(2, now - 50000)] },
    { offset: 90000, recent: [{ ...play(2, now - 90000 - 1000), artistPage: true }, play(3, now - 90000 - 70000), { bad: true }] }
  ])
  assert.deepEqual(recent.map((r) => [r.trackId, r.at, r.artistPage]), [[T(2), now - 1000, true], [T(1), now - 5000, false], [T(3), now - 70000, false]])
  const many = uniteRecent([{ offset: 0, recent: Array.from({ length: 30 }, (_, i) => play(i + 1, now - i)) }])
  assert.equal(many.length, 20)
})

test('photo cache: the latest 64 by hash', () => {
  const cache = new PhotoCache()
  for (let i = 0; i < 70; i++) cache.set('h' + i, Buffer.from([i]))
  assert.equal(cache.size, 64)
  assert.equal(cache.get('h0'), null)
  assert.ok(cache.get('h6') !== null)
  cache.set('h70', Buffer.from([70]))
  assert.ok(cache.get('h6') !== null, 'used lately: kept')
  assert.equal(cache.get('h7'), null, 'the least used went')
})

test('state: the social settings round-trip, defaults without a profile or from before them, bad parts repaired', () => {
  const seed = 'ab'.repeat(32)
  const profile = { id: A.id, secret: A.secret, name: 'Bacca', nameUpdatedAt: 5, createdAt: 5, photo: null, photoUpdatedAt: 0 }
  const social = {
    privacy: { invisible: true, showNow: false, privateUntil: 7, showRecent: false, updatedAt: 9 },
    blocked: { ids: [B.id], updatedAt: 10 },
    mutes: { map: { ab25e6e72ec668e6e39fbbb7ff239a74: 0 }, updatedAt: 11 }
  }
  const st = { clientSeed: seed, profile, recovery: null, recoveryDeletes: [], social, sources: [] }
  const r = normalizeState(st)
  assert.equal(r.changed, false)
  assert.deepEqual(r.state.social, social)
  assert.deepEqual(normalizeState({ ...st, profile: null }).state.social, defaultSocial(), 'none without a profile')
  const before = normalizeState({ clientSeed: seed, profile, recovery: null, recoveryDeletes: [], sources: [] })
  assert.equal(before.changed, true)
  assert.deepEqual(before.state.social, defaultSocial())
  const repaired = normalizeSocial({ privacy: { invisible: 'yes', privateUntil: -1, updatedAt: 3.5 }, blocked: { ids: ['x', B.id, B.id] }, mutes: { map: { nope: 1 }, updatedAt: 'x' } })
  assert.deepEqual(repaired, {
    privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 3 },
    blocked: { ids: [B.id], updatedAt: 0 },
    mutes: { map: {}, updatedAt: 0 }
  })
})
