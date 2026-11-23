// Client core, a person's identity without any network: the profile keys, the
// proof and the profile code against the published vectors, the code's
// tolerance and its refusals, the identity file and its name, Argon2id and the
// recovery blob, and the state file before and with profiles.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sodium from 'sodium-native'
import {
  profileKeys, proofValue, proofHeaders, formatProfileCode, parseProfileCode, codeKind, cleanProfileName,
  identityFileName, buildIdentity, identityText, parseIdentity, passwordLongEnough, deriveRecoveryKeys,
  encryptBlob, decryptBlob, pwhashCount, normalizeRecovery, OPSLIMIT, MEMLIMIT
} from '../client-core/identity.js'
import { normalizeState, readStateFile, writeStateFile } from '../client-core/state.js'
import { formatCode, generateSecret } from '../transport/code.js'
import { tmpDir, rmDir, makeProfile, proofHeaders as serverSideHeaders } from './helpers.mjs'

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const SALT = Buffer.from(Array.from({ length: 16 }, (_, i) => i))
const VECTOR = {
  signSeed: 'a671ad54ab08779afd5ed3add073a7ae57d1e7de3e98efcceee8c848fb702e44',
  signPublicKey: 'e4abea2357415e195ded1df44e7a5cb392eb9322970e2598bee865e921ca877e',
  profileId: '22de25661c578b57b919dfcada067bd4',
  code: 'MPFY-P-000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFJ-2XHR',
  proof: 'e4abea2357415e195ded1df44e7a5cb392eb9322970e2598bee865e921ca877eb048c7c1fa3c68cf365c779291890bc3a960804a1f548b6927a5246a3c4f30ad70059762bbc2531bef26a54dced6030f88fe56f3bc27920956bbe2abf2ebe001',
  out: '17adb8a631fe5b557dcf383880d1810613358c6697319365aa455d6b55f10a38923c385343fc7cc3a092495ed8116b0a7cbb1d197e599b4c0cdd658033470744',
  verifierHash: '927e93a56c9a2b71aee79f4ba07e755ab3c879830451ba63b638f8bb18b5f4e3'
}

test('profile keys, proof and code match the published vectors byte for byte', () => {
  const k = profileKeys(SECRET)
  assert.equal(Buffer.from(k.signSeed).toString('hex'), VECTOR.signSeed)
  assert.equal(Buffer.from(k.signPublicKey).toString('hex'), VECTOR.signPublicKey)
  assert.equal(k.id, VECTOR.profileId)
  assert.equal(k.secret, SECRET.toString('hex'))
  assert.equal(profileKeys(SECRET.toString('hex')).id, VECTOR.profileId, 'hex or bytes alike')
  assert.equal(formatProfileCode(SECRET), VECTOR.code)
  assert.equal(proofValue(k, Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)), VECTOR.proof)
  assert.equal(proofValue(k, '11'.repeat(32), '22'.repeat(32)), VECTOR.proof, 'keys as hex give the same')
  assert.deepEqual(proofHeaders(k, '11'.repeat(32), '22'.repeat(32)), { 'X-MPfy-Profile': VECTOR.profileId, 'X-MPfy-Profile-Proof': VECTOR.proof })

  // The same bytes as the sources' own construction (the test helpers mirror the server).
  const other = crypto.randomBytes(32)
  const client = crypto.randomBytes(32).toString('hex')
  const server = crypto.randomBytes(32).toString('hex')
  const theirs = serverSideHeaders(makeProfile(other), client, server)
  const ours = proofHeaders(profileKeys(other), client, server)
  assert.deepEqual({ 'x-mpfy-profile': ours['X-MPfy-Profile'], 'x-mpfy-profile-proof': ours['X-MPfy-Profile-Proof'] }, theirs)
  // Deterministic, and bound to both keys.
  assert.equal(proofValue(k, client, server), proofValue(k, client, server))
  assert.notEqual(proofValue(k, client, server), proofValue(k, server, client))
  const proof = Buffer.from(proofValue(k, client, server), 'hex')
  const message = Buffer.concat([Buffer.from('mpfy/profile/1'), Buffer.from(client, 'hex'), Buffer.from(server, 'hex')])
  assert.equal(message.length, 78)
  assert.equal(sodium.crypto_sign_verify_detached(proof.subarray(32), message, proof.subarray(0, 32)), true)
})

