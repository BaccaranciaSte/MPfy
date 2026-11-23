# client-core

The local core of the MPfy app. The same files run inside the Android worklet (Bare) and on the
PC (`client-node/`, Node 22).

```js
import { createClientCore } from '../../client-core/index.js'

const core = createClientCore({
  statePath,   // e.g. <filesDir>/mpfy-state.json (created when missing, 0600)
  webRoot,     // e.g. <filesDir>/web-<versionCode>
  port: 47123, // fixed in the app: the WebView origin depends on it
  deviceName,  // Build.MODEL, sent to a source when pairing
  onEvent      // (event) => {}, see below
})
const { port } = await core.start() // state loaded, links started, 127.0.0.1:<port> listening
core.state()    // { running, port, publicKey, profileId, connections, sources: [...with serverPublicKey, stats] }
core.refresh()  // call on a network change (Wi-Fi <-> mobile): every link re-checks itself
await core.stop()
```

Events, for the host only (the page never sees them; it reads `/local/*`):
- `{ type: 'sources', sources }` (the same entries as `GET /local/sources`; on a host with phone
  music also `home`, where the person's data lives: the real principal's id, or `"0000"` while the
  phone store is the home, and the event comes whenever the home moves too) whenever the list
  changes, a source's name, role, `named`, `profiles` or `social` changes, or a link goes up or down. RTT
  and throughput changes alone are not announced: read them with `GET /local/sources`.
- `{ type: 'profile', profile }` (`{ id, name, nameUpdatedAt, photo, pid }`) whenever the profile
  changes (its photo too).
- `{ type: 'identity', fileName, identity }` at start when there is a profile, and after every
  change of what the identity file holds (profile, name, device key, sources, principal,
  recovery): the app keeps `Documents/MPfy/<fileName>` up to date from it. `identity` holds the
  profile secret and the device key.

Optional extras (tests, diagnostics): `log(line)`, `bootstrap` (DHT bootstrap nodes), `dht` (an
existing HyperDHT node, not destroyed by `stop()`), `offlineWaitMs` (6000), `headTimeoutMs`
(30000), `pairTimeoutMs` (45000), `revokeTimeoutMs` (2000), `syncEveryMs` (300000),
`firstSyncWaitMs` (5000), `recoverySessionMs` (600000), `recoveryRequestMs` (15000),
`peopleFreshMs` (25000), `activityGapMs` (6000), `chatFreshMs` (8000), `chatHoldSeconds` (25),
`chatGroupFreshMs` (60000).

## The person: profile, identity file, recovery

- A profile is a 32-byte secret; everything else follows from it (`identity.js`): the Ed25519
  key, the profile id, the profile code `MPFY-P-...` (the secret and a 3-byte check). Once there
  is a profile, every request to a source (forwarded or the core's own) carries
  `X-MPfy-Profile` and `X-MPfy-Profile-Proof`, signed for this device's key and that source's
  key, made once per source. Whatever the page sends under those names is dropped.
- Each source is synced when its link comes up, every 5 minutes, on `POST /local/sync` and after
  every change of the identity, one sync at a time per source: whether it has profiles, its role,
  its own name and whether its owner named it; the profile name (the newest `nameUpdatedAt` wins,
  an empty name is never taken from a source); the profile photo (the newest `photoUpdatedAt`
  wins, a removal too, and at the very same time the greater hash, none below any photo, as on the
  sources; the bytes are taken only when they hash to the photo the source announced, and a source
  from before photos is left alone); this device's recovery blob (sent again whenever its time differs;
  deleted where recovery was turned off, and wherever a source still holds one while recovery is
  off here, as after bringing back an identity file made before recovery was turned on).