test('profile code: case, spaces, dashes and I/L/O tolerated; length, alphabet and check refused; source and profile codes told apart', () => {
  const ok = (code, what) => assert.ok(parseProfileCode(code) !== null && Buffer.from(parseProfileCode(code)).equals(SECRET), what + ': ' + code)
  ok(VECTOR.code, 'as shown')
  ok(VECTOR.code.toLowerCase(), 'lower case')
  ok(VECTOR.code.replace(/-/g, ' '), 'spaces')
  ok(VECTOR.code.replace(/-/g, ''), 'no separators')
  ok(VECTOR.code.replace(/-/g, '\u2010').replace('MPFY\u2010P\u2010', 'MPFY-P-'), 'typographic hyphens')
  ok(VECTOR.code.replace(/-/g, '\u2212').replace('MPFY\u2212P\u2212', 'MPFY-P-'), 'minus signs')
  ok(VECTOR.code.replace(/-/g, '_'), 'underscores')
  ok('  ' + VECTOR.code + '\n', 'surrounding blanks')
  ok(VECTOR.code.slice('MPFY-P-'.length), 'the 56 characters alone')
  // 1 can be read as I or L, 0 as O.
  ok(VECTOR.code.replace('1W81', 'IW8L').replace('000G', 'OoOG'), 'I, L and O')
  assert.equal(VECTOR.code.replace(/[^0-9A-Z]/g, '').length, 61)

  const last = VECTOR.code.slice(-1)
  assert.equal(parseProfileCode(VECTOR.code.slice(0, -1) + (last === 'R' ? 'S' : 'R')), null, 'wrong check')
  assert.equal(parseProfileCode(VECTOR.code.slice(0, -1)), null, 'one character short')
  assert.equal(parseProfileCode(VECTOR.code + '0'), null, 'one too many')
  assert.equal(parseProfileCode(VECTOR.code.slice(0, -1) + 'U'), null, 'U is outside the alphabet')
  assert.equal(parseProfileCode(VECTOR.code.slice(0, -1) + '*'), null)
  assert.equal(parseProfileCode('XXXXP' + VECTOR.code.slice(7).replace(/-/g, '')), null, 'another prefix')
  assert.equal(parseProfileCode(5), null)

  for (let i = 0; i < 20; i++) {
    const s = crypto.randomBytes(32)
    assert.ok(Buffer.from(parseProfileCode(formatProfileCode(s))).equals(s))
    assert.match(formatProfileCode(s), /^MPFY-P(-[0-9A-HJKMNP-TV-Z]{4}){14}$/)
  }

  const source = formatCode(generateSecret())
  assert.equal(codeKind(source), 'source')
  assert.equal(codeKind(source.slice(5)), 'source', 'without its prefix')
  assert.equal(codeKind(source.toLowerCase().replace(/-/g, ' ')), 'source')
  assert.equal(codeKind(VECTOR.code), 'profile')
  assert.equal(codeKind(VECTOR.code.slice(7)), 'profile')
  assert.equal(codeKind('MPFY-1234'), null)
  assert.equal(codeKind(null), null)
  assert.equal(parseProfileCode(source), null, 'a source code is not a profile code')
})

test('names: 1 to 40 code points after cleanup; the identity file name', () => {
  assert.equal(cleanProfileName('  Bacca  '), 'Bacca')
  assert.equal(cleanProfileName('a\u0007b \n\t c'), 'ab c', 'controls removed, spaces collapsed')
  assert.equal(cleanProfileName('\u{1F3B5}'.repeat(40)), '\u{1F3B5}'.repeat(40), '40 emoji are 40 characters')
  for (const bad of ['', '   ', '\u0001', 'x'.repeat(41), '\u{1F3B5}'.repeat(41), 5, null]) assert.equal(cleanProfileName(bad), null, JSON.stringify(bad))

  assert.equal(identityFileName('Bacca'), 'Bacca.mpfy')
  assert.equal(identityFileName('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij.mpfy')
  assert.equal(identityFileName('  ..nascosto  '), 'nascosto.mpfy', 'leading dots removed')
  // Never a hidden file: dots and spaces in front go together, however mixed.
  assert.equal(identityFileName('. .x'), 'x.mpfy')
  assert.equal(identityFileName(' . . Bacca'), 'Bacca.mpfy')
  assert.equal(identityFileName('.. ..Bacca'), 'Bacca.mpfy')
  assert.equal(identityFileName('.\u00a0.\t.Bacca'), 'Bacca.mpfy', 'any kind of space')
  assert.equal(identityFileName('./.Bacca'), 'Bacca.mpfy', 'a slash between dots is removed first')
  assert.equal(identityFileName('Bacca. .'), 'Bacca. ..mpfy', 'dots elsewhere stay')
  assert.equal(identityFileName('a\u0000b\u001fc\u007fd'), 'abcd.mpfy')
  assert.equal(identityFileName(''), 'MPfy.mpfy')
  assert.equal(identityFileName(' ... '), 'MPfy.mpfy')
  assert.equal(identityFileName('///'), 'MPfy.mpfy')
  assert.equal(identityFileName('\u{1F3B5}'.repeat(70)), '\u{1F3B5}'.repeat(60) + '.mpfy', 'at most 60 characters')
  assert.equal(identityFileName('x'.repeat(59) + ' y'), 'x'.repeat(59) + '.mpfy', 'cut, then trimmed')
  assert.equal(identityFileName('Sara \u00e8 qui'), 'Sara \u00e8 qui.mpfy')
})

function sampleState () {
  const k = profileKeys(SECRET)
  return {
    clientSeed: 'ab'.repeat(32),
    profile: { id: k.id, secret: k.secret, name: 'Bacca', nameUpdatedAt: 1763380000000, createdAt: 1763300000000, photo: null, photoUpdatedAt: 0 },
    recovery: { salt: '00'.repeat(16), opslimit: 3, memlimit: 67108864, encKey: '11'.repeat(32), verifierHash: '22'.repeat(32), updatedAt: 1763380000001 },
    recoveryDeletes: [],
    social: {
      privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: false, updatedAt: 1763380000002 },
      blocked: { ids: ['0b2b8f2b813476f9b1bea832400198fe'], updatedAt: 1763380000003 },
      mutes: { map: { ab25e6e72ec668e6e39fbbb7ff239a74: 0 }, updatedAt: 1763380000004 }
    },
    sources: [
      { id: '33333333', name: 'Mi A2', serverPublicKey: '33'.repeat(32), principal: true, addedAt: 1763380000000, role: 'owner', named: true, profiles: true, social: 1, card: 'ab'.repeat(64) },
      { id: '44444444', name: 'PC', serverPublicKey: '44'.repeat(32), principal: false, addedAt: 1763380000500, role: null, named: null, profiles: false, social: 0, card: null }
    ]
  }
}