- A time a source gives back is taken only when it could be real: whole milliseconds, at most 5
  minutes ahead (the sources' own bound for names). A name or a photo with any other time counts
  as none.
- The profile photo is a JPEG of at most 48 KB the page makes (320 x 320). Its SHA-256 names it:
  the state keeps the hash and its time, the bytes are `<statePath>.photo-<hash>.jpg`
  (`state.json.photo-<hash>.jpg`), written before the state names them; files of that name the
  state does not name are removed at `start()` (another state file in the same folder keeps its
  own), and a photo whose file is gone counts as none (time 0, so a source gives it back). A file
  that cannot be read at start for another reason (held by an antivirus) keeps its photo. The
  identity file and the recovery blob never hold it: a new profile, a code or a file brought in
  start without one, until a source has it.
  The recovery blob's time is always this device's own: a source that keeps a newer blob of this
  device keeps it until this device's time passes it.
- Recovery: Argon2id (opslimit 3, memlimit 64 MiB, always the asynchronous call) gives the key
  that seals the identity for every source; the state keeps that key, never the password. Any
  change of the identity gives the blob a new time, so every source gets a fresh one.
- On a new device, `POST /local/recovery` pairs with a source's code as a guest over a link of
  its own, lists who can be recovered there, and `POST /local/recovery/<session>` turns this
  device into the one that made the blob: its old key is forgotten on every source first. A
  session ends at a cancel, after 10 minutes without use, at `stop()`, when another one starts
  and as soon as a profile is made or brought in. Then the source forgets this device, unless at
  that moment it is one of this device's sources and the key is still the one it admitted.

## People

The social part, with every source whose `GET /api/profile` carries `social.v` 1 or more (`social`
in `/local/sources`: 1 people, 2 chats, 3 songs, 0 for a source without it, null until a sync
tells). A source without it is never asked anything social, and its people are not listed.

- Keys (`identity.js`, made again from the profile secret at every start, never stored): the
  chat key pair `crypto_box_seed_keypair(BLAKE2b-256("mpfy/chat-key/1" || secret))` and
  `socialKey = BLAKE2b-256("mpfy/social-box/1" || secret)`. The profile ID people see is the
  first 40 bits of the profile id in Crockford base32, `XXXX-XXXX` (`profileIdText`).
- The card (`people.js`): `{ v: 1, profileId, signPublicKey, chatPublicKey, name, photo,
  updatedAt, sig }`, signed with the profile key over `"mpfy/card/1"` and the JSON of
  `[1, profileId, chatPublicKey, name, photo, updatedAt]`, `updatedAt` the newer of the name's
  and the photo's times; none while the name is empty. Every sync sends it (after the name and
  the photo) to a social source whose card is older, or whose card has the same time but was
  never confirmed to be this one (the signature it keeps is remembered per source, `card` in the
  state); when such a source keeps another card of the very same time, this one goes out a
  millisecond later. Every card read from a source is checked (keys, id, name, photo, time,
  signature): a source can neither rename a person nor swap their chat key.
- The settings (`social` in the state, never in the identity file or the recovery blob; a new,
  imported or recovered profile starts from the defaults and the sources give them back): three
  sections, `privacy`, `blocked`, `mutes`, each with its time. At a sync the newest wins per
  section, as for the name (equal times ask nothing); a change made here is sent to every
  connected social source at once (a sync of each), one that fails waits for the next sync. At a
  sync the settings go before the card, so a source that never had this profile's card never
  lists an invisible person, not even for a moment; while a source refuses the privacy of an
  invisible person, the card waits for it. The mutes travel sealed (`seal.js`:
  `crypto_secretbox` with `socialKey`, a random nonce in front, base64): no source can read
  them, and a box that does not open is left aside.
- The people union: per social source the last `GET /api/people` (its ETag, when it came, and
  the offset between this clock and the source's `time`, so its times are moved into this
  clock). `GET /local/people` reads again, in parallel, every connected social source whose answer
  is older than 25 s (`If-None-Match`, 8 s timeout), waits 3 s at most, then answers from what
  it has. Per person: the newest valid card, `seen` "all" when any source says so, the newest
  `now` and `last`, the sources that list them. A card that does not verify is left out from
  that source only (logged once). `tag`: the first 4 characters of the profile ID when someone
  else in the union, or you, has the same name (case and accents aside), all 8 when those also
  share the first 4. There is no timer: nothing is read unless the page asks.
- Photos of others: read from a source of that person, kept only when their SHA-256 is the
  card's `photo` (else the next source is tried), the latest 64 in memory.
- Activity: `PUT /local/activity` goes to every connected social source as `PUT /api/activity
  { track, playing, now: showNow, recent: showRecent }`, one request at a time per source, the
  latest call replacing one still waiting, at least 6 s between two starts (10 a minute at most);
  a source that is down is skipped. Nothing goes out while invisible, during a private session or
  with both switches off.

## Chats

With every source whose `social` is 2 or more (`chat.js`; boxes in `seal.js`).

- Where a conversation lives: a direct one (id: the direct id of the two profiles) on every
  source at 2 or more that lists the other person; a group on its source (id: from the source's
  key). Sources whose `GET /api/chat/group` lists exactly the same people are one group, named
  after the principal among them (else the oldest added), its `ids` all their group ids, the
  principal's first; a message to it goes to each of them with `c` holding every id. When the
  people differ they are separate again. A group's people are read again when older than a
  minute, while the list is asked and before a group message.