test('identity file: shape and order, what it holds; reading checks format, version, the id against the secret, hex fields', () => {
  const st = sampleState()
  const id = buildIdentity(st, { exportedAt: 1763390000000 })
  const text = identityText(id)
  assert.ok(text.endsWith('}\n'))
  assert.equal(text, JSON.stringify(id, null, 2) + '\n')
  assert.deepEqual(Object.keys(id), ['format', 'v', 'profile', 'clientSeed', 'sources', 'recovery', 'exportedAt'])
  assert.deepEqual(id, {
    format: 'mpfy-identity',
    v: 1,
    profile: { id: VECTOR.profileId, secret: SECRET.toString('hex'), name: 'Bacca', nameUpdatedAt: 1763380000000 },
    clientSeed: 'ab'.repeat(32),
    sources: [
      { id: '33333333', name: 'Mi A2', serverPublicKey: '33'.repeat(32), principal: true, addedAt: 1763380000000 },
      { id: '44444444', name: 'PC', serverPublicKey: '44'.repeat(32), principal: false, addedAt: 1763380000500 }
    ],
    recovery: { salt: '00'.repeat(16), opslimit: 3, memlimit: 67108864, encKey: '11'.repeat(32), verifierHash: '22'.repeat(32), updatedAt: 1763380000001 },
    exportedAt: 1763390000000
  })
  assert.equal(buildIdentity(st, { withRecovery: false }).recovery, null, 'the blob\'s plaintext has no recovery')

  const back = parseIdentity(text)
  assert.deepEqual(back.profile, { id: VECTOR.profileId, secret: SECRET.toString('hex'), name: 'Bacca', nameUpdatedAt: 1763380000000, createdAt: back.profile.createdAt })
  assert.equal(back.clientSeed, 'ab'.repeat(32))
  assert.deepEqual(back.recovery, st.recovery)
  assert.equal(back.sources.length, 2)
  assert.deepEqual(parseIdentity(id).profile.id, VECTOR.profileId, 'the parsed object too')
  assert.deepEqual(parseIdentity('\ufeff' + text).profile.id, VECTOR.profileId, 'a byte order mark in front')
  assert.equal(parseIdentity({ ...id, recovery: null }).recovery, null)

  const bad = (change, what) => {
    const copy = JSON.parse(text)
    change(copy)
    assert.equal(parseIdentity(copy), null, what)
  }
  bad((x) => { x.format = 'altro' }, 'format')
  bad((x) => { x.v = 2 }, 'version')
  bad((x) => { x.profile.id = '0'.repeat(32) }, 'the id is not the secret\'s')
  bad((x) => { delete x.profile.id }, 'no id')
  bad((x) => { x.profile.secret = 'zz' + x.profile.secret.slice(2) }, 'the secret is not hex')
  bad((x) => { x.profile.secret = x.profile.secret.slice(2) }, 'the secret is short')
  bad((x) => { x.profile = null }, 'no profile')
  bad((x) => { x.profile.name = 5 }, 'a name that is not text')
  bad((x) => { x.clientSeed = 'ab' }, 'the seed')
  bad((x) => { x.sources = {} }, 'sources not a list')
  bad((x) => { x.recovery.salt = 'abc' }, 'the salt')
  bad((x) => { x.recovery.encKey = 'x'.repeat(64) }, 'the key')
  bad((x) => { x.recovery.opslimit = 4 }, 'other parameters')
  bad((x) => { x.recovery.memlimit = 1024 }, 'other parameters')
  bad((x) => { x.recovery.updatedAt = 'ieri' }, 'the time')
  // A time past the integers a number holds exactly would stop every later change
  // from getting a newer one.
  bad((x) => { x.recovery.updatedAt = 2 ** 53 }, 'a time too large to grow')
  bad((x) => { x.recovery.updatedAt = 1e300 }, 'a time too large to grow')
  for (const huge of [2 ** 53, 1e300]) {
    const copy = JSON.parse(text)
    copy.profile.nameUpdatedAt = huge
    assert.equal(parseIdentity(copy).profile.nameUpdatedAt, 0, 'a name time that cannot grow counts as none: ' + huge)
  }
  assert.equal(parseIdentity({ ...id, recovery: { ...id.recovery, updatedAt: 2 ** 53 - 2 } }).recovery.updatedAt, 2 ** 53 - 2, 'a large time that still grows is kept')
  assert.equal(parseIdentity('{not json'), null)
  assert.equal(parseIdentity('[1]'), null)
  assert.equal(parseIdentity(null), null)
  // Upper case hex is still hex; the id is checked whatever its case.
  const upper = JSON.parse(text)
  upper.profile.id = upper.profile.id.toUpperCase()
  upper.clientSeed = upper.clientSeed.toUpperCase()
  assert.equal(parseIdentity(upper).clientSeed, 'ab'.repeat(32))
  assert.equal(normalizeRecovery({ ...st.recovery, salt: st.recovery.salt.toUpperCase() }).salt, st.recovery.salt)
})