- Reading: per source and conversation a cursor. Each list of a source (`GET
  /api/chat/conversations`) names the newest seq of each conversation; what is above the cursor
  is read (`after`, or the newest 200 when starting or more than 200 behind; after such a jump
  what was held from before that page goes, and comes back from the sources when the page scrolls
  up, so a deletion in the records skipped never stays unseen); a single new message comes inside
  the list itself and needs no request. Each box is opened with the sender's chat key
  from the sender's signed card in the people union (never a key a source gives) and must match
  its record (`readMessage`: version, id, sender, time, and the conversation among its `c`);
  anything else is dropped (logged once), and so is, in a direct conversation, a record whose
  sender is neither of its two people. A record whose sender's card is not known yet waits for
  the next list. Merged by id, deletions applied wherever they come from, ordered by time then
  id. Memory only, never on disk: the newest 200 per conversation, older pages read when the page
  asks (`before`) and dropped 10 minutes after the chat was last asked, 5,000 at most. A
  conversation a source no longer lists (gone there whole: the other person was removed from that
  source, which deletes their direct conversations) loses its cursor there and every message only
  that source held; what other sources hold stays.
- Freshness: `GET /local/chat/conversations` reads again every connected source whose list is
  older than 8 s, waits 3 s at most, and answers from what it has. While the page (or the Android
  notifier) asked in the last 20 s, the core keeps one held list request open per source (`?wait=25`
  with the ETag it has: the source answers when something changes, or after 25 s with a 304), so
  a message is here as soon as it lands, with one request every 25 s instead of one every 10 s; a
  source that answers such a request at once (it does not hold) is read the ordinary way. When
  nobody asks, nothing is asked: no timer of its own.
- Read marks: per conversation the newest (`at`, `id`) across its sources and this device; a
  source holding an older one gets it at its next list. Sending a message moves the mark to it.
- Writing: the plaintext of `seal.js` (at most 12,288 bytes), one box per recipient: a direct one
  for the two; a group for its people who have a signed card from that very source (one without
  is left out and logged once), and always this profile. `POST` to every source of the
  conversation; 201 or 200 from one is `sent`; a source that is down, or answers 5xx or 429, gets
  it later from the outbox; another 4xx drops that source for it; every source refusing is
  `failed` (kept 2 minutes, then gone). A playlist card keeps in `sources` the sources the page named
  (where its library holds the playlist; the principal when it names none) that also hold the
  conversation, and the copy for each of them carries the playlist id in the clear (`playlist`),
  so that source serves the playlist to the conversation's people while the message lives (only
  when it really keeps that playlist for this profile).
- The outbox, `<statePath>.chat-outbox.json` (atomic, 0600, gone when empty): `[{ source, cid, op:
  "post" | "delete", body, at }]`, boxes and ids only, at most 500 (the oldest go), each dropped 30
  days after `at`; sent in order, one at a time per source, when its link comes up and at each of
  its lists. A message or a deletion for a source that still has older ones waiting goes after
  them. A message deleted for everyone leaves it at once, whether deleted here or seen deleted on a
  source (another device of this profile): a source that was down never gets it. Another profile
  here (made, imported, recovered) empties it, and so does removing the source (its entries).