test('recovery crypto: the Argon2id vector, the verifier hash, the blob with its associated data', async () => {
  assert.equal(OPSLIMIT, 3)
  assert.equal(MEMLIMIT, 67108864)
  const runs = pwhashCount()
  const keys = await deriveRecoveryKeys('una frase breve', SALT)
  assert.equal(pwhashCount(), runs + 1)
  assert.equal(Buffer.concat([keys.encKey, keys.verifierKey]).toString('hex'), VECTOR.out)
  assert.equal(Buffer.from(keys.verifierHash).toString('hex'), VECTOR.verifierHash)
  // The password is taken in NFC: the same text typed with a combining accent opens the same.
  const composed = await deriveRecoveryKeys('perch\u00e9 no, dai', SALT)
  const decomposed = await deriveRecoveryKeys('perche\u0301 no, dai', SALT)
  assert.ok(Buffer.from(composed.encKey).equals(decomposed.encKey))

  assert.equal(passwordLongEnough('1234567'), false)
  assert.equal(passwordLongEnough('12345678'), true)
  assert.equal(passwordLongEnough('\u{1F3B5}'.repeat(7)), false, '7 characters, 14 UTF-16 units')
  assert.equal(passwordLongEnough('\u{1F3B5}'.repeat(8)), true)
  assert.equal(passwordLongEnough(12345678), false)

  const st = sampleState()
  const plain = identityText(buildIdentity(st, { withRecovery: false }))
  const blob = encryptBlob(plain, keys.encKey, VECTOR.profileId)
  const raw = Buffer.from(blob, 'base64')
  assert.equal(raw.toString('base64'), blob, 'standard, padded base64')
  assert.equal(raw[0], 1)
  assert.equal(raw.length, 1 + 24 + Buffer.byteLength(plain) + 16)
  assert.equal(decryptBlob(blob, keys.encKey, VECTOR.profileId), plain)
  // The same with libsodium directly: XChaCha20-Poly1305, AD "mpfy/recovery/1" || the 16 id bytes.
  const ad = Buffer.concat([Buffer.from('mpfy/recovery/1'), Buffer.from(VECTOR.profileId, 'hex')])
  const m = Buffer.alloc(raw.length - 1 - 24 - 16)
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, raw.subarray(25), ad, raw.subarray(1, 25), keys.encKey)
  assert.equal(m.toString('utf8'), plain)
  assert.notEqual(encryptBlob(plain, keys.encKey, VECTOR.profileId), blob, 'a fresh nonce every time')

  assert.equal(decryptBlob(blob, keys.encKey, '0'.repeat(32)), null, 'another profile: the associated data differs')
  assert.equal(decryptBlob(blob, keys.verifierKey, VECTOR.profileId), null, 'another key')
  const flipped = Buffer.from(raw)
  flipped[40] ^= 1
  assert.equal(decryptBlob(flipped.toString('base64'), keys.encKey, VECTOR.profileId), null, 'a changed byte')
  const v2 = Buffer.from(raw)
  v2[0] = 2
  assert.equal(decryptBlob(v2.toString('base64'), keys.encKey, VECTOR.profileId), null, 'another version')
  assert.equal(decryptBlob('***', keys.encKey, VECTOR.profileId), null)
  assert.equal(decryptBlob(blob.slice(0, -1), keys.encKey, VECTOR.profileId), null, 'not padded base64')
  assert.throws(() => encryptBlob('x'.repeat(70000), keys.encKey, VECTOR.profileId), 'never more than 64 KiB')
  const big = Buffer.concat([Buffer.from([1]), crypto.randomBytes(65536)]).toString('base64')
  assert.equal(decryptBlob(big, keys.encKey, VECTOR.profileId), null, 'more than 64 KiB is refused unread')
})

test('state file: one from before profiles loads with profile null and keeps seed and sources; profile and recovery fields round-trip; the id follows the secret', async (t) => {
  const dir = tmpDir('mpfy-cc-id-')
  t.after(() => rmDir(dir))
  const file = path.join(dir, 'state.json')
  const old = { clientSeed: 'cd'.repeat(32), sources: [{ id: '55555555', name: 'Mi A2', serverPublicKey: '55'.repeat(32), principal: true, addedAt: 1763000000000 }] }
  fs.writeFileSync(file, JSON.stringify(old, null, 2) + '\n')
  const read = readStateFile(file)
  assert.equal(read.changed, true)
  assert.deepEqual(read.state, {
    clientSeed: old.clientSeed,
    profile: null,
    recovery: null,
    recoveryDeletes: [],
    social: {
      privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 },
      blocked: { ids: [], updatedAt: 0 },
      mutes: { map: {}, updatedAt: 0 }
    },
    sources: [{ ...old.sources[0], role: null, named: null, profiles: null, social: null, card: null }]
  })

  const st = sampleState()
  st.recoveryDeletes = ['44444444']
  await writeStateFile(file, st)
  const text = fs.readFileSync(file, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)), ['clientSeed', 'profile', 'recovery', 'recoveryDeletes', 'social', 'sources'])
  const again = readStateFile(file)
  assert.equal(again.changed, false, 'read back exactly as written')
  assert.deepEqual(again.state, st)

  // A wrong id is put right from the secret; a recovery without a profile goes.
  const wrongId = normalizeState({ ...st, profile: { ...st.profile, id: '0'.repeat(32) } })
  assert.equal(wrongId.changed, true)
  assert.equal(wrongId.state.profile.id, VECTOR.profileId)
  const noProfile = normalizeState({ ...st, profile: null })
  assert.equal(noProfile.state.recovery, null)
  assert.deepEqual(noProfile.state.recoveryDeletes, [])
  const unusable = normalizeState({ ...st, profile: { ...st.profile, secret: 'nope' } })
  assert.equal(unusable.state.profile, null, 'a secret that is not 32 bytes cannot be used')
  const badRecovery = normalizeState({ ...st, recovery: { ...st.recovery, opslimit: 4 } })
  assert.equal(badRecovery.state.recovery, null)
  // An empty name is kept (a profile brought in by its code, not named yet).
  const unnamed = normalizeState({ ...st, profile: { ...st.profile, name: '', nameUpdatedAt: 0 } })
  assert.equal(unnamed.changed, false)
  assert.equal(unnamed.state.profile.name, '')
  // Roles and named as the sources said them; anything else is unknown.
  const roles = normalizeState({ ...st, sources: [{ ...st.sources[0], role: 'boss', named: 'si' }] })
  assert.equal(roles.state.sources[0].role, null)
  assert.equal(roles.state.sources[0].named, null)
  assert.equal(normalizeState({ ...st, sources: [{ ...st.sources[0], role: 'member' }] }).state.sources[0].role, 'member')
  // Whether a source has profiles: kept as the sync left it, unknown otherwise.
  assert.deepEqual(again.state.sources.map((s) => s.profiles), [true, false], 'true and false read back as written')
  const withProfiles = (first, second = st.sources[1]) => normalizeState({ ...st, sources: [first, second] })
  assert.equal(withProfiles({ ...st.sources[0], profiles: null }).changed, false, 'null read back as written')
  for (const bad of ['si', 1, {}]) {
    const r = withProfiles(st.sources[0], { ...st.sources[1], profiles: bad })
    assert.equal(r.state.sources[1].profiles, null, JSON.stringify(bad))
    assert.equal(r.changed, true)
  }
  // A file from before the field: a stored role came from a source with profiles.
  const { profiles: _a, ...owner } = st.sources[0]
  const { profiles: _b, ...unknown } = st.sources[1]
  const older = withProfiles(owner, unknown)
  assert.deepEqual(older.state.sources.map((s) => s.profiles), [true, null])
  assert.equal(older.changed, true, 'written again with the field')
  assert.equal(withProfiles({ ...owner, profiles: null }).state.sources[0].profiles, null, 'a null written stays null')
  // Deletes still due on sources that are gone, or written twice, are dropped.
  assert.deepEqual(normalizeState({ ...st, recoveryDeletes: ['44444444', '44444444', '99999999', 7] }).state.recoveryDeletes, ['44444444'])
})