- The silent group entry: at each sync of a source at 2 or more whose `GET /api/profile` says
  `social.access` 0, once the source holds this profile's card, `PUT /api/chat/group/access { at,
  sig }`, `sig` the Ed25519 signature of `"mpfy/chat-access/1"` and the JSON of `[1, profileId,
  groupId, at]`; with the card already there it goes before the settings. It makes the person one
  of the group's recipients even while invisible, without showing anything.
- Blocks hide here too, whatever a source says: a blocked person's direct conversation and their
  group messages never reach the page. Mutes are the sealed `mutes` of the settings.

## Locale: the phone's own music

On a host that has it (the Android app passes `phone: { dir, artDir, appVersion, send }`; the
worklet builds it from the `start` message's `phoneDir`, `artDir` and `appVersion`), the core
serves the phone's own music as a source of its own, "Locale", id `0000` (`phone.js`): never in
the list of sources, never principal, never social. Kotlin owns the files (MediaStore, reading
each file once, its covers and tag lyrics, playback, the HTTPS of the lookups); the core owns
Locale's library log, its answers and the details and lyrics the network fills.

- The feed, Kotlin to the core (`core.phoneMessage(msg)`, applied one at a time in arrival
  order): `{ t: 'local', op: 'access', granted }`, `{ op: 'progress', pending }`, `{ op: 'put',
  token, batch, tracks: [F] }` (at most 200 tracks and 256 KB), `{ op: 'drop', token, batch,
  ids }`, `{ op: 'reset', token }` and `{ op: 'end', token, batch }` (a full resend: at its end
  every track not put since its reset is dropped). The core to Kotlin (`send`): `{ t:
  'local-hello', token, batch }` once after the start (where its feed stands: a token unlike
  Kotlin's means a full resend), `{ t: 'local-ack', token, batch }` once the batch is in the log
  and synced. A batch already in is acked again without a change; a batch of another token is
  left alone.
- The facts F of a file: `{ id, name, size, mtime, addedAt, tags: { title, artist, album,
  albumArtist, trackNo, discNo, year }, format, codec, duration, bitrate, sampleRate, bitDepth,
  coverId, lyrics: { synced: [[{ t, text }]], texts: [text], lrc }, was: [id] }`, raw values
  (null for a tag the file does not have). The core builds the served track exactly as a source
  builds the same file (`phone-rules.js`, checked against the source's code by
  `test/unit-phone-rules.test.mjs`); a put of facts equal to the stored ones changes nothing.
- `/s/0000/api/library`, `/api/cover/<id>`, `/api/lyrics/<id>` and `PATCH /api/admin/source {
  details }` are the source's routes and answers (deltas, epochs, ETags, version headers;
  never gzip; long answers written in pieces). Covers come from the core's `art/` (the network's),
  then the host's `artDir`, then the person's covers. The person's routes (playlists, likes,
  played, recents, playlist covers) go raw to the home whenever the home is a real source. Every
  other route: 404.
- `GET /local/sources` gains `phone: { id: "0000", name: "Locale", state: "off" | "scanning" |
  "ready", tracks, v: "<version>.<userVersion>", home, details, shadowed }`; the sources event
  gains `home`. `shadowed` false: the page has not said, for the real sources there are now,
  which of the phone's songs they hold (`PUT /local/phone/shadowed { all }`); the core asks
  nothing about any song until it has.
- The details and lyrics of the phone's songs (`phone-lookups.js`): the source's rules, a
  MusicBrainz text search, the Cover Art Archive and LRCLIB, through Kotlin: `{ t: 'net', id,
  service, url, kind }` out, `{ t: 'net-reply', id, status, retryAfter, json | cover | error }`
  back (`cover`: `{ coverId, small, large }`, base64 JPEGs Kotlin made). MusicBrainz and the
  Cover Art Archive once every 3 s each, LRCLIB 1.5 s between starts; only while the switch is
  on, never about a song a real source holds; a refusal with `error: 'metered'` pauses until the
  next `network` (`core.refresh()`).
- A start reads only the last line of the log; the whole log is read when a delta, a full answer,
  a feed batch or a lookup needs the tracks.

### The person's data on the phone (`phone-person.js`)

Where the person's data lives (`home`): the phone store (`0000`) while there is no real source,
and while a real principal exists but the store still holds data (the move is due); else the
principal. The phone store holds the profile's playlists, likes, plays and playlist covers in
`<statePath>.phone/person.log`, a source's person log byte for byte (`server/userlog.mjs`: the
header with `key` the profile id, the snapshot with its stamps, the epochs and versions, the
resolved changes, the compaction), and `person-covers/<coverId>.jpg` (the id a source gives the
picture). While it is the home it answers at `/s/0000/api/` the source's person routes
(`POST /api/playlists`, `PATCH` and `DELETE /api/playlists/<id>`, `POST` and `DELETE
/api/playlists/<id>/tracks`, `PUT` and `DELETE /api/likes/<id>` with `?brief=1`, `POST /api/likes
{ add, remove }`, `POST /api/played`, `GET /api/recents`, `PUT` and `DELETE
/api/cover-for/playlist/<id>?size=`) with the source's bodies, refusals, limits and
`X-MPfy-User-Version` / `X-MPfy-User-Epoch`, and the person part of Locale's `/api/library` with
its deltas. A start reads the log's header and its end only; the whole log is read, in slices, at
the first request that needs the person. `POST /local/phone/moved { to, uv, ue }` ends a move.

## Local HTTP API

Errors are JSON `{ error }` in Italian. The `/local/*` endpoints add a `code` the page maps to its
own words (and `triesLeft`, `retryAt` where the source gave them): `bad_request`, `bad_name`,
`bad_file`, `bad_code`, `bad_photo`, `source_code`, `profile_code`, `short_password`, `refused`,
`wrong_password`, `no_profile`, `no_photo`, `no_recovery`, `session_gone`, `profile_exists`, `locked`,
`unreachable`, `not_found`, `method_not_allowed`, `too_large`, `changed`, `failed`. The guards (Host, Origin,
token) answer without one. For a chat, `refused` is someone else's message and `not_found` a
conversation that is not known (nor the direct id of someone listed and not blocked).

| Request | Answer |
|---|---|
| `GET /local/sources` | `{ sources: [{ id, name, principal, connected, rttMs, throughputKbps, lastError, addedAt, role, named, profiles, social }] }`; `social` the social part the source speaks (1 or more), 0 or null as above; `role` `owner`, `member`, `guest` or null (a source without profiles, or not synced yet), `named` null when unknown; `profiles` true (the source has profiles), false (it has none: `role` stays null) or null (not synced yet). `profiles` turns true in the same change that sets `role` |
| `POST /local/sources` `{ code }` | `201 { source }` once the first sync is over (5 s at most: `role` and `profiles` may still be null; a source without profiles answers within that wait, so it already says `profiles: false`); `200 { source }` when that source was already there (pairing again is harmless). A source whose removal overlapped the pairing is added anew after that removal, paired again (`201`). The name is the source's own. Errors: 400 `bad_code`, `profile_code`; 504 `unreachable`; 403 `refused` |
| `GET /local/sources/<id>` | `{ source }` |
| `PATCH /local/sources/<id>` `{ principal: true }` | `{ source }`; anything else (a name) 400 |
| `DELETE /local/sources/<id>` | `{ ok: true, revoked }`: `revoked` says whether the source confirmed it forgot this device (it is asked first, 2 s at most) |
| `GET /local/profile` | `{ profile: null or { id, name, nameUpdatedAt, photo, pid }, recovery: bool, fileName }`; `photo` is the photo's SHA-256 (64 hex) or null; `pid` the profile ID (`"4BF2-ASGW"`) |
| `POST /local/profile` `{ name }` | `201 { profile }`; 409 `profile_exists`, 400 `bad_name` (1 to 40 characters) |
| `PATCH /local/profile` `{ name }` | `{ profile }` with a new `nameUpdatedAt`; 404 `no_profile`, 400 `bad_name` |
| `GET /local/profile/code` | `{ code: "MPFY-P-..." }`; 404 `no_profile` |
| `GET /local/profile/photo` | the JPEG (`image/jpeg`, `ETag: "<photo>"`, `Cache-Control: no-cache`, 304 on a matching `If-None-Match`); 404 `no_photo`, `no_profile`. The page loads it as `<img src="/local/profile/photo?v=<photo>">` |
| `PUT /local/profile/photo` with the JPEG's bytes, `Content-Type: image/jpeg` | `{ profile }` with the new `photo`; 400 `bad_photo` (another type, or not 1 to 48 KB starting FF D8 FF and ending FF D9), 413 `too_large`, 404 `no_profile`. Every source gets it at once |
| `DELETE /local/profile/photo` | `{ profile }` with `photo: null`; always a change with a newer time (also with no photo), so it wins over a photo set earlier on another device; 404 `no_profile` |
| `GET /local/profile/export` | `{ fileName, identity }`; 404 `no_profile` |
| `POST /local/profile/import` `{ identity }` or `{ code }` | `{ profile, sources }`; 409 `profile_exists`, 400 `bad_file`, `bad_code`, `source_code`. A file replaces the device key and the sources (the old key is forgotten on its sources first); a code brings the profile only |
| `PUT /local/profile/recovery` `{ password }` | `{ recovery: true, sources: { <id>: "ok" or "pending" } }`; 404 `no_profile`, 400 `short_password` |
| `DELETE /local/profile/recovery` | `{ recovery: false }` (each source deletes this device's blob at its next sync) |
| `POST /local/recovery` `{ code }` | `{ sessionId, source: { name }, entries: [{ profileId, name, device, deviceName }] }`; 409 `profile_exists`, 400 `bad_code`, `profile_code`, 403 `refused`, 504 `unreachable`. The session lasts 10 minutes |
| `POST /local/recovery/<session>` `{ profileId, device, password }` | `{ profile, sources }`; 403 `wrong_password` (`triesLeft`), 429 `locked` (`retryAt`), 404 `no_recovery` (also for parameters other than 3 and 64 MiB: Argon2id never runs), 404 `session_gone`, 504 `unreachable`, 500 `failed` |
| `DELETE /local/recovery/<session>` | `{ ok: true }`; the source forgets this device unless it is among its sources by now |
| `POST /local/sync` | `{ ok: true }` once the syncs are over, or after 10 s |
| `GET /local/people` | `{ supported, v, me, people }`: `supported` false (and `people` empty) with no profile or no social source; `v` the first 16 hex of the SHA-256 of the rest (unchanged `v`: nothing changed); `me` `{ id, pid, name, photo, tag }` (null with no profile); `people` `[{ id, pid, name, tag, photo, seen, blocked, chat, sources, now, last }]` by name, `seen` "all" (or "chat"), `blocked` whether you blocked them, `chat` the direct conversation id with you, `sources` the ids of the sources that list them, `now` `{ trackId, title, artist, album, at }` or null, `last` the same plus `artistPage`, or null; times in this device's clock |
| `GET /local/people/<profileId>` | `{ person, recent }`: the person as above and their recent plays (the union of every source's page: distinct tracks, newest first, at most 20, each with `artistPage`). Your own id: as the others see you, `chat` null, `hidden` true (no activity, `recent` empty) when no source shows you, false otherwise. 404 `not_found` when no source knows the person, 404 `no_profile` |
| `GET /local/people/<profileId>/photo?v=<photo>` | the JPEG of that person's card (your own photo for your id); with `v` equal to the card's photo `Cache-Control: private, max-age=31536000, immutable`, without `v` `no-cache`; `ETag: "<photo>"`, 304 on a match; 404 `no_photo` (none, `v` not the card's photo any more, or no source gave bytes that hash to it) |
| `GET /local/social` | `{ supported, privacy: { invisible, showNow, privateSession, privateUntil, showRecent, updatedAt }, blocked: [ids], mutes: { <conversation id>: until } }`; `privateSession` is `privateUntil` in the future |
| `PATCH /local/social` `{ invisible?, showNow?, privateSession?, showRecent? }` (booleans, at least one) | `{ privacy }` as above, `updatedAt` now; `privateSession: true` sets `privateUntil` to now + 6 h, false to 0; every connected social source gets it at once. 400 `bad_request` for anything else, 404 `no_profile` |
| `PUT /local/activity` `{ track: null or { trackId, title, artist?, album?, artistPage? }, playing }` | `{ ok: true }` at once (texts made one line and cut at 200 characters, `artistPage` passed on as it comes); sent as said in People. 400 `bad_request` (`trackId` not 24 hex, no title, `playing` not a boolean, a field besides these), 404 `no_profile` |
| `POST /local/social/blocked` `{ profileId }` | `{ blocked: [ids] }`; a new time, every social source told at once; 400 `bad_request` (not 32 hex, yourself, another field), 404 `no_profile` |
| `DELETE /local/social/blocked/<profileId>` | `{ blocked: [ids] }` |
| `GET /local/chat/conversations` | `{ supported, v, unread, conversations: [C] }`, newest first; `supported` false (empty) with no profile or no source at 2; `unread` the sum over the conversations not muted. `C` = `{ id, kind: "group" or "direct", with: profileId or null, name: the source's name or null, display, sources: [source ids], ids: [conversation ids], last: M or null, unread (at most 999), muted, mutedUntil: null, 0 (always) or ms, at }`; `display` the group's name, or the person's name followed by `" · "` and the tag when there is one. A direct conversation is listed once it has a message; blocked people never |
| `GET /local/chat/<cid>/messages?limit=<n>&before=<messageId>` | `{ v, messages: [M], more }`, oldest first: the newest `limit` (default 50, at most 200), or those just before `before`; `<cid>` any of the conversation's `ids`, or the direct id of someone listed (`chat` in `/local/people`). 404 `not_found`, `no_profile`, 400 `bad_request`. `M` = `{ id, from, name, mine, at, t: "text" or "card", text?, card?, reply?, state: "sent", "pending" or "failed", preview }`; `name` the sender's name and `" · "` tag; `preview` the text cut at 100 code points, or "Brano: <titolo>", "Album: <titolo>", "Playlist: <titolo>"; `reply` `{ id, from, text?, card?: { kind, id, title } }`, or `{ id, from, gone: true }` when the quoted message is known to be deleted for everyone (its words and its card leave with it) |
| `POST /local/chat/<cid>/messages` `{ id?, text?, card?, replyTo? }` | `201 { message: M }` within 4 s (`pending` while no source answered yet); the same `id` again: `200` with that message, nothing sent twice. `id` 32 hex (made here when absent); without `card`, `text` is the message (1 to 2,000 code points once cleaned); with `card`, `text` is the note (at most 300, made one line). `card`: `{ kind: "track", id: <24 hex>, title, sub }`, `{ kind: "album", id: <16 hex>, title, sub }` or `{ kind: "playlist", id: <playlistId>, title, n, sources?: [source ids where it lives], cover?: <coverId> }` (the core sets `sub` "", keeps of `sources` those that hold the conversation, the principal when none is named; no track list travels). `replyTo` a message id of that conversation. 400 `bad_request`, 404 `not_found` |
| `DELETE /local/chat/<cid>/messages/<id>` | `{ ok: true }`, gone here at once, sent to every source of the conversation (the outbox for those down); 403 `refused` for someone else's |
| `GET /local/chat/<cid>/messages/<id>/playlist` | `{ playlist: { id, name, n, trackIds, cover, updatedAt, live } }`: the playlist a card shares, read whole and as it is now from a source the card names that holds the conversation (`live` true); the last copy read in this run when none answers (`live` false); 404 `not_found` (no such card, or it is gone there) |
| `PUT /local/chat/<cid>/read` `{ id }` | `{ ok: true }`: the mark moves to that message when it is later, and the sources hear it now; a mark that does not move sends nothing. 404 `not_found` for a message not known here |
| `PUT /local/chat/<cid>/mute` `{ mute: "8h", "1w", "always" or "off" }` | `{ mutes }`: every id of the conversation until 8 hours or 7 days from now, 0 (always), or none; entries gone by are dropped; sealed and sent like the other settings |
| `GET /local/chat/shared` | `{ v, cards: [{ cid, messageId, from, at, card, note, unseen, muted }] }`: the newest card messages from others, one per (kind, id), at most 12, blocked people never; `unseen` after that conversation's read mark |
| (any `GET` above answered with a `v`) | `304` with no body when `If-None-Match` is that `v` in quotes: the page holds it already |
| `PUT /local/phone/shadowed` `{ all }` or `{ add, remove }` | `{ ok: true, shadowed: n }`: the phone's songs (24 hex ids) whose very same file a real source holds, the whole set or what moved; 400 `bad_request`; 404 without phone music |
| `POST /local/phone/moved` `{ to, uv, ue }` | `{ ok: true }`: the page copied the phone store's data to the principal `to` from its state at `(uv, ue)` (`userVersion` and `epochs.user` of `/s/0000/api/library?delta=1` read at the start of that copy); the store's log is kept aside as `person.log.moved-<ms>` (the newest only), the store is empty (version 0, the zero epoch) and the home is `to`. 409 `changed`: a change reached the store since `(uv, ue)` (copy again, then ask again); 404 `not_found`: `to` is not the principal; 400 `bad_request`; 404 without phone music |
| `/s/0000/<rest>` | "Locale", answered by the core (see Locale above) |
| `/s/<id>/<rest>` | forwarded to that source as `/<rest>`; 404 unknown source, 503 after 6 s when it is offline |
| `/__native/*` | 404 (those files live inside the app's WebView) |
| anything else | the UI's static files, SPA fallback to `index.html` |

`lastError` is a few Italian words or null ("spenta o senza rete", "collegamento interrotto",
"collegamento non riuscito"), never a code.

`throughputKbps` is the link's speed, measured on forwarded `GET /api/stream/...` responses only
(not on covers, the library or other small answers, which measure latency), and only while the
link is what limits them: while the local reader (a player whose buffer is full) holds a stream
back, nothing counts, and what waited in the local buffers is skipped when it reads again
(`meter.js`). It is null until about a second of such streaming has been measured, and after the
link dropped or the network changed.

Every connection carries one request: the answer ends with `Connection: close`.

Every answer of the core says that no other site may show it in a frame (`frame-ancestors
'none'` in its Content-Security-Policy, and `X-Frame-Options: DENY`): a page that framed the UI
could turn clicks on its own buttons into clicks on "Mostra codice" and "Copia". The app's
WebView loads the UI as its top page, so nothing of ours is affected.

The one origin is `http://127.0.0.1:<port>` (the CSRF guard accepts no other `Origin`). A request
whose `Host` is `localhost:<port>` or `[::1]:<port>` gets a `308` to the same target on that
origin, so a browser opened on `http://localhost:<port>/` ends up where its changes are accepted.
Any other `Host` is refused (403).

On Android the app passes `token`: `/local/*` and `/s/*` then want the cookie `mpfy_token` or the
header `X-MPfy-Token`, otherwise 403. Neither is ever forwarded to a source. The UI files stay open.

The app's own code goes through `/s/<id>/...` the same way, with `X-MPfy-Token` and no Origin
(each request gets the profile headers like the page's):
- the player and downloads: `GET /s/<id>/api/stream/<trackId>?q=<level>&f=<fileHash>`, with `Range`;
- the heart of the media notification and the car: `PUT /s/<principal>/api/likes/<id>` and
  `DELETE` the same, an empty body in any framing (`Content-Length: 0`, none, or chunked). The
  principal is the source with `principal: true` in the last `sources` event, which comes again
  whenever it changes, and that event's `connected` says when its link is up;
- the artwork provider (Android Auto, the lock screen, Bluetooth):
  `GET /s/<id>/api/cover/<coverId>?size=small|large`. The source's answer comes back raw, so its
  `ETag` is `"<coverId>.<size>"` for the sized image and `"<coverId>"` for the original it sends
  while that is not made yet.

## Modules it imports (for bare-pack)

Everything below is reached from `client-core/index.js`; nothing else.

| File | Imports |
|---|---|
| `client-core/index.js` | `#net`, `b4a`, `../transport/client.js`, `./http.js`, `./state.js`, `./identity.js`, `./people.js`, `./seal.js`, `./chat.js`, `./photo.js`, `./static.js`, `./meter.js`, `./forward.js`, `./phone.js`, `./phone-person.js` |
| `client-core/phone.js` | `#fs`, `#path`, `b4a`, `./state.js`, `./http.js`, `./identity.js`, `./phone-track.js`, `./phone-lookups.js`, `./phone-rules.js` |
| `client-core/phone-person.js` | `#fs`, `#path`, `b4a`, `./http.js`, `./identity.js`, `./phone-track.js`, `./userops.js` |
| `client-core/phone-track.js` | `b4a`, `sodium-native`, `./lrc.js`, `./phone-rules.js` |
| `client-core/phone-lookups.js` | `b4a`, `./lrc.js`, `./phone-rules.js` |
| `client-core/phone-rules.js` | `b4a`, `sodium-native`, `./versions.js` |
| `client-core/lrc.js`, `versions.js`, `userops.js` | nothing (byte-for-byte copies of `server/lrc.mjs`, `server/versions.mjs`, `web/js/userops.js`) |
| `client-core/chat.js` | `#fs`, `b4a`, `sodium-native`, `./http.js`, `./state.js`, `./seal.js`, `./people.js` |
| `client-core/http.js` | `b4a` |
| `client-core/state.js` | `#fs`, `#path`, `b4a`, `../transport/client.js`, `./identity.js` |
| `client-core/identity.js` | `sodium-native`, `b4a` |
| `client-core/photo.js` | `#fs`, `#path`, `b4a`, `sodium-native`, `./state.js` |
| `client-core/people.js` | `sodium-native`, `b4a`, `./identity.js` |
| `client-core/seal.js` | `sodium-native`, `b4a` |
| `client-core/static.js` | `#fs`, `#path` |
| `client-core/forward.js` | `./http.js` |
| `client-core/meter.js` | nothing |
| `transport/client.js` | `hyperdht`, `protomux`, `b4a`, `hypercore-crypto`, `#net`, `./emitter.js`, `./pipe.js`, `./stream.js`, `./control.js`, `./code.js` |
| `transport/stream.js` | `streamx`, `compact-encoding`, `./pipe.js` |
| `transport/pipe.js`, `transport/control.js` | `compact-encoding` |
| `transport/code.js` | `b4a`, `hypercore-crypto` |

Import maps (root `package.json`, `"bare"` listed first in each): `#net` -> `bare-tcp` / `net`,
`#fs` -> `bare-fs` / `fs`, `#path` -> `bare-path` / `path`. On Bare the module graph then
reaches these native addons (versions as installed in the root `node_modules`, every one with an
`android-arm64` prebuild):

| Addon | Reached through |
|---|---|
| `bare-tcp` 2.6.1 | `#net` |
| `bare-dns` 2.3.3 | `bare-tcp` |
| `bare-fs` 4.8.4 | `#fs` |
| `bare-path` 3.1.3 | `#path`, `bare-fs`, `bare-url` |
| `bare-url` 2.5.8 | `bare-fs` |
| `bare-buffer` 3.7.3 | `bare-url` |
| `udx-native` 1.22.1 | hyperdht (`dht-rpc`) |
| `sodium-native` 5.2.1 | `client-core/identity.js`, `photo.js`, `people.js`, `seal.js` and `chat.js` directly, hypercore-crypto and hyperdht (`sodium-universal`) |

plus plain JavaScript dependencies of those (`bare-stream`, `bare-events`, `fast-fifo`, `streamx`,
...). bare-link links every addon the graph reaches by itself; the list above is what to expect
in the output (`lib<name>.<version>.so`), and it changes with any `npm install` that moves a
version.

Globals used: timers, `queueMicrotask`, `Promise`, `JSON`, `Date`, `decodeURIComponent`,
`String.prototype.normalize` (the recovery password, NFC; names compared without accents, NFD),
and `Intl.Collator` only where the runtime has it (names compared at base strength; without it,
case and accents aside). Not used: `process`, `Buffer`, `URL`,
`TextEncoder`, `node:` modules. Import `client-core/index.js`,
never `transport/index.js` (it pulls in the server side).

## Notes for the worklet

- The DHT node is made by the core (one for every link and pairing) and destroyed by `stop()`.
- `start()` rejects with `.code === 'EADDRINUSE'` when the port is taken (another worklet still
  alive): nothing is left running in that case.
- An unreadable state file is renamed to `<statePath>.corrupt-<time>` and a new identity begins
  (the sources then have to be added again); a missing one is simply created.
- The state file is replaced atomically (temporary file, fsync, rename, directory fsync), and so
  is the profile photo's file next to it (`<statePath>.photo-<hash>.jpg`, at most 48 KB).
- Turning recovery on, or recovering on a new device, runs Argon2id with 64 MiB of memory
  (asynchronous, off the JavaScript thread: the local HTTP server keeps answering meanwhile).
- Paused in the background (Bare Kit suspend) the links stop; after resume call `refresh()` so a
  link that died meanwhile is noticed at once instead of after its keep-alive timeout.
