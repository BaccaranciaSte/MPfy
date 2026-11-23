#!/usr/bin/env node
// MPfy dev mock: emulates the CLIENT CORE with fake sources behind it, so every screen of the UI
// can be exercised without phones, P2P or a real server. No dependencies.
//
// It serves web/ (SPA fallback, the core's CSP) and implements:
//   /local/sources            GET (role, named, profiles), POST { code }, PATCH /:id { principal } (a name is
//                             refused), DELETE /:id
//   /local/profile...         the person: create, rename, the photo (GET, HEAD, PUT <JPEG>,
//                             DELETE /local/profile/photo, its hash in GET /local/profile), the
//                             profile ID (pid), code,
//                             export, import (file or code), password recovery on and off;
//                             /local/recovery... the way back with the password; /local/sync
//   /local/people...          the people of the social sources: the list ({ supported, v, me,
//                             people }), a person's page ({ person, recent }, yours as the others
//                             see you, hidden while invisible), their photo; /local/social (GET,
//                             PATCH the four switches), /local/activity (PUT, kept: your own page
//                             shows what the page reported); /local/sources entries carry social
//   /local/chat...            the chats (social 2), as the client core answers them: the
//                             conversations and a conversation's messages (newest, before=) with
//                             their v (304 when the page sends the v it holds, as the core), send (201,
//                             the same id again 200, pending while a slow source holds it,
//                             failed), delete your own, read marks, mutes, the shared cards, a
//                             shared playlist read whole (live, or the last copy read when its
//                             source is down; 404 when gone); /local/social/blocked (POST, DELETE)
//   /s/<id>/api/...           each fake source: the library (shared part and the caller's own,
//                             ?have=, you, source with details when the source says it), tracks with fileHash, codec, score, mine,
//                             others and fp signatures, raw fingerprints, stream with ?q= and &f=,
//                             covers, cover-for with the owner and member rules, profile, admin
//                             (source name, code, clients with profiles), uploads in one PUT or in
//                             resumable sessions, the "maybe" choice, archives (real ZIP files are
//                             read: stored and deflate entries), your plays (/api/recents, pages),
//                             and at social 3 the songs part: comments (GET ?tracks= with ETag
//                             and 304, POST one per author, DELETE by the author or the owner) and
//                             lyrics (GET with ETag and 304, PUT an .lrc or a text, ?beside=1,
//                             DELETE), the library's tracks carrying `lyrics`
// Two fake sources: "Mi A2" (principal, owned by this device's profile) and "VPS prova" (owned by
// someone else: this profile is a member there). Albums 7-9 are on both; 1-6 only on the Mi A2;
// 10-12 only on the VPS; album 1 is also on the VPS as different files (mp3 320 copies with their
// own fingerprints, a few items later): the app merges them by fingerprint.
// The profile code strangerProfileCode (in /__mock/state) brings a profile no source knows, so its
// name stays empty until the person types one.
// A POST with a code shaped like MPFY- plus 32 base32 characters pairs (again) a known source, or
// creates a new empty one owned by this profile and not named yet; a code of all zeros fails like
// an unreachable source.
//
// Uploads decide by name, so every outcome can be seen: a file named like a track already there
// is "already there"; "<title> [hq]" replaces it with a better version; "<title> [forse]" asks.
//
//   node web/dev/mock-server.mjs
//     MOCK_PORT          port on 127.0.0.1 (default 47123; 0 = a free one, printed as MOCK_PORT=<n>)
//     MOCK_DELAY         extra latency of JSON calls in ms (default 60), plus each source's RTT
//     MOCK_SOURCES       sources paired at start: 0 (welcome screen), 1 or 2 (default 2)
//     MOCK_PROFILE       1: this device has a profile (default when sources are paired), 0: none
//     MOCK_OFFLINE_WAIT  how long an offline source makes a request wait before the 503 (default
//                        1500 ms; the real core waits 6 s)
//     MOCK_PAIR_DELAY    how long a pairing takes (default 1200 ms)
//     MOCK_TRACKS        a big library: that many generated songs more on the Mi A2 (default 0),
//                        each its own recording (title, album of 12, artist of 5 albums, cover,
//                        signature, a tone and a fingerprint made when asked)
//     MOCK_LIKES         how many likes the person has (default MOCK_TRACKS, at most 100,000):
//                        the generated songs, then ids of songs no source has, up to 300,000
//     MOCK_PLAYLIST      the entries of the playlist "Lunga" made of them (default MOCK_TRACKS,
//                        at most 20,000; 0: none)
//     MOCK_CARD          the memory card of every source: found, use, moving, full, readonly,
//                        away, leaving, other, bad (default: none, no row)
//     MOCK_MIRROR        1: the VPS holds the same generated files (the same ids), as a copy;
//                        copies: the VPS holds other files of the same recordings (mp3 copies a
//                        few items later, their own ids), which the app joins by signature
//
// The library answers what moved since the versions an app holds: each source keeps, for its shared part and for each
// person, a version that moves by one per change (never behind the clock), the epochs of its runs
// with their ranges, a horizon, and per key the version of its last change. GET /api/library with
// delta=1 (or 2, which adds playlist edits) and have, he, uv, ue answers only what moved since
// those versions when it knows them, else the whole part; without delta, today's answer. Version
// headers on every change, ?brief=1 on likes, POST /api/likes for many at once. A change site that
// does not say what it changed is a reset: every app gets that whole part once.
//
// Dev helpers (not part of the real API):
//   GET /__mock/offline?source=<id>&on=1   that source goes offline (on=0: back); without
//                                          source=, every source
//   GET /__mock/source?source=<id>&rtt=40&kbps=900   its RTT and link throughput; also
//                                          legacy=1 (a source without profiles), sevenZip=0|1,
//                                          rar=0|1, role=owner|member, maxSessions=<n>,
//                                          pipelineMs=<n> (the import after the last byte),
//                                          extractMs=<n> (per archive entry), drop=<n> (the next
//                                          n chunk requests are cut halfway), fail=<n> (the next
//                                          n chunk requests answer 503), streamFail=1 (its streams
//                                          answer 500), streamStall=1 (they send headers, then
//                                          nothing), healthMs=<n> (its /api/health answers late),
//                                          details=1|0|none ("Cerca i dettagli in rete" on, off,
//                                          or a source that does not say, the default),
//                                          detailsFail=1 (a PATCH of it answers 500),
//                                          social=<0..3> (it speaks at most that much of the
//                                          social part; empty: as every source),
//                                          delta=0|1 (0: a source of before the delta answers:
//                                          no delta, no version headers, no brief, no bulk
//                                          likes), restart=1 (a new run: the next change opens a
//                                          new epoch, the old ones stay known), forget=1 (every
//                                          app gets the whole library and the whole user part),
//                                          card=<state> (its memory card, the states of MOCK_CARD)
//   GET /__mock/grow?source=<id>&tracks=<n>&likes=<n>&playlist=<n>&from=<k>   n generated songs
//                                          more there (from=<k>: start at the k-th generated
//                                          file; the same from on two sources gives both the
//                                          same files), likes and a playlist of them
//   GET /__mock/quality?on=1               the VPS's mp3 320 copies are measured cut at 17 kHz
//                                          (cutoffHz, equivKbps 128); on=0: not measured
//   GET /__mock/reset?sources=0|1|2&profile=0|1&phone=0|1   back to the sample data (phone=1:
//                                          the host has music of its own, "Locale", as MOCK_PHONE=1)
//   GET /__mock/phone?state=off|scanning|ready&retag=<k>&holdMoved=0|1   the phone's permission
//                                          and first scan; the k-th own song written again (its
//                                          `was`); POST /local/phone/moved held unanswered
//   GET /__mock/core?roleDelay=<ms>        a pairing whose first sync is slower than the core
//                                          waits: role null for that long; syncMs=<ms>: POST
//                                          /local/sync answers that late (a slow source);
//                                          photoFail=1: a PUT of the photo answers 503;
//                                          photoMs=<ms>: it answers that late; photoGone=1: the
//                                          photo's bytes answer 404 while the profile names it;
//                                          noProfiles=1: a core from before profiles (every
//                                          /local/profile... answers 404)
//   GET /__mock/recovery?expire=1          the next recovery attempt finds its session gone
//   GET /__mock/social?on=0|1              the sources speak the people part (1) or not (0); also
//                                          patchFail=<n> (the next n PATCH /local/social answer
//                                          503), peopleMs=<n> (/local/people answers late),
//                                          now=<profileId>&track=<album>,<track> (they play that
//                                          now), stop=<profileId> (they stop), recents=0|1 (the
//                                          principal answers /api/recents, or 404 as an older
//                                          one), history=<n>&step=<minutes> (n plays of yours,
//                                          one every step minutes back from now; midnight=1 adds
//                                          one right after today's midnight and one right before),
//                                          privateMs=<n> (a private session that ends in n ms),
//                                          crowd=<n> (n more people on the Mi A2, every third one
//                                          playing),
//                                          clear=1 (forgets the PATCHes and activity reports seen)
//   GET /__mock/chat?level=1|2|3           the sources speak the songs part too (3, the default),
//                                          hold chats only (2) or the people part only (1); also
//                                          say=<cid>&from=<profileId>&text=<t>
//                                          (or card=track|album|playlist) a message arrives now;
//                                          bulk=<cid>&n=<k> k older messages (one a minute, two
//                                          senders); unread=<cid> its read mark back to nothing;
//                                          postMs=<n> (a send answers pending after 4 s, sent after
//                                          n ms), failNext=<n> (the next n sends fail),
//                                          playlistDown=1 (no source of a shared playlist answers:
//                                          the last copy read, live false, else 404),
//                                          clear=1 (forgets the sends, reads and deletes seen),
//                                          unquote=<cid> (the message the newest reply there
//                                          quotes is deleted for everyone by its sender)
//   GET /__mock/songs                      the songs part: clear=1 (forgets the requests seen),
//                                          failPosts=<n> (the next n comment POSTs answer 500),
//                                          getMs=<n> (comment GETs answer that late), postMs=<n>
//                                          (comment POSTs too),
//                                          invisible=<profileId,...> (their comments hidden from
//                                          the others), say=<trackId>&source=<id>&from=<profileId>
//                                          &text=<t> (a comment now), many=<trackId>&source=<id>
//                                          &n=<k> (k comments of k people), lyrics=<trackId>
//                                          &source=<id>&kind=synced|plain|instrumental|none
//   GET /__mock/state                      a summary as JSON

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { rebaseOrder, removalSlots } from '../js/userops.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const PORT = Number(process.env.MOCK_PORT ?? 47123);
const DELAY = Number(process.env.MOCK_DELAY ?? 60);
const START_SOURCES = Number(process.env.MOCK_SOURCES ?? 2);
const START_PROFILE = process.env.MOCK_PROFILE == null ? START_SOURCES > 0 : process.env.MOCK_PROFILE === '1';
const OFFLINE_WAIT = Number(process.env.MOCK_OFFLINE_WAIT ?? 1500);
const PAIR_DELAY = Number(process.env.MOCK_PAIR_DELAY ?? 1200);
const BIG_TRACKS = Math.max(0, Number(process.env.MOCK_TRACKS) || 0);
const BIG_LIKES = Math.min(300000, Math.max(0, Number(process.env.MOCK_LIKES ?? Math.min(BIG_TRACKS, 100000)) || 0));
const BIG_PLAYLIST = Math.min(20000, Math.max(0, Number(process.env.MOCK_PLAYLIST ?? BIG_TRACKS) || 0));
const BIG_MIRROR = process.env.MOCK_MIRROR || '';
// MOCK_PHONE=1: the host has music of its own ("Locale", the core's virtual source 0000): 300
// songs, 20 of them the very files of the Mi A2, lyrics on some, art on most, and the phone's own
// store of the person's data while no real source holds it (/__mock/phone and reset?phone=).
const PHONE_ID = '0000';
const START_PHONE = process.env.MOCK_PHONE === '1';
let phoneOn = START_PHONE;
const MAX_LIKES = 100000;
const BULK_LIKES = 5000;
const MAX_UPLOAD = 600 * 1024 * 1024;
const MAX_ARCHIVE = 4 * 1024 * 1024 * 1024;
const KEEP_UPLOAD_BYTES = 200 * 1024 * 1024; // bigger uploads are accepted but streamed as a tone
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const SR = 11025; // sample rate of the generated tones (mono, 16 bit)
const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'";
let actualPort = PORT;


// ---------------------------------------------------------------------------------------------
// helpers

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sha24 = (data) => sha(data).slice(0, 24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 64 over UTF-8, the same derived ids the UI computes (so recents can point at albums).
function fnv64(str) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(str, 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Crockford base32, the alphabet of the permanent codes.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeCode(seedText) {
  const bytes = crypto.createHash('sha256').update(seedText).digest();
  let out = '';
  for (let i = 0; i < 32; i++) out += B32[bytes[i] & 31];
  return out;
}
const showCode = (body) => `MPFY-${body.match(/.{4}/g).join('-')}`;
function parseCode(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const m = /^MPFY([0-9A-HJKMNP-TV-Z]{32})$/.exec(s);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// PNG covers (tiny encoder: RGB, filter 0, zlib)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An S x S cover: diagonal gradient, a "moon", three wave lines, darker sea below. */
function makeCover(c1, c2, seed, S = 300) {
  const rnd = mulberry32(seed);
  const mx = S * (0.25 + rnd() * 0.5);
  const my = S * (0.18 + rnd() * 0.22);
  const mr = S * (0.07 + rnd() * 0.07);
  const amp = S * (0.025 + rnd() * 0.035);
  const freq = 1 + rnd() * 1.8;
  const sea = S * (0.56 + rnd() * 0.14);
  const light = c2.map((v) => Math.min(255, v + 70));
  const raw = Buffer.alloc((S * 3 + 1) * S);
  let o = 0;
  for (let y = 0; y < S; y++) {
    raw[o++] = 0;
    for (let x = 0; x < S; x++) {
      const t = (x * 0.6 + y) / (1.6 * S);
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;
      const dx = x - mx;
      const dy = y - my;
      if (dx * dx + dy * dy < mr * mr) {
        r = r * 0.15 + light[0] * 0.85;
        g = g * 0.15 + light[1] * 0.85;
        b = b * 0.15 + light[2] * 0.85;
      }
      const wave = sea + Math.sin((x / S) * Math.PI * 2 * freq) * amp;
      if (y > wave) {
        r *= 0.72;
        g *= 0.72;
        b *= 0.72;
      }
      for (let k = 0; k < 3; k++) {
        const yk = wave + k * S * 0.08 + Math.sin((x / S) * Math.PI * 2 * freq + k * 1.3) * amp * 0.5;
        if (Math.abs(y - yk) < S * 0.008) {
          r = r * 0.5 + light[0] * 0.5;
          g = g * 0.5 + light[1] * 0.5;
          b = b * 0.5 + light[2] * 0.5;
        }
      }
      raw[o++] = Math.max(0, Math.min(255, r | 0));
      raw[o++] = Math.max(0, Math.min(255, g | 0));
      raw[o++] = Math.max(0, Math.min(255, b | 0));
    }
  }
  return encodePng(S, S, raw);
}

// ---------------------------------------------------------------------------------------------
// sample data: 8 artists, 12 albums, 60 tracks (made up names)

const CATALOG = [
  { artist: 'Lumen Marino', album: 'Fari nella nebbia', year: 2019, c: [[14, 48, 84], [30, 160, 170]], titles: ['Luce di posizione', 'Il guardiano del faro', 'Nebbia', 'Segnali lontani', 'Approdo'] },
  { artist: 'Lumen Marino', album: 'Città di sale', year: 2022, c: [[150, 64, 40], [240, 196, 140]], titles: ['Città di sale', 'Saline', 'Vento di terra', 'Ultimo traghetto', 'Mareggiata'] },
  { artist: 'Orsa Minore', album: 'Costellazioni', year: 2018, c: [[28, 20, 70], [110, 70, 170]], titles: ['Stella polare', 'Cassiopea', 'Via Lattea', 'Notte di San Lorenzo', 'Orione'] },
  { artist: 'Orsa Minore', album: 'Perché il mare', year: 2023, c: [[0, 90, 120], [90, 210, 220]], titles: ['Perché il mare', 'Sale sulla pelle', 'Onde corte (feat. Clara Vento)', 'Una canzone dal titolo davvero molto lungo per provare i puntini di sospensione', 'Risacca'] },
  { artist: 'Clara Vento', album: 'Ritorni', year: 2020, c: [[170, 110, 20], [250, 220, 120]], titles: ['Ritorno a casa', 'Finestre accese', 'Caffè alle sei', 'Binario tre', 'Domenica'] },
  { artist: 'I Pescatori di Perle', album: 'Notturno blu', year: 2017, c: [[8, 24, 60], [40, 80, 160]], titles: ['Notturno blu', 'Lanterne', 'Reti al buio', 'Il molo', 'Alba lenta'] },
  { artist: 'I Pescatori di Perle', album: 'Così lontano', year: 2021, c: [[120, 18, 40], [230, 90, 90]], titles: ['Così lontano', 'Rotta a sud', 'Isole', 'Correnti', 'Bussola'] },
  { artist: 'Delta Nadir', album: 'Frequenze', year: 2024, c: [[60, 10, 80], [220, 60, 170]], titles: ['Frequenze', 'Onda quadra', 'Rumore bianco', 'Sintonia', 'Fuori banda'] },
  { artist: 'Gli Scogli', album: 'Bassa marea', year: 2016, c: [[50, 70, 20], [160, 190, 80]], titles: ['Bassa marea', 'Granchi', 'Conchiglie', "Pomeriggio d'agosto", 'Scirocco'] },
  { artist: 'Gli Scogli', album: 'Àncora', year: 2020, c: [[40, 46, 56], [130, 140, 160]], titles: ['Àncora', 'Catene', 'Fondale', 'Boa', 'Gomene'] },
  { artist: 'Maestrale', album: 'Rotte', year: 2019, c: [[10, 60, 110], [120, 180, 240]], titles: ['Maestrale', 'Libeccio', 'Tramontana', 'Grecale', 'Ponente'] },
  { artist: 'Elena Sirti', album: 'Già domani', year: 2025, c: [[160, 40, 90], [250, 170, 190]], titles: ['Già domani', 'Più piano', 'Corallo', 'Canto del mare', 'È tardi'] },
];
const MI_A2_ALBUMS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const VPS_ALBUMS = [6, 7, 8, 9, 10, 11];

const SCALES = [
  [0, 3, 5, 7, 10, 12, 10, 7],
  [0, 2, 4, 7, 9, 12, 9, 7],
  [0, 5, 7, 12, 7, 5, 3, 5],
  [0, 4, 7, 11, 12, 11, 7, 4],
];

const covers = new Map(); // coverId -> { buf, mime, gen?: { c1, c2, seed }, sized: {} }
const audio = new Map(); // trackId -> { kind: 'tone', gen } | { kind: 'bytes', buf }
const CLIENT_KEY = sha('mpfy-mock-client-this-device');
const ME_ID = '22de25661c578b57b919dfcada067bd4'; // this device's person ("Bacca")
const SIS_ID = 'a7c1e0d2b3f4051627384950a1b2c3d4'; // someone else ("Giulia"), owner of the VPS
const PASSWORD = 'una frase breve';
const ITEM_S = 0.12381;
let catalog = []; // every sample track, built once per reset
let servers = new Map(); // id -> fake source
let paired = []; // the client core's state: [{ id, principal, addedAt }]
let phone = null; // "Locale" (MOCK_PHONE=1), never in `servers` nor in `paired`
let epoch = 0; // bumped by every reset: a library rebuilt from the sample (new playlist ids) never
// gets the ETag of the one before it, as a real source's never would
const fps = new Map(); // fileHash -> Uint32Array (raw fingerprint items)
// The client core's own state: its profile, recovery, and the knobs of the dev helpers.
const device = { profile: null, secret: null, recovery: false, recoveryUpdatedAt: 0, roleDelay: 0, syncMs: 0, recoverySessions: new Map(), expireNext: false, photo: null, photoFail: false, photoMs: 0, photoPuts: 0, photoGone: false, noProfiles: false };
const STRANGER_ID = '5e1f00d2c0ffee5e1f00d2c0ffee5e1f'; // a person no source has heard of

function toneGen(seed, duration) {
  const rnd = mulberry32(seed * 7919 + 13);
  const base = 174 + Math.floor(rnd() * 10) * 18;
  const scale = SCALES[seed % SCALES.length];
  return {
    duration,
    samples: Math.round(duration * SR),
    noteLen: 0.32 + rnd() * 0.2,
    freqs: scale.map((s) => base * 2 ** (s / 12)),
    drone: base / 2,
  };
}

/**
 * Raw fingerprint items of a recording: one u32 every 0.12381 s of the first 120 s. A copy of the
 * same recording (another file) starts `shift` items later and has a few bits flipped.
 */
function rawFp(rec, duration, { shift = 0, noise = 0, seed = 0 } = {}) {
  const n = Math.max(16, Math.floor(Math.min(120, duration) / ITEM_S));
  const rnd = mulberry32(rec * 104729 + 17);
  const base = Array.from({ length: n }, () => (rnd() * 4294967296) >>> 0);
  const flip = mulberry32(seed * 31 + 5);
  const out = new Uint32Array(n);
  for (let j = 0; j < n; j++) {
    let v = j >= shift ? base[j - shift] : (flip() * 4294967296) >>> 0;
    if (noise) for (let b = 0; b < 32; b++) if (flip() < noise) v ^= 1 << b;
    out[j] = v >>> 0;
  }
  return out;
}

const u32b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

/** The signature a source puts in the library: 64 consecutive items from about 4 s in. */
function signature(raw, duration) {
  const b = Math.min(32, Math.max(0, raw.length - 64));
  return { d: Math.round(duration * 10) / 10, b, s: u32b64(raw.slice(b, b + 64)) };
}

const FACTOR = { mp3: 1, aac: 1.3, vorbis: 1.3, opus: 1.6 };
function scoreOf(t) {
  if (t.fakeLossless === true) return t.equivKbps || 0;
  if (t.lossless) return 1000000 + (t.bitDepth || 16) * 1000 + Math.round((t.sampleRate || 44100) / 100);
  if (t.equivKbps > 0) return t.equivKbps; // measured lower than its bitrate: its class, as an mp3
  const kbps = t.bitrate ? t.bitrate / 1000 : t.size && t.duration ? (t.size * 8) / t.duration / 1000 : 0;
  return kbps * (FACTOR[t.codec] || 1);
}

function buildCatalog() {
  bigCovers = null;
  covers.clear();
  audio.clear();
  fps.clear();
  const tracks = [];
  const now = Date.now();
  const DAY = 86400000;
  CATALOG.forEach((a, ai) => {
    const png = makeCover(a.c[0], a.c[1], ai + 1);
    const coverId = sha24(png);
    covers.set(coverId, { buf: png, mime: 'image/png', gen: { c1: a.c[0], c2: a.c[1], seed: ai + 1 }, sized: {} });
    const rnd = mulberry32(1000 + ai);
    a.titles.forEach((title, ti) => {
      const seed = ai * 10 + ti;
      const duration = Math.round((140 + rnd() * 170) * 10) / 10;
      const id = sha24(`mpfy-mock-track-${seed}`);
      const gen = toneGen(seed, duration);
      audio.set(id, { kind: 'tone', gen });
      const raw = rawFp(seed, duration);
      fps.set(id, raw);
      // 16 bit mono WAV at 11025 Hz is 176 kbps: Opus 160 would save under 10%, so "high" is
      // never made; album 4 has no transcodes yet at all.
      const ready = ai !== 3;
      const t = {
        ai,
        rec: seed,
        id,
        fileHash: id,
        title,
        artist: a.artist,
        album: a.album,
        albumArtist: a.artist,
        trackNo: ti + 1,
        discNo: 1,
        year: a.year,
        duration,
        format: 'wav',
        mime: 'audio/wav',
        codec: 'wav',
        sampleRate: SR,
        bitDepth: 16,
        fakeLossless: false,
        equivKbps: null,
        size: 44 + gen.samples * 2,
        bitrate: SR * 16,
        lossless: true,
        addedAt: now - (CATALOG.length - ai) * 4 * DAY + ti * 60000,
        coverId,
        qualities: { low: ready, normal: ready, high: false },
        fp: signature(raw, duration),
      };
      t.score = scoreOf(t);
      tracks.push(t);
    });
  });
  catalog = tracks;
}

// A big library on demand: generated songs, each its own recording. Their tone and their raw
// fingerprint are made when asked (nothing per song is kept but the track), so 100,000 of them
// cost about what their library answer weighs.
const WORDS = ['Vento', 'Mare', 'Luce', 'Notte', 'Strada', 'Faro', 'Onda', 'Sale', 'Riva', 'Stella', 'Nebbia', 'Porto', 'Rotta', 'Vela', 'Corrente', 'Sabbia', 'Sole', 'Pioggia', 'Neve', 'Fiume', 'Bosco', 'Collina', 'Lampo', 'Brezza'];
let bigCovers = null;
function bigCover(k) {
  if (!bigCovers) {
    bigCovers = Array.from({ length: 24 }, (_, i) => {
      const c1 = [40 + ((i * 53) % 160), 30 + ((i * 97) % 150), 60 + ((i * 31) % 170)];
      const c2 = [200 - ((i * 41) % 120), 180 - ((i * 67) % 110), 220 - ((i * 29) % 140)];
      const png = makeCover(c1, c2, 500 + i);
      const id = sha24(png);
      covers.set(id, { buf: png, mime: 'image/png', gen: { c1, c2, seed: 500 + i }, sized: {} });
      return id;
    });
  }
  return bigCovers[k % bigCovers.length];
}

/** The k-th generated song (the same k on two sources is the same file; copy: another file of it). */
function bigTrack(k, uploaders, copy = false) {
  const rec = 100000 + k;
  const shift = copy ? 2 : 0;
  const duration = Math.round(1200 + ((k * 7919) % 2400) + (copy ? Math.round(shift * ITEM_S * 10) : 0)) / 10;
  const id = sha24(copy ? `mpfy-mock-bigcopy-${k}` : `mpfy-mock-big-${k}`);
  const al = Math.floor(k / 12);
  const ar = Math.floor(al / 5);
  const w = (i) => WORDS[i % WORDS.length];
  // The signature is items 32 to 95 of the recording: 96 items of it are enough.
  const fp = signature(rawFp(rec, 12, copy ? { shift, noise: 0.03, seed: rec + 1 } : {}), duration);
  const t = {
    big: true,
    rec,
    id,
    fileHash: id,
    title: `${w(k * 7)} ${w(k * 11 + 3).toLowerCase()} ${k + 1}`,
    artist: `${w(ar * 5)} ${w(ar * 13 + 1)} ${ar + 1}`,
    album: `${w(al * 3)} e ${w(al * 17 + 5).toLowerCase()} ${al + 1}`,
    albumArtist: `${w(ar * 5)} ${w(ar * 13 + 1)} ${ar + 1}`,
    trackNo: (k % 12) + 1,
    discNo: 1,
    year: 1970 + (al % 55),
    duration,
    format: 'mp3',
    mime: 'audio/mpeg',
    codec: 'mp3',
    sampleRate: 44100,
    bitDepth: null,
    fakeLossless: null,
    equivKbps: null,
    size: Math.round(duration * 40000),
    bitrate: 320000,
    lossless: false,
    addedAt: Date.now() - 86400000 - k * 60000,
    coverId: bigCover(al),
    qualities: { low: true, normal: true, high: true },
    fp,
    uploaders,
  };
  t.score = scoreOf(t);
  return t;
}

/**
 * n generated songs more on srv (from the from-th one, by default after the ones it has), and
 * of them: likes (the newest the first generated) and a playlist "Lunga" of `playlist` entries,
 * for person (the source's owner by default). Returns how many generated songs it holds.
 */
function grow(srv, n, { from, likes = 0, playlist = 0, person, copies = false } = {}) {
  const start = from ?? srv.grown;
  const who = person || srv.ownerProfileId || actor();
  const have = new Set(srv.db.tracks.map((t) => t.id));
  const made = [];
  for (let k = start; k < start + n; k++) {
    const t = bigTrack(k, [who], copies);
    if (have.has(t.id)) continue;
    srv.db.tracks.push(t);
    made.push(t.id);
  }
  srv.grown = Math.max(srv.grown, start + n);
  if (made.length) changedShared(srv, { tracks: made });
  const u = userOf(srv, who);
  if (likes) {
    const now = Date.now();
    const ids = made.slice(0, likes);
    for (let k = 0; ids.length < likes; k++) ids.push(sha24(`mpfy-mock-elsewhere-${k}`));
    const set = new Set(ids);
    u.likes = [...ids.map((id, i) => ({ id, at: now - 60000 - i * 1000 })), ...u.likes.filter((l) => !set.has(l.id))];
    changedUser(srv, u, { liked: ids });
  }
  if (playlist && made.length) {
    const p = pl('Lunga', 'Una playlist molto lunga', Array.from({ length: playlist }, (_, i) => made[i % made.length]), 1);
    u.playlists.push(p);
    changedUser(srv, u, { playlists: [p.id] });
  }
  return srv.grown;
}

/** The mp3 320 copy of a recording on another source: another file, its own id, a few items later. */
function copyOf(t, shift = 3) {
  const id = sha24(`mpfy-mock-copy-${t.rec}`);
  const raw = rawFp(t.rec, t.duration, { shift, noise: 0.03, seed: t.rec + 1 });
  fps.set(id, raw);
  audio.set(id, audio.get(t.id));
  const duration = Math.round((t.duration + shift * ITEM_S) * 10) / 10;
  const c = { ...t, id, fileHash: id, duration, format: 'mp3', mime: 'audio/mpeg', codec: 'mp3', sampleRate: 44100, bitDepth: null, bitrate: 320000, lossless: false, fakeLossless: null, size: Math.round(duration * 40000), addedAt: t.addedAt + 86400000, fp: signature(raw, duration), qualities: { low: true, normal: true, high: true } };
  c.score = scoreOf(c);
  return c;
}

/** The k-th song of the phone's own music: its own file, no signature (the phone makes none). */
function localTrack(k) {
  const w = (i) => WORDS[i % WORDS.length];
  const al = Math.floor(k / 10);
  const ar = Math.floor(al / 4);
  const duration = Math.round(1500 + ((k * 4507) % 2100)) / 10;
  const id = sha24(`mpfy-mock-local-${k}`);
  const t = {
    big: true,
    rec: 200000 + k,
    id,
    fileHash: id,
    title: `${w(k * 5 + 2)} di ${w(k * 3 + 7).toLowerCase()} ${k + 1}`,
    artist: `Gruppo ${w(ar * 7 + 4)} ${ar + 1}`,
    album: `Raccolta ${w(al * 11 + 2).toLowerCase()} ${al + 1}`,
    albumArtist: `Gruppo ${w(ar * 7 + 4)} ${ar + 1}`,
    trackNo: (k % 10) + 1,
    discNo: 1,
    year: 1990 + (al % 30),
    duration,
    format: 'mp3',
    mime: 'audio/mpeg',
    codec: 'mp3',
    sampleRate: 44100,
    bitDepth: null,
    fakeLossless: null,
    equivKbps: null,
    size: Math.round(duration * 40000),
    bitrate: 320000,
    lossless: false,
    addedAt: Date.now() - 2 * 86400000 - k * 60000,
    coverId: k % 10 === 9 ? null : bigCover(1000 + al),
    qualities: { low: false, normal: false, high: false },
    uploaders: [],
  };
  t.score = scoreOf(t);
  return t;
}

/** "Locale": the phone's own music as the core serves it, and the phone's store of the person's data (empty). */
function makePhone(mi) {
  const srv = makeServer({ seed: 9, name: 'Locale', albums: [], rttMs: 0, linkKbps: 0, diskFreeBytes: 0, owner: null });
  Object.assign(srv, { id: PHONE_ID, phone: true, socialMax: 0, clients: [], recovery: new Map(), details: true, state: 'ready', holds: false, shadow: { key: null, ids: new Set(), puts: [] }, moved: [], lyrics: new Map() });
  // The very files of the Mi A2 (the same ids), as the phone reads them: no signature, the original.
  // From the third album on: the first two are the ones the gesture checks download and edit.
  const same = mi.db.tracks.filter((t) => !t.big && t.fileHash === t.id && t.ai >= 2).slice(0, 20).map(({ fp, ...t }) => ({ ...t, qualities: { low: false, normal: false, high: false }, uploaders: [] }));
  srv.all = [...same, ...Array.from({ length: 280 }, (_, k) => localTrack(k))];
  srv.db.tracks = srv.all.slice();
  srv.all.forEach((t, i) => {
    if (i % 7 === 3) srv.lyrics.set(t.id, { kind: 'synced', lines: [{ t: 0, text: 'Prima riga di prova' }, { t: 4000, text: 'Seconda riga di prova' }, { t: 8000, text: 'Terza riga di prova' }], from: 'tag' });
    else if (i % 11 === 5) srv.lyrics.set(t.id, { kind: 'plain', text: 'Un testo di prova\nsenza tempi', from: 'tag' });
  });
  return srv;
}

/** The real principal the core keeps, or null. */
const realPrincipal = () => paired.find((p) => p.principal) || paired[0] || null;
/** Where the person's data lives: the phone's store with no real source, or while it holds data; else the principal. */
const phoneHome = () => {
  const p = realPrincipal();
  return !p || phone.holds ? PHONE_ID : p.id;
};
const realKey = () => paired.map((p) => p.id).sort().join(',');
function phoneEntry() {
  const u = userOf(phone);
  return { id: PHONE_ID, name: 'Locale', state: phone.state, tracks: phone.db.tracks.length, v: `${phone.db.version}.${u.userVersion}`, home: phoneHome() === PHONE_ID, details: phone.details, shadowed: !paired.length || phone.shadow.key === realKey() };
}

const T = (ai, ti) => catalog[ai * 5 + ti].id;
const albumId = (ai) => fnv64(`${CATALOG[ai].artist}\u0000${CATALOG[ai].album}`);
const artistId = (ai) => fnv64(CATALOG[ai].artist);
const albumIdOf = (t) => fnv64(`${t.albumArtist || t.artist || ''}\u0000${t.album || ''}`);

function pl(name, description, trackIds, ageDays) {
  const now = Date.now();
  return { id: crypto.randomBytes(8).toString('hex'), name, description, trackIds, createdAt: now - ageDays * 86400000, updatedAt: now - ageDays * 86400000 + 3600000 };
}

const emptyUser = () => ({ userVersion: Date.now(), playlists: [], likes: [], recents: [], covers: { playlist: {} } });

function makeServer({ seed, name, albums, rttMs, linkKbps, diskFreeBytes, owner = ME_ID, named = true, uploaders = () => [owner] }) {
  const publicKey = sha(`mpfy-mock-server-${seed}`);
  const now = Date.now();
  const tracks = catalog.filter((t) => albums.includes(t.ai)).map((t) => ({ ...t, qualities: { ...t.qualities }, uploaders: uploaders(t) }));
  return {
    id: publicKey.slice(0, 8),
    publicKey,
    name,
    named,
    code: makeCode(`mpfy-mock-code-${seed}`),
    db: { version: now, tracks, covers: { track: {}, album: {} } },
    users: new Map(),
    profiles: new Map([
      [ME_ID, { name: 'Bacca', nameUpdatedAt: now - 86400000 }],
      [SIS_ID, { name: 'Giulia', nameUpdatedAt: now - 86400000 }],
    ]),
    ownerProfileId: owner,
    legacy: false,
    oldLibrary: false, // true: answers as a source of before the delta answers
    lib: sharedLog(now),
    grown: 0,
    archives: { zip: true, sevenZip: true, rar: true },
    connected: true,
    rttMs,
    linkKbps,
    throughputKbps: null, // measured once something streams from it
    diskFreeBytes,
    clients: [
      { publicKey: CLIENT_KEY, name: 'PC', addedAt: now - 3 * 86400000, connected: true, profileId: ME_ID, legacy: true },
      { publicKey: sha(`mpfy-mock-phone-${seed}`), name: 'REDMAGIC 11 Pro', addedAt: now - 21 * 86400000, connected: seed === 1, profileId: ME_ID, legacy: true },
      { publicKey: sha(`mpfy-mock-sis-${seed}`), name: 'Pixel di Giulia', addedAt: now - 9 * 86400000, connected: false, profileId: SIS_ID, legacy: false },
      { publicKey: sha(`mpfy-mock-tablet-${seed}`), name: 'Tablet', addedAt: now - 2 * 86400000, connected: false, profileId: null, legacy: false },
    ],
    // Recovery blobs: per profile, per device.
    recovery: new Map([
      [ME_ID, { devices: { [sha(`mpfy-mock-phone-${seed}`)]: { deviceName: 'REDMAGIC 11 Pro', updatedAt: now - 5 * 86400000 }, [sha(`mpfy-mock-desk-${seed}`)]: { deviceName: 'PC di casa', updatedAt: now - 6 * 86400000 } }, failures: [], lockedUntil: 0, locks: 0 }],
      [SIS_ID, { devices: { [sha(`mpfy-mock-sis-${seed}`)]: { deviceName: 'Pixel di Giulia', updatedAt: now - 4 * 86400000 } }, failures: [], lockedUntil: 0, locks: 0 }],
    ]),
    sessions: new Map(),
    pending: new Map(),
    archivesSt: new Map(),
    maxSessions: 4,
    pipelineMs: 0,
    extractMs: 150,
    drop: 0,
    fail: 0,
  };
}

/** The person acting on a source: this device's profile, or "owner" (a device from before profiles). */
const actor = () => device.profile?.id || 'owner';

function roleOn(srv) {
  if (srv.legacy) return null;
  const a = actor();
  if (a === 'owner') return 'owner';
  return srv.ownerProfileId === a ? 'owner' : 'member';
}

function userOf(srv, pid = actor()) {
  if (!srv.users.has(pid)) srv.users.set(pid, emptyUser());
  return srv.users.get(pid);
}

/**
 * This device's profile reaches a source: bound to it (a legacy key of a source with no owner
 * claims it: "owner" data and uploads become the profile's).
 */
function bind(srv) {
  const p = device.profile;
  if (!p || srv.legacy) return;
  if (!srv.profiles.has(p.id)) srv.profiles.set(p.id, { name: '', nameUpdatedAt: 0 });
  const me = srv.clients.find((c) => c.publicKey === CLIENT_KEY);
  if (me && !me.profileId) me.profileId = p.id;
  if (!srv.ownerProfileId && me?.legacy) {
    srv.ownerProfileId = p.id;
    if (srv.users.has('owner')) {
      srv.users.set(p.id, srv.users.get('owner'));
      srv.users.delete('owner');
      changedUser(srv, srv.users.get(p.id)); // a merge: every app takes this person's whole part
    }
    for (const t of srv.db.tracks) t.uploaders = t.uploaders.map((u) => (u === 'owner' ? p.id : u));
    changedShared(srv); // the owner changed: a reset
  }
  // The name: the newest wins, an empty one is never taken.
  const rec = srv.profiles.get(p.id);
  if (p.name && (!rec.name || rec.nameUpdatedAt < p.nameUpdatedAt)) Object.assign(rec, { name: p.name, nameUpdatedAt: p.nameUpdatedAt });
  else if (rec.name && !p.name) Object.assign(p, { name: rec.name, nameUpdatedAt: rec.nameUpdatedAt });
}

function buildSample(nPaired = START_SOURCES, withProfile = START_PROFILE, withPhone = phoneOn) {
  epoch++;
  phoneOn = withPhone;
  buildCatalog();
  servers = new Map();
  device.profile = withProfile ? { id: ME_ID, name: 'Bacca', nameUpdatedAt: Date.now() - 86400000 } : null;
  device.secret = crypto.randomBytes(32).toString('hex');
  device.recovery = false;
  device.recoverySessions = new Map();
  device.expireNext = false;
  device.roleDelay = 0;
  device.syncMs = 0;
  device.photo = null;
  device.photoFail = false;
  device.photoMs = 0;
  device.photoPuts = 0;
  device.photoGone = false;
  device.noProfiles = false;
  const vpsUploaders = (t) => (t.ai === 7 ? [SIS_ID, ME_ID] : t.ai === 10 ? [ME_ID] : [SIS_ID]);
  const mi = makeServer({ seed: 1, name: 'Mi A2', albums: MI_A2_ALBUMS, rttMs: 120, linkKbps: 2400, diskFreeBytes: Math.round(18.4 * 1024 ** 3), owner: withProfile ? ME_ID : null, uploaders: () => [withProfile ? ME_ID : 'owner'] });
  const vps = makeServer({ seed: 2, name: 'VPS prova', albums: VPS_ALBUMS, rttMs: 45, linkKbps: 9000, diskFreeBytes: Math.round(61.2 * 1024 ** 3), owner: SIS_ID, uploaders: vpsUploaders });
  // Album 1 also on the VPS, as other files (mp3 320) uploaded by this person.
  for (const t of catalog.filter((x) => x.ai === 0)) vps.db.tracks.push({ ...copyOf(t), uploaders: [ME_ID] });
  // One track of the Mi A2 was replaced by a better file: its fileHash is no longer its id.
  const re = mi.db.tracks.find((t) => t.ai === 2 && t.trackNo === 2);
  re.fileHash = sha24(`mpfy-mock-better-${re.id}`);
  fps.set(re.fileHash, fps.get(re.id));
  servers.set(mi.id, mi);
  servers.set(vps.id, vps);

  // The person's data lives on the Mi A2 (principal) and references tracks of the VPS too.
  const now = Date.now();
  const playlists = [
    pl('Viaggio in macchina', 'Per le strade lunghe, finestrini giù.', [T(10, 0), T(1, 3), T(6, 1), T(3, 2), T(7, 0), T(0, 4), T(11, 0), T(4, 3), T(10, 2), T(6, 3), T(1, 0), T(8, 4), T(11, 2), T(10, 0)], 30),
    pl('Mattine lente', '', [T(4, 2), T(4, 0), T(4, 4), T(4, 1)], 20),
    pl('Allenamento', 'Ritmo alto.', [T(7, 1), T(7, 2), T(2, 4), T(9, 0), T(5, 1), T(7, 4), T(3, 4), T(8, 0), T(2, 0), T(9, 3)], 12),
    pl('Nuove scoperte', '', [], 2),
  ];
  const likes = [T(11, 2), T(3, 0), T(10, 0), T(6, 0), T(4, 2), T(1, 0), T(7, 0), T(2, 0), T(0, 1), T(11, 0), T(5, 0), T(8, 3)].map((id, i) => ({ id, at: now - i * 7 * 3600000 }));
  const ev = (trackId, minutesAgo, type, id = null) => ({ trackId, at: now - minutesAgo * 60000, context: { type, id } });
  const recents = [
    ev(T(10, 0), 5, 'playlist', playlists[0].id),
    ev(T(1, 3), 9, 'playlist', playlists[0].id),
    ev(T(6, 1), 13, 'playlist', playlists[0].id),
    ev(T(6, 0), 60, 'album', albumId(6)),
    ev(T(6, 1), 64, 'album', albumId(6)),
    ev(T(3, 0), 120, 'artist', artistId(3)),
    ev(T(2, 0), 124, 'artist', artistId(2)),
    ev(T(11, 2), 200, 'liked'),
    ev(T(11, 0), 300, 'album', albumId(11)),
    ev(T(4, 2), 600, 'playlist', playlists[1].id),
    ev(T(7, 1), 1500, 'playlist', playlists[2].id),
    ev(T(8, 3), 2000, 'library'),
    ev(T(0, 1), 2600, 'search', 'faro'),
    ev(T(10, 0), 3000, 'album', albumId(10)),
  ];
  // A custom cover on "Mattine lente" (two sizes), to see "Ripristina copertina" at once.
  const small = makeCover([90, 60, 40], [240, 200, 150], 77, 160);
  const large = makeCover([90, 60, 40], [240, 200, 150], 77, 640);
  covers.set(sha24(small), { buf: small, mime: 'image/png', sized: {} });
  covers.set(sha24(large), { buf: large, mime: 'image/png', sized: {} });
  mi.users.set(withProfile ? ME_ID : 'owner', { userVersion: now, playlists, likes, recents, covers: { playlist: { [playlists[1].id]: { small: sha24(small), large: sha24(large) } } } });
  mi.users.set(SIS_ID, { userVersion: now, playlists: [pl('Di Giulia', '', [T(2, 1)], 3)], likes: [{ id: T(2, 1), at: now }], recents: [], covers: { playlist: {} } });

  // The VPS: this person's own (older) data, as if it was the principal of another device once,
  // and Giulia's.
  vps.users.set(ME_ID, { userVersion: now, playlists: [pl('Mattine lente', 'Versione vecchia sul VPS', [T(9, 0), T(9, 1)], 60)], likes: [{ id: T(9, 2), at: now - 40 * 86400000 }], recents: [], covers: { playlist: {} } });
  vps.users.set(SIS_ID, { userVersion: now, playlists: [pl('Solo sul VPS', '', [T(10, 1), T(11, 3)], 45)], likes: [], recents: [], covers: { playlist: {} } });

  if (BIG_TRACKS) {
    grow(mi, BIG_TRACKS, { likes: BIG_LIKES, playlist: BIG_PLAYLIST, person: withProfile ? ME_ID : 'owner' });
    if (BIG_MIRROR) grow(vps, BIG_TRACKS, { from: 0, person: ME_ID, copies: BIG_MIRROR === 'copies' });
  }

  const t0 = now - 7 * 86400000;
  paired = [];
  if (nPaired >= 1) paired.push({ id: mi.id, principal: true, addedAt: t0 });
  if (nPaired >= 2) paired.push({ id: vps.id, principal: false, addedAt: t0 + 3600000 });
  for (const s of servers.values()) if (!paired.some((p) => p.id === s.id)) s.clients = s.clients.filter((c) => c.publicKey !== CLIENT_KEY);
  for (const p of paired) bind(servers.get(p.id));
  device.social = newSocial();
  device.chat = newChat();
  seedSongs(mi, vps);
  phone = phoneOn ? makePhone(mi) : null;
}

// ---------------------------------------------------------------------------------------------
// versions, epochs and what moved since a version (each source's logs, in memory)

const ZERO_EPOCH = '0000000000000000';
const TOMBSTONES = 10000;
const KEPT_OPS = 4096;
const KEPT_OP_IDS = 65536;

/** A random epoch id, never the zero one (a person with nothing yet). */
function epochId() {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex');
    if (id !== ZERO_EPOCH) return id;
  }
}

/** A log at `version`: one epoch, the current one, known from that version on. */
const newLog = (version) => {
  const id = epochId();
  return { epoch: id, epochs: [{ id, first: version, last: version }], horizon: 0, newRun: false };
};
const sharedLog = (version) => ({ ...newLog(version), cv: new Map(), gone: new Map(), covers: { track: new Map(), album: new Map() }, viewer: undefined });

function ulOf(u) {
  if (!u.ul) u.ul = { ...newLog(u.userVersion), pv: new Map(), plain: new Map(), pgone: new Map(), lv: new Map(), lgone: new Map(), rv: 0, cv: new Map(), ops: [], opIds: 0, opsFrom: 0 };
  return u.ul;
}

/**
 * The version after a change of a log now at `cur`: one more, never behind the clock. The first
 * change of a new run opens its epoch at E = max(cur + 1, now) and takes E + 1.
 */
function nextVersion(log, cur) {
  let v = Math.max(Date.now(), cur + 1);
  if (log.newRun) {
    const id = epochId();
    const e = Math.max(cur + 1, Date.now());
    v = e + 1;
    log.epochs.push({ id, first: e, last: e });
    if (log.epochs.length > 64) log.horizon = Math.max(log.horizon, log.epochs.shift().last);
    log.epoch = id;
    log.newRun = false;
  }
  log.epochs[log.epochs.length - 1].last = v;
  return v;
}

/** The log can prove what an app holding version v of epoch e has: e is one of its epochs, v in its range, at or above the horizon. */
function knows(log, e, v) {
  if (e === null || v === null || v < log.horizon) return false;
  const x = log.epochs.find((y) => y.id === e);
  return !!x && x.first <= v && v <= x.last;
}

/** Oldest tombstones beyond the kept number go, and the horizon passes them. */
function trimTombs(log, map) {
  while (map.size > TOMBSTONES) {
    const [id, v] = map.entries().next().value;
    map.delete(id);
    log.horizon = Math.max(log.horizon, v);
  }
}

/**
 * The shared part changed. what: { tracks: [ids changed or added], removed: [ids], covers: {
 * track: [ids], album: [ids] } }, or nothing: a reset (every app takes the whole part).
 */
function changedShared(srv, what = null) {
  const L = srv.lib;
  const v = (srv.db.version = nextVersion(L, srv.db.version));
  if (!what) {
    L.horizon = v;
    return v;
  }
  for (const id of what.tracks || []) L.cv.set(id, v);
  for (const id of what.removed || []) {
    L.cv.delete(id);
    L.gone.delete(id);
    L.gone.set(id, v);
  }
  trimTombs(L, L.gone);
  for (const kind of ['track', 'album']) for (const id of what.covers?.[kind] || []) L.covers[kind].set(id, v);
  return v;
}

/**
 * A person's part changed. what: { playlists: [ids made or changed], edits: [[id, op]] (adds and
 * removals only: ['a', position, ids], ['r', positions]), removedPlaylists: [ids], liked: [ids],
 * unliked: [ids], recents: true, covers: [playlist ids] }, or nothing: a reset.
 */
function changedUser(srv, u = userOf(srv), what = null) {
  if (srv.phone) srv.holds = true; // a log of the person exists on the phone now
  const L = ulOf(u);
  const v = (u.userVersion = nextVersion(L, u.userVersion));
  if (!what) {
    L.horizon = v;
    return v;
  }
  for (const id of what.playlists || []) {
    L.pv.set(id, v);
    L.plain.set(id, v);
  }
  for (const [id, op] of what.edits || []) {
    L.pv.set(id, v);
    L.ops.push({ v, id, op });
    L.opIds += op[op.length - 1].length;
  }
  while (L.ops.length > KEPT_OPS || L.opIds > KEPT_OP_IDS) {
    const old = L.ops.shift();
    L.opIds -= old.op[old.op.length - 1].length;
    L.opsFrom = old.v;
  }
  for (const id of what.removedPlaylists || []) {
    L.pv.delete(id);
    L.plain.delete(id);
    L.pgone.delete(id);
    L.pgone.set(id, v);
  }
  trimTombs(L, L.pgone);
  for (const id of what.liked || []) L.lv.set(id, v);
  for (const id of what.unliked || []) {
    L.lv.delete(id);
    L.lgone.delete(id);
    L.lgone.set(id, v);
  }
  trimTombs(L, L.lgone);
  if (what.recents) L.rv = v;
  for (const id of what.covers || []) L.cv.set(id, v);
  return v;
}

/** The headers of an answer to a change of the person's part (none from a source of before them). */
const userHeaders = (srv, u = userOf(srv)) => (srv.legacy || srv.oldLibrary ? {} : { 'X-MPfy-User-Version': String(u.userVersion), 'X-MPfy-User-Epoch': ulOf(u).epoch });
/** The headers of an answer to a change of the shared part. */
const sharedHeaders = (srv) => (srv.legacy || srv.oldLibrary ? {} : { 'X-MPfy-Version': String(srv.db.version), 'X-MPfy-Epoch': srv.lib.epoch });

/** What moved in the shared part since version `have`: tracks in the library's order, the removed ids, the custom covers. */
function sharedSince(srv, have) {
  const L = srv.lib;
  const changed = srv.db.tracks.filter((t) => (L.cv.get(t.id) || 0) > have);
  const removed = [];
  for (const [id, v] of L.gone) if (v > have) removed.push(id);
  const covers = { track: {}, album: {} };
  for (const kind of ['track', 'album']) for (const [id, v] of L.covers[kind]) if (v > have) covers[kind][id] = srv.db.covers[kind][id] || null;
  return { changed, removed, covers };
}

/** zlib's CRC-32 of the ids joined by commas, as 8 lowercase hex digits. */
const idsCrc = (ids) => zlib.crc32(Buffer.from(ids.join(','), 'utf8')).toString(16).padStart(8, '0');

/** What moved in a person's part since `uv`; edits (mode 2) for long playlists changed only by adds and removals. */
function userSince(u, uv, mode) {
  const L = ulOf(u);
  const changed = [];
  const edits = [];
  for (const p of u.playlists) {
    if ((L.pv.get(p.id) || 0) <= uv) continue;
    const ops = mode === 2 && p.trackIds.length > 1000 && (L.plain.get(p.id) || 0) <= uv && L.opsFrom <= uv ? L.ops.filter((o) => o.id === p.id && o.v > uv) : null;
    if (ops && ops.length && ops.length <= 32) {
      let from = p.trackIds.length;
      for (const o of ops) from += o.op[0] === 'a' ? -o.op[2].length : o.op[1].length;
      edits.push({ id: p.id, from, to: p.trackIds.length, ops: ops.map((o) => o.op), crc: idsCrc(p.trackIds) });
    } else changed.push(p);
  }
  const removed = [];
  for (const [id, v] of L.pgone) if (v > uv) removed.push(id);
  const added = [];
  for (let i = u.likes.length - 1; i >= 0; i--) if ((L.lv.get(u.likes[i].id) || 0) > uv) added.push({ id: u.likes[i].id, at: u.likes[i].at });
  const unliked = [];
  for (const [id, v] of L.lgone) if (v > uv) unliked.push(id);
  const covers = {};
  for (const [id, v] of L.cv) if (v > uv) covers[id] = u.covers.playlist[id] || null;
  return { playlists: { changed, removed, ...(mode === 2 ? { edits } : {}) }, likes: { added, removed: unliked }, recents: L.rv > uv ? u.recents.slice(0, 50) : null, covers };
}
const findTrack = (srv, id) => srv.db.tracks.find((t) => t.id === id);
const findPlaylist = (u, id) => u.playlists.find((p) => p.id === id);

// ---------------------------------------------------------------------------------------------
// WAV generation, any byte range computed on the fly (no memory per track)

function wavHeader(dataBytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** A soft arpeggio with a low drone, fading in and out. */
function sampleAt(g, i) {
  const t = i / SR;
  const k = Math.floor(t / g.noteLen);
  const tn = t - k * g.noteLen;
  const f = g.freqs[k % g.freqs.length] * (Math.floor(k / g.freqs.length) % 4 === 3 ? 2 : 1);
  const env = Math.exp(-tn * 6) * Math.min(1, tn * 300);
  let v = (Math.sin(2 * Math.PI * f * tn) * 0.8 + Math.sin(4 * Math.PI * f * tn) * 0.15) * env * 0.3;
  v += Math.sin(2 * Math.PI * g.drone * t) * 0.06;
  const fade = Math.max(0, Math.min(1, t / 0.5, (g.duration - t) / 1.0));
  return Math.round(Math.max(-1, Math.min(1, v * fade)) * 32767);
}

function toneStream(g, start, end) {
  const header = wavHeader(g.samples * 2);
  let pos = start;
  return new Readable({
    read() {
      if (pos > end) {
        this.push(null);
        return;
      }
      const stop = Math.min(end, pos + 65535);
      const out = Buffer.allocUnsafe(stop - pos + 1);
      let w = 0;
      while (pos <= stop && pos < 44) out[w++] = header[pos++];
      let idx = -1;
      let val = 0;
      while (pos <= stop) {
        const off = pos - 44;
        const i = off >> 1;
        if (i !== idx) {
          idx = i;
          val = sampleAt(g, i) & 0xffff;
        }
        out[w++] = off & 1 ? (val >> 8) & 0xff : val & 0xff;
        pos++;
      }
      this.push(out);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code = null, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sendJson(req, res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  const gzip = body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? zlib.gzipSync(body) : body;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': out.length,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

/**
 * A library answer: small ones as sendJson; one with more than 1,000 tracks written in slices of
 * 250 (through gzip when asked), each slice after the last one was taken, with no
 * Content-Length. The bytes are the same as JSON.stringify of the whole answer.
 */
async function sendLibrary(srv, req, res, head, tracks, tail, headers) {
  const list = Array.isArray(tracks) ? tracks : tracks ? tracks.changed : null;
  const pub = (t) => publicTrack(srv, t);
  if (!list || list.length <= 1000) {
    const part = Array.isArray(tracks) ? tracks.map(pub) : tracks ? { changed: tracks.changed.map(pub), removed: tracks.removed } : null;
    sendJson(req, res, 200, { ...head, tracks: part, ...tail }, { 'Cache-Control': 'no-cache', ...headers });
    return;
  }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}), ...headers });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const out = gzip ? zlib.createGzip() : res;
  if (gzip) out.pipe(res);
  let gone = false;
  res.on('close', () => (gone = true));
  const put = async (text) => {
    if (out.write(text) || gone) return;
    await new Promise((r) => {
      const done = () => {
        out.off('drain', done);
        res.off('close', done);
        r();
      };
      out.on('drain', done);
      res.on('close', done);
    });
  };
  await put(`${JSON.stringify(head).slice(0, -1)},"tracks":${Array.isArray(tracks) ? '[' : '{"changed":['}`);
  for (let i = 0; i < list.length && !gone; i += 250) await put((i ? ',' : '') + list.slice(i, i + 250).map((t) => JSON.stringify(pub(t))).join(','));
  if (gone) {
    if (gzip) out.destroy();
    return;
  }
  await put(`]${Array.isArray(tracks) ? '' : `,"removed":${JSON.stringify(tracks.removed)}}`},${JSON.stringify(tail).slice(1)}`);
  out.end();
}

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'Richiesta troppo grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON non valido');
  }
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

const etagMatches = (header, tag) => !!header && header.split(',').some((t) => t.trim().replace(/^W\//, '') === tag.replace(/^W\//, ''));

/** Recognizes audio by magic bytes (not by extension), like the real server. */
function sniff(head) {
  if (head.length < 4) return null;
  const s4 = head.subarray(0, 4).toString('latin1');
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return { format: 'mp3', mime: 'audio/mpeg' };
  if (s4 === 'fLaC') return { format: 'flac', mime: 'audio/flac' };
  if (s4 === 'OggS') {
    const isOpus = head.includes(Buffer.from('OpusHead'));
    return isOpus ? { format: 'opus', mime: 'audio/ogg' } : { format: 'ogg', mime: 'audio/ogg' };
  }
  if (s4 === 'RIFF' && head.length >= 12 && head.subarray(8, 12).toString('latin1') === 'WAVE') return { format: 'wav', mime: 'audio/wav' };
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return { format: 'm4a', mime: 'audio/mp4' };
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { format: 'aac', mime: 'audio/aac' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { format: 'mp3', mime: 'audio/mpeg' };
  return null;
}

const isImage = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.subarray(1, 4).toString('latin1') === 'PNG' || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');

// ---------------------------------------------------------------------------------------------
// the API of one fake source

const TRACK_ID = /^[0-9a-f]{24}$/;
const OPAQUE_ID = /^[0-9a-f]{8,32}$/;
const LEVELS = ['low', 'normal', 'high'];
const NEED = (code) => {
  const map = {
    forbidden: [403, 'Non consentito'],
    no_profile: [403, 'Profilo mancante'],
    bad_name: [400, 'Nome non valido'],
    bad_request: [400, 'Richiesta non valida'],
    playlist_exists: [409, "Playlist gia' presente"],
    session_gone: [404, 'Caricamento non trovato'],
    pending_gone: [404, 'Scelta scaduta'],
    version_gone: [404, 'Brano non trovato'],
    no_recovery: [404, 'Recupero non attivo'],
    too_many_uploads: [429, 'Troppi caricamenti in corso'],
    unsupported_archive: [415, 'Formato non supportato'],
    disk_full: [507, 'Spazio su disco esaurito sulla fonte'],
    not_audio: [415, 'Formato non supportato'],
    too_many_likes: [400, 'Troppi brani piaciuti'],
  };
  const [status, text] = map[code];
  return new HttpError(status, text, code);
};

/** The asked level if ready, else the next lower ready one, then higher, then max. */
function servedLevel(t, q) {
  if (!LEVELS.includes(q)) return 'max';
  if (t.qualities?.[q]) return q;
  const i = LEVELS.indexOf(q);
  for (let k = i - 1; k >= 0; k--) if (t.qualities?.[LEVELS[k]]) return LEVELS[k];
  for (let k = i + 1; k < LEVELS.length; k++) if (t.qualities?.[LEVELS[k]]) return LEVELS[k];
  return 'max';
}

/** A track as the caller sees it: who uploaded what stays here, the caller gets mine and others. */
/** The source's own description: its name and, when it says it, "Cerca i dettagli in rete". */
const sourceView = (srv) => ({ name: srv.name, named: srv.named, ...(typeof srv.details === 'boolean' ? { details: srv.details } : {}), ...(srv.phone ? { social: 0 } : {}) });

function publicTrack(srv, t) {
  const { ai, rec, uploaders, notSame, ...out } = t;
  if (srv.legacy) {
    const { fileHash, codec, sampleRate, bitDepth, fakeLossless, equivKbps, score, fp, ...old } = out;
    return old;
  }
  const a = actor();
  const mine = uploaders.includes(a) || (roleOn(srv) === 'owner' && a === 'owner' && uploaders.includes(srv.ownerProfileId));
  const lyrics = socialOf(srv) >= 3 || srv.phone ? lyricsFlag(srv, t.id) : null;
  return { ...out, mine, others: uploaders.some((u) => u !== a && !(a === 'owner' && u === 'owner')), ...(lyrics ? { lyrics } : {}) };
}

function streamTrack(srv, req, res, id, url) {
  const t = findTrack(srv, id);
  const src = audio.get(id) || (t && t.big ? { kind: 'tone', gen: toneGen(t.rec % 97, t.duration) } : null);
  if (!t || !src) throw new HttpError(404, 'Brano non trovato');
  const f = url.searchParams.get('f');
  if (f && !srv.legacy && f !== t.fileHash) throw NEED('version_gone');
  if (srv.streamFail && req.method !== 'HEAD') throw new HttpError(500, 'Errore interno');
  if (srv.streamStall && req.method !== 'HEAD') {
    // Headers, then nothing: the player waits for data that never comes.
    res.writeHead(200, { 'Content-Type': t.mime, 'Content-Length': 44 + 1000000 });
    res.write(wavHeader(1000000));
    return;
  }
  const level = servedLevel(t, url.searchParams.get('q') || 'max');
  const size = src.kind === 'bytes' ? src.buf.length : 44 + src.gen.samples * 2;
  const max = level === 'max';
  const headers = {
    'Content-Type': t.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': max && f === t.fileHash ? 'private, max-age=31536000, immutable' : 'no-cache',
    ETag: max ? `"${t.fileHash}"` : `"${t.id}-${level}"`,
    'X-MPfy-Quality': level,
  };
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  srv.throughputKbps = srv.linkKbps; // the core measures it on forwarded bodies
  const body = src.kind === 'bytes' ? Readable.from([src.buf.subarray(start, end + 1)]) : toneStream(src.gen, start, end);
  body.pipe(res);
  res.on('close', () => body.destroy());
}

function serverHasCover(srv, coverId) {
  if (srv.db.tracks.some((t) => t.coverId === coverId)) return true;
  for (const kind of ['track', 'album']) for (const c of Object.values(srv.db.covers[kind])) if (c.small === coverId || c.large === coverId) return true;
  for (const u of srv.users.values()) for (const c of Object.values(u.covers.playlist)) if (c.small === coverId || c.large === coverId) return true;
  return false;
}

function serveCover(srv, req, res, coverId, url) {
  const c = covers.get(coverId);
  if (!c || !serverHasCover(srv, coverId)) throw new HttpError(404, 'Copertina non trovata');
  const size = url.searchParams.get('size');
  let buf = c.buf;
  if (c.gen && (size === 'small' || size === 'large')) {
    c.sized[size] ||= makeCover(c.gen.c1, c.gen.c2, c.gen.seed, size === 'small' ? 160 : 640);
    buf = c.sized[size];
  }
  const tag = `"${coverId}-${size || 'orig'}"`;
  const cache = { ETag: tag, 'Cache-Control': 'private, max-age=31536000, immutable' };
  if (etagMatches(req.headers['if-none-match'], tag)) {
    res.writeHead(304, cache);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': c.mime, 'Content-Length': buf.length, ...cache });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// ---- the upload pipeline (single PUT, finished session, archive entry) ----

const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
function archiveKind(head) {
  const s = head.subarray(0, 8);
  if (s[0] === 0x50 && s[1] === 0x4b && ((s[2] === 3 && s[3] === 4) || (s[2] === 5 && s[3] === 6))) return 'zip';
  if (s.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (s.subarray(0, 6).toString('latin1') === 'Rar!\u001a\u0007') return 'rar';
  return null;
}

/** "<title> [hq]" is a better file of <title>, "<title> [forse]" maybe the same, "<title>" the same. */
function nameMatch(srv, filename) {
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  const m = /^(.*?)\s*\[(hq|forse)\]$/i.exec(stem);
  const title = (m ? m[1] : stem).toLowerCase();
  const t = srv.db.tracks.find((x) => x.title.toLowerCase() === title);
  if (!t) return null;
  return { t, kind: m ? (m[2].toLowerCase() === 'hq' ? 'better' : 'maybe') : 'same' };
}

const candidateOf = (track) => ({ title: track.title, artist: track.artist, album: track.album, duration: track.duration, format: track.format, codec: track.codec, bitrate: track.bitrate, lossless: track.lossless, score: track.score });

/** A new track from bytes that passed the audio check. */
function newTrack(srv, id, filename, size, kind, buf, keep) {
  let duration;
  if (kind.format === 'wav' && buf && buf.length >= 32) duration = Math.max(1, (size - 44) / Math.max(1, buf.readUInt32LE(28)));
  else duration = Math.max(1, (size * 8) / (kind.format === 'flac' ? 900000 : 192000));
  duration = Math.round(duration * 10) / 10;
  const title = filename.replace(/\.[^.]+$/, '').replace(/\s*\[(hq|forse)\]$/i, '') || filename;
  const lossless = kind.format === 'flac' || kind.format === 'wav';
  const codec = { mp3: 'mp3', flac: 'flac', wav: 'wav', opus: 'opus', ogg: 'vorbis', m4a: 'aac', aac: 'aac' }[kind.format] || kind.format;
  const rec = 9000 + srv.db.tracks.length;
  const raw = rawFp(rec, duration);
  fps.set(id, raw);
  const track = {
    rec,
    id,
    fileHash: id,
    title,
    artist: 'Artista sconosciuto',
    album: 'Album sconosciuto',
    albumArtist: 'Artista sconosciuto',
    trackNo: null,
    discNo: null,
    year: null,
    duration,
    format: kind.format,
    mime: kind.mime,
    codec,
    sampleRate: kind.format === 'wav' && buf ? buf.readUInt32LE(24) : 44100,
    bitDepth: lossless ? 16 : null,
    fakeLossless: lossless ? false : null,
    equivKbps: null,
    size,
    bitrate: Math.round((size * 8) / duration),
    lossless,
    addedAt: Date.now(),
    coverId: null,
    qualities: { low: false, normal: false, high: false }, // the transcode queue has not run yet
    fp: signature(raw, duration),
    uploaders: [actor()],
  };
  track.score = scoreOf(track);
  if (!audio.has(id)) {
    if (keep && buf) audio.set(id, { kind: 'bytes', buf });
    else {
      track.mime = 'audio/wav';
      audio.set(id, { kind: 'tone', gen: toneGen(srv.db.tracks.length, duration) });
    }
  }
  return track;
}

const claim = (t) => {
  if (!t.uploaders.includes(actor())) t.uploaders.push(actor());
};

/**
 * One audio file through the pipeline: byte identical, the real audio check, then the name
 * conventions of this mock for "same", "better" and "maybe". headers: a request with a profile
 * (without one a "maybe" is decided "both"). Resolves the upload result.
 */
function importAudio(srv, { filename, hash, size, buf, keep, archiveId = null }) {
  const id = hash.slice(0, 24);
  const same = srv.db.tracks.find((t) => t.id === id || t.fileHash === id);
  if (same) {
    claim(same);
    changedShared(srv, { tracks: [same.id] });
    return { outcome: 'duplicate', duplicate: true, track: publicTrack(srv, same) };
  }
  const kind = sniff(buf ? buf.subarray(0, 64) : Buffer.alloc(0));
  if (!kind) throw NEED('not_audio');
  const m = srv.legacy ? null : nameMatch(srv, filename);
  if (m?.kind === 'same') {
    claim(m.t);
    changedShared(srv, { tracks: [m.t.id] });
    return { outcome: 'duplicate', duplicate: true, track: publicTrack(srv, m.t) };
  }
  if (m?.kind === 'better') {
    m.t.fileHash = id;
    m.t.size = size;
    fps.set(id, fps.get(m.t.id));
    if (keep && buf) audio.set(m.t.id, { kind: 'bytes', buf });
    claim(m.t);
    changedShared(srv, { tracks: [m.t.id] });
    return { outcome: 'replaced', duplicate: true, track: publicTrack(srv, m.t) };
  }
  const track = newTrack(srv, id, filename, size, kind, buf, keep);
  if (m?.kind === 'maybe' && device.profile) {
    const pid = crypto.randomBytes(8).toString('hex');
    const p = { id: pid, profileId: actor(), track, matchTrackId: m.t.id, candidate: candidateOf(track), archiveId, expiresAt: Date.now() + 86400000 };
    srv.pending.set(pid, p);
    return { outcome: 'maybe', pending: { id: pid, match: publicTrack(srv, m.t), candidate: p.candidate, expiresAt: p.expiresAt } };
  }
  srv.db.tracks.push(track);
  changedShared(srv, { tracks: [track.id] });
  return { outcome: 'added', duplicate: false, track: publicTrack(srv, track) };
}

/** The entries of a ZIP (stored and deflate), read from its central directory. */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('archive_invalid');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('archive_invalid');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error('archive_encrypted');
    if (name.endsWith('/')) continue;
    const lnl = buf.readUInt16LE(local + 26);
    const lxl = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnl + lxl, local + 30 + lnl + lxl + csize);
    if (method !== 0 && method !== 8) throw new Error('archive_invalid');
    out.push({ name, data: () => (method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)) });
  }
  return out;
}

const AUDIO_NAME = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav|wave)$/i;

/** An archive: listed, then its audio entries imported one by one, a little slowly. */
function startArchive(srv, filename, buf, kindName) {
  const id = crypto.randomBytes(8).toString('hex');
  const a = { id, profileId: actor(), name: filename, state: 'queued', total: 0, done: 0, added: 0, replaced: 0, duplicates: 0, ignored: 0, pending: [], trackIds: [], coverId: null, error: null, code: null, createdAt: Date.now(), finishedAt: null };
  srv.archivesSt.set(id, a);
  const fail = (code) => {
    const words = { archive_encrypted: 'Archivio protetto da password', archive_too_big: 'Archivio troppo grande', archive_invalid: 'Archivio non valido', unsupported_archive: 'Formato non supportato' };
    Object.assign(a, { state: 'failed', code, error: words[code] || 'Archivio non valido', finishedAt: Date.now() });
  };
  (async () => {
    await sleep(srv.extractMs);
    a.state = 'checking';
    if (kindName !== 'zip') {
      fail(srv.archives.sevenZip ? 'archive_invalid' : 'unsupported_archive');
      return;
    }
    let entries;
    try {
      entries = zipEntries(buf);
    } catch (err) {
      fail(['archive_encrypted', 'archive_invalid'].includes(err.message) ? err.message : 'archive_invalid');
      return;
    }
    const tracks = entries.filter((e) => AUDIO_NAME.test(e.name));
    a.ignored += entries.filter((e) => ARCHIVE_EXT.test(e.name)).length; // nested archives
    a.total = tracks.length;
    a.state = 'extracting';
    await sleep(srv.extractMs);
    a.state = 'importing';
    for (const e of tracks) {
      await sleep(srv.extractMs);
      const data = e.data();
      try {
        const r = importAudio(srv, { filename: path.basename(e.name), hash: sha(data), size: data.length, buf: data, keep: true, archiveId: id });
        if (r.outcome === 'added') a.added++;
        else if (r.outcome === 'replaced') a.replaced++;
        else if (r.outcome === 'duplicate') a.duplicates++;
        if (r.track) a.trackIds.push(r.track.id);
        if (r.outcome === 'maybe') a.pending.push({ id: r.pending.id, match: r.pending.match, candidate: r.pending.candidate, expiresAt: r.pending.expiresAt });
      } catch {
        a.ignored++;
      }
      a.done++;
    }
    a.state = 'done';
    a.finishedAt = Date.now();
  })();
  return { outcome: 'archive', archive: { id } };
}

/** Everything that arrives whole: an archive, or an audio file. */
function pipeline(srv, { filename, hash, size, buf, keep }) {
  const ak = buf ? archiveKind(buf) : null;
  if (ak) {
    if (srv.legacy) throw NEED('not_audio');
    if ((ak === '7z' || ak === 'rar') && !srv.archives[ak === '7z' ? 'sevenZip' : 'rar']) throw NEED('unsupported_archive');
    return startArchive(srv, filename, buf, ak);
  }
  return importAudio(srv, { filename, hash, size, buf, keep });
}

async function upload(srv, req, res, rawName) {
  let filename;
  try {
    filename = path.basename(decodeURIComponent(rawName)).slice(0, 240);
  } catch {
    throw new HttpError(400, 'Nome del file non valido');
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) {
    req.resume();
    throw new HttpError(413, 'File troppo grande (massimo 600 MB)', 'too_large');
  }
  const hash = crypto.createHash('sha256');
  const parts = [];
  let size = 0;
  let keep = true;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      keep = false;
      parts.length = 0;
      continue; // drain the rest, answer 413 at the end
    }
    hash.update(chunk);
    if (keep && size <= KEEP_UPLOAD_BYTES) parts.push(chunk);
    else {
      keep = false;
      parts.length = 0;
    }
  }
  if (size > MAX_UPLOAD) throw new HttpError(413, 'File troppo grande (massimo 600 MB)', 'too_large');
  if (!size) throw new HttpError(400, 'File vuoto');
  const buf = keep ? Buffer.concat(parts) : null;
  const r = pipeline(srv, { filename, hash: hash.digest('hex'), size, buf, keep });
  if (srv.legacy) {
    // A source without profiles answers as it always did.
    sendJson(req, res, r.outcome === 'added' ? 201 : 200, { track: r.track, duplicate: r.duplicate });
    return;
  }
  sendJson(req, res, r.outcome === 'archive' ? 202 : r.outcome === 'added' ? 201 : 200, r, sharedHeaders(srv));
}

// ---- resumable sessions ----

const sessionView = (s) => ({ id: s.id, name: s.name, size: s.size, offset: s.offset, processing: s.processing, expiresAt: s.updatedAt + 86400000, done: s.done, ...(s.done ? (s.error ? { error: s.error } : { result: s.result }) : {}) });

async function createSession(srv, req, res) {
  if (srv.legacy) throw new HttpError(404, 'Risorsa non trovata');
  const b = await readJson(req);
  const name = typeof b.name === 'string' ? path.basename(b.name).slice(0, 240) : '';
  const size = Number(b.size);
  if (!name || !Number.isInteger(size) || size <= 0 || typeof b.headHash !== 'string') throw new HttpError(400, 'Richiesta non valida');
  const archive = ARCHIVE_EXT.test(name);
  if (size > (archive ? MAX_ARCHIVE : MAX_UPLOAD)) throw new HttpError(413, archive ? 'File troppo grande (massimo 4 GB)' : 'File troppo grande (massimo 600 MB)', 'too_large');
  if ((/\.7z$/i.test(name) && !srv.archives.sevenZip) || (/\.rar$/i.test(name) && !srv.archives.rar)) throw NEED('unsupported_archive');
  const reserved = [...srv.sessions.values()].filter((s) => !s.done).reduce((n, s) => n + (s.size - s.offset), 0);
  if (srv.diskFreeBytes - reserved - size < 0) throw NEED('disk_full');
  const mine = [...srv.sessions.values()].filter((s) => s.profileId === actor() && !s.done);
  const again = mine.find((s) => s.name === name && s.size === size && s.lastModified === b.lastModified && s.headHash === b.headHash);
  if (again) return sendJson(req, res, 200, { id: again.id, size: again.size, offset: again.offset, chunkBytes: 8388608, expiresAt: again.updatedAt + 86400000 });
  if (mine.length >= srv.maxSessions) throw NEED('too_many_uploads');
  const now = Date.now();
  const s = { id: crypto.randomBytes(8).toString('hex'), profileId: actor(), name, size, lastModified: b.lastModified, headHash: b.headHash, kind: archive ? 'archive' : 'audio', offset: 0, parts: [], hash: crypto.createHash('sha256'), createdAt: now, updatedAt: now, processing: false, done: false, result: null, error: null, writer: null, puts: [] };
  srv.sessions.set(s.id, s);
  sendJson(req, res, 201, { id: s.id, size, offset: 0, chunkBytes: 8388608, expiresAt: now + 86400000 });
}

function sessionOf(srv, raw) {
  const s = srv.sessions.get(decodeURIComponent(raw));
  if (!s || s.profileId !== actor()) throw NEED('session_gone');
  return s;
}

/** The last byte arrived: the pipeline runs to its end whatever happens to the request. */
async function finishSession(srv, s) {
  s.processing = true;
  if (srv.pipelineMs) await sleep(srv.pipelineMs);
  const buf = s.size <= KEEP_UPLOAD_BYTES ? Buffer.concat(s.parts) : null;
  try {
    const ak = buf ? archiveKind(buf) : null;
    if (s.kind === 'archive' && !ak) throw NEED('unsupported_archive');
    s.result = pipeline(srv, { filename: s.name, hash: s.hash.digest('hex'), size: s.size, buf, keep: !!buf });
  } catch (err) {
    s.error = { status: err.status || 500, error: err.message, code: err.code || null };
  }
  s.parts = [];
  s.processing = false;
  s.done = true;
  s.updatedAt = Date.now();
}

async function putChunk(srv, req, res, m, url) {
  const s = sessionOf(srv, m[1]);
  const n = Number(url.searchParams.get('offset'));
  const len = Number(req.headers['content-length']);
  if (s.processing || s.done || n !== s.offset) {
    req.resume();
    return sendJson(req, res, 409, { error: 'Posizione non valida', code: 'offset_mismatch', ...sessionView(s) });
  }
  if (!Number.isFinite(len) || len > 16777216) throw new HttpError(400, 'Richiesta non valida');
  if (n + len > s.size) throw new HttpError(400, 'Richiesta non valida');
  if (srv.fail > 0) {
    srv.fail--;
    req.resume();
    throw new HttpError(503, 'Fonte non raggiungibile');
  }
  s.puts.push(n);
  const cut = srv.drop > 0 ? (srv.drop--, Math.floor(len / 2)) : -1;
  let got = 0;
  for await (const chunk of req) {
    const take = cut >= 0 ? Math.max(0, Math.min(chunk.length, cut - got)) : chunk.length;
    if (take) {
      const part = chunk.subarray(0, take);
      s.parts.push(Buffer.from(part));
      s.hash.update(part);
      s.offset += take;
    }
    got += chunk.length;
    if (cut >= 0 && got >= cut) {
      // Half of it reached the disk, then the link went.
      s.updatedAt = Date.now();
      req.socket.destroy();
      return undefined;
    }
  }
  s.updatedAt = Date.now();
  if (s.offset < s.size) return sendJson(req, res, 200, { offset: s.offset });
  await finishSession(srv, s);
  if (s.error) return sendJson(req, res, s.error.status, { error: s.error.error, code: s.error.code });
  return sendJson(req, res, 200, { offset: s.offset, done: true, result: s.result }, sharedHeaders(srv));
}

// ---- recovery blobs on a source ----

function recoveryEntries(srv) {
  const out = [];
  for (const [profileId, r] of srv.recovery) {
    const name = srv.profiles.get(profileId)?.name || '';
    for (const [dev, d] of Object.entries(r.devices)) out.push({ profileId, name, device: dev, deviceName: d.deviceName, updatedAt: d.updatedAt });
  }
  return out;
}

// ---- routes ----

function str(v, field, { max = 300, allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `Campo ${field} non valido`);
  const s = v.trim().slice(0, max);
  if (!s && !allowEmpty) throw new HttpError(400, `Campo ${field} vuoto`);
  return s;
}

/** A name of 1 to 40 characters (code points), cleaned. */
function cleanName(v) {
  if (typeof v !== 'string') throw NEED('bad_name');
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const n = Array.from(s).length;
  if (n < 1 || n > 40) throw NEED('bad_name');
  return s;
}

/** User data accepts foreign ids: only the format is checked. */
function trackIdsOf(v) {
  if (!Array.isArray(v)) throw new HttpError(400, 'trackIds deve essere una lista');
  for (const id of v) if (typeof id !== 'string' || !TRACK_ID.test(id)) throw new HttpError(400, 'Id di brano non valido nella lista');
  return v.slice();
}

function trackIdParam(raw) {
  const id = decodeURIComponent(raw);
  if (!TRACK_ID.test(id)) throw new HttpError(400, 'Id di brano non valido');
  return id;
}

const mayTouch = (srv, t) => roleOn(srv) !== 'member' || t.uploaders.includes(actor());
function mayTouchAlbum(srv, id) {
  if (roleOn(srv) !== 'member') return true;
  const own = srv.db.tracks.filter((t) => albumIdOf(t) === id);
  return own.length > 0 && own.every((t) => t.uploaders.includes(actor()));
}
const coversView = (srv) => ({ track: srv.db.covers.track, album: srv.db.covers.album, playlist: userOf(srv).covers.playlist });

/** The track goes: from the library and from every person's data on this source. */
function dropTrack(srv, id) {
  srv.db.tracks = srv.db.tracks.filter((x) => x.id !== id);
  for (const u of srv.users.values()) {
    const lists = u.playlists.filter((p) => p.trackIds.includes(id));
    for (const p of lists) p.trackIds = p.trackIds.filter((x) => x !== id);
    const liked = u.likes.some((x) => x.id === id);
    if (liked) u.likes = u.likes.filter((x) => x.id !== id);
    const played = u.recents.some((x) => x.trackId === id);
    if (played) u.recents = u.recents.filter((x) => x.trackId !== id);
    if (lists.length || liked || played) changedUser(srv, u, { playlists: lists.map((p) => p.id), unliked: liked ? [id] : [], recents: played });
  }
  const hadCover = !!srv.db.covers.track[id];
  delete srv.db.covers.track[id];
  // A track whose file leaves the source loses its comments and its lyrics.
  if (srv.comments) srv.comments.delete(id);
  if (srv.lyrics) srv.lyrics.delete(id);
  changedShared(srv, { removed: [id], covers: { track: hadCover ? [id] : [] } });
}

const CARD_STATE = process.env.MOCK_CARD || 'none';
// What GET /api/admin/storage answers for the card state of a source.
function storageView(srv) {
  const state = srv.card || CARD_STATE;
  const GB = 1024 ** 3;
  const found = { volume: 'B275-0681', freeBytes: Math.round(31.9 * GB), totalBytes: Math.round(31.9 * GB), usable: true, why: null, appFolder: false };
  const card = (extra) => ({ volume: 'B275-0681', state: 'ready', freeBytes: Math.round(12.3 * GB), totalBytes: Math.round(31.9 * GB), floorBytes: GB, tracks: 1240, awayTracks: 0, moving: null, leaving: false, appFolder: false, full: false, bad: false, needBytes: null, ...extra });
  if (state === 'found') return { card: null, found: [found] };
  if (state === 'other') return { card: null, found: [{ ...found, usable: false, why: 'other_source' }] };
  if (state === 'use') return { card: card(), found: [] };
  if (state === 'moving') return { card: card({ moving: { done: 230, total: 1200 } }), found: [] };
  if (state === 'full') return { card: card({ full: true }), found: [] };
  if (state === 'readonly') return { card: card({ state: 'readonly' }), found: [] };
  if (state === 'bad') return { card: card({ bad: true }), found: [] };
  if (state === 'away') return { card: card({ state: 'away', freeBytes: null, totalBytes: null, floorBytes: null, awayTracks: 240 }), found: [] };
  if (state === 'leaving') return { card: card({ leaving: true, moving: { done: 230, total: 1200 } }), found: [] };
  return { card: null, found: [] };
}

const routes = [
  [
    'GET',
    /^\/api\/health$/,
    async (srv, req, res) => (srv.healthMs ? await sleep(srv.healthMs) : null, sendJson(req, res, 200, { ok: true, name: srv.name, server: 'mpfy-mock', version: srv.legacy ? '2.0.0-mock' : '2.1.0-mock', tracks: srv.db.tracks.length, diskFreeBytes: srv.diskFreeBytes, ffmpeg: true, ...(srv.legacy ? {} : { fpcalc: true, archives: { ...srv.archives } }), ...(typeof srv.details === 'boolean' ? { details: srv.details } : {}) })),
  ],
  [
    'GET',
    /^\/api\/library$/,
    async (srv, req, res, m, url) => {
      const u = userOf(srv);
      const who = actor();
      if (srv.legacy) {
        const tag = `"mock-${srv.id}-${epoch}-${srv.db.version}-${u.userVersion}"`;
        if (etagMatches(req.headers['if-none-match'], tag)) {
          res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
          res.end();
          return;
        }
        const tracks = srv.db.tracks.map((t) => publicTrack(srv, t));
        sendJson(req, res, 200, { version: srv.db.version, tracks, playlists: u.playlists, likes: u.likes, recents: u.recents, covers: coversView(srv) }, { ETag: tag, 'Cache-Control': 'no-cache' });
        return;
      }
      const you = srv.phone ? null : { profileId: device.profile?.id || null, role: roleOn(srv) };
      const q = url.searchParams;
      if (srv.oldLibrary) {
        // A source of before the delta answers: today's answer and its tag, whatever is asked.
        const tag = `W/"${who}.${epoch}.${srv.db.version}.${u.userVersion}.${srv.details}"`;
        if (etagMatches(req.headers['if-none-match'], tag)) {
          res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
          res.end();
          return;
        }
        const have = Number(q.get('have'));
        const fresh = have && have === srv.db.version;
        await sendLibrary(srv, req, res, { version: srv.db.version, userVersion: u.userVersion }, fresh ? null : srv.db.tracks, { playlists: u.playlists, likes: u.likes, recents: u.recents, covers: fresh ? { playlist: u.covers.playlist } : coversView(srv), you, source: sourceView(srv) }, { ETag: tag });
        return;
      }
      // Another person on this device (a profile made, a claim): what each track says of "mine"
      // moved for every track, so no app may take a delta across it.
      if (srv.lib.viewer !== who) {
        if (srv.lib.viewer !== undefined) changedShared(srv);
        srv.lib.viewer = who;
      }
      const ul = ulOf(u);
      const tag = `W/"${who}.${srv.db.version}.${u.userVersion}.${srv.lib.epoch}.${ul.epoch}"`;
      if (etagMatches(req.headers['if-none-match'], tag)) {
        res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
        res.end();
        return;
      }
      const mode = q.get('delta') === '1' ? 1 : q.get('delta') === '2' ? 2 : 0;
      if (!mode) {
        const have = Number(q.get('have'));
        const fresh = have && have === srv.db.version;
        await sendLibrary(srv, req, res, { version: srv.db.version, userVersion: u.userVersion }, fresh ? null : srv.db.tracks, { playlists: u.playlists, likes: u.likes, recents: u.recents, covers: fresh ? { playlist: u.covers.playlist } : coversView(srv), you, source: sourceView(srv) }, { ETag: tag });
        return;
      }
      // Malformed versions and epochs are not known: the whole part, never an error.
      const num = (k) => (/^\d{1,16}$/.test(q.get(k) || '') && Number.isSafeInteger(Number(q.get(k))) ? Number(q.get(k)) : null);
      const hex = (k) => (/^[0-9a-f]{16}$/.test(q.get(k) || '') ? q.get(k) : null);
      const have = num('have');
      const he = hex('he');
      const uv = num('uv');
      const ue = hex('ue');
      let tracks = srv.db.tracks;
      let moved = null;
      if (have !== null && have === srv.db.version && he === srv.lib.epoch) tracks = null;
      else if (knows(srv.lib, he, have)) {
        const d = sharedSince(srv, have);
        // A delta is never larger than the whole part.
        if (d.changed.length <= srv.db.tracks.length / 2) {
          moved = d;
          tracks = { changed: d.changed, removed: d.removed };
        }
      }
      const mine = knows(ul, ue, uv) ? userSince(u, uv, mode) : null;
      const covers = moved ? { track: moved.covers.track, album: moved.covers.album } : tracks ? { track: srv.db.covers.track, album: srv.db.covers.album } : {};
      covers.playlist = mine ? mine.covers : u.covers.playlist;
      const head = { version: srv.db.version, userVersion: u.userVersion, epochs: { shared: srv.lib.epoch, user: ul.epoch }, delta: { shared: !!moved, user: !!mine } };
      const tail = mine
        ? { playlists: mine.playlists, likes: mine.likes, recents: mine.recents, covers, you, source: sourceView(srv) }
        : { playlists: u.playlists, likes: u.likes, recents: u.recents, covers, you, source: sourceView(srv) };
      await sendLibrary(srv, req, res, head, tracks, tail, { ETag: tag });
    },
  ],
  [
    'GET',
    /^\/api\/recents$/,
    (srv, req, res, m, url) => {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      device.social.recentsGets.push({ source: srv.id, before: url.searchParams.get('before'), limit, answered: !device.social.recentsOff });
      if (device.social.recentsOff || srv.legacy) throw new HttpError(404, 'Risorsa non trovata');
      const u = userOf(srv);
      const all = [...(u.history || u.recents)].sort((a, b) => b.at - a.at);
      const before = Number(url.searchParams.get('before')) || Infinity;
      const older = all.filter((r) => r.at < before);
      sendJson(req, res, 200, { recents: older.slice(0, limit), more: older.length > limit });
    },
  ],
  ['GET', /^\/api\/stream\/([^/]+)$/, (srv, req, res, m, url) => streamTrack(srv, req, res, decodeURIComponent(m[1]), url)],
  ['GET', /^\/api\/cover\/([^/]+)$/, (srv, req, res, m, url) => serveCover(srv, req, res, decodeURIComponent(m[1]), url)],
  [
    'GET',
    /^\/api\/fingerprint\/([^/]+)$/,
    (srv, req, res, m, url) => {
      const t = findTrack(srv, decodeURIComponent(m[1]));
      if (!t || srv.legacy) throw new HttpError(404, 'Brano non trovato');
      const f = url.searchParams.get('f');
      if (f && f !== t.fileHash) throw NEED('version_gone');
      const raw = fps.get(t.fileHash) || fps.get(t.id) || (t.big ? rawFp(t.rec, t.duration) : null);
      if (!raw) throw new HttpError(404, 'Impronta non disponibile');
      sendJson(req, res, 200, { trackId: t.id, fileHash: t.fileHash, d: t.duration, step: ITEM_S, fp: u32b64(raw) }, f === t.fileHash ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : {});
    },
  ],
  ['PUT', /^\/api\/upload\/([^/]+)$/, (srv, req, res, m) => upload(srv, req, res, m[1])],
  ['POST', /^\/api\/uploads$/, (srv, req, res) => createSession(srv, req, res)],
  [
    'GET',
    /^\/api\/uploads$/,
    (srv, req, res) => sendJson(req, res, 200, { sessions: [...srv.sessions.values()].filter((s) => s.profileId === actor() && !s.done).map((s) => ({ id: s.id, name: s.name, size: s.size, lastModified: s.lastModified, offset: s.offset, updatedAt: s.updatedAt })) }),
  ],
  ['PUT', /^\/api\/uploads\/([^/]+)$/, (srv, req, res, m, url) => putChunk(srv, req, res, m, url)],
  ['GET', /^\/api\/uploads\/([^/]+)$/, (srv, req, res, m) => sendJson(req, res, 200, sessionView(sessionOf(srv, m[1])))],
  [
    'DELETE',
    /^\/api\/uploads\/([^/]+)$/,
    (srv, req, res, m) => {
      const s = sessionOf(srv, m[1]);
      srv.sessions.delete(s.id);
      sendJson(req, res, 200, { ok: true });
    },
  ],
  [
    'POST',
    /^\/api\/pending\/([^/]+)$/,
    async (srv, req, res, m) => {
      const p = srv.pending.get(decodeURIComponent(m[1]));
      if (!p || p.profileId !== actor()) throw NEED('pending_gone');
      const b = await readJson(req);
      if (b.keep !== 'best' && b.keep !== 'both') throw new HttpError(400, 'Richiesta non valida');
      srv.pending.delete(p.id);
      const match = findTrack(srv, p.matchTrackId);
      let r;
      if (b.keep === 'best' && match) {
        claim(match);
        changedShared(srv, { tracks: [match.id] });
        r = { outcome: 'duplicate', duplicate: true, track: publicTrack(srv, match) };
      } else {
        srv.db.tracks.push(p.track);
        changedShared(srv, { tracks: [p.track.id] });
        r = { outcome: 'added', duplicate: false, track: publicTrack(srv, p.track) };
      }
      const a = p.archiveId ? srv.archivesSt.get(p.archiveId) : null;
      if (a) {
        a.pending = a.pending.filter((x) => x.id !== p.id);
        if (r.outcome === 'added') a.added++;
        else a.duplicates++;
        a.trackIds.push(r.track.id);
      }
      sendJson(req, res, 200, r, sharedHeaders(srv));
    },
  ],
  [
    'GET',
    /^\/api\/archives\/([^/]+)$/,
    (srv, req, res, m) => {
      const a = srv.archivesSt.get(decodeURIComponent(m[1]));
      if (!a || a.profileId !== actor()) throw new HttpError(404, 'Archivio non trovato');
      const { profileId, ...out } = a;
      sendJson(req, res, 200, out);
    },
  ],
  [
    'PATCH',
    /^\/api\/tracks\/([^/]+)$/,
    async (srv, req, res, m) => {
      const t = findTrack(srv, decodeURIComponent(m[1]));
      if (!t) throw new HttpError(404, 'Brano non trovato');
      if (!mayTouch(srv, t)) throw NEED('forbidden');
      const b = await readJson(req);
      if (b.title !== undefined) t.title = str(b.title, 'titolo');
      if (b.album !== undefined) t.album = str(b.album, 'album');
      if (b.artist !== undefined) {
        const artist = str(b.artist, 'artista');
        if (t.albumArtist === t.artist) t.albumArtist = artist;
        t.artist = artist;
      }
      changedShared(srv, { tracks: [t.id] });
      sendJson(req, res, 200, { track: publicTrack(srv, t) }, sharedHeaders(srv));
    },
  ],
  [
    'DELETE',
    /^\/api\/tracks\/([^/]+)$/,
    (srv, req, res, m) => {
      const id = decodeURIComponent(m[1]);
      const t = findTrack(srv, id);
      if (!t) throw new HttpError(404, 'Brano non trovato');
      if (!mayTouch(srv, t)) throw NEED('forbidden');
      if (roleOn(srv) === 'member') {
        t.uploaders = t.uploaders.filter((u) => u !== actor());
        if (t.uploaders.length) {
          changedShared(srv, { tracks: [t.id] });
          return sendJson(req, res, 200, { ok: true, deleted: false }, sharedHeaders(srv));
        }
      }
      dropTrack(srv, id);
      if (![...servers.values()].some((s) => findTrack(s, id))) audio.delete(id);
      sendJson(req, res, 200, srv.legacy ? { ok: true } : { ok: true, deleted: true }, sharedHeaders(srv));
    },
  ],
  [
    'POST',
    /^\/api\/playlists$/,
    async (srv, req, res) => {
      const b = await readJson(req);
      const u = userOf(srv);
      const now = Date.now();
      let id = crypto.randomBytes(8).toString('hex');
      if (b.id !== undefined && !srv.legacy) {
        if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) throw new HttpError(400, 'Id non valido');
        for (const x of srv.users.values()) if (x.playlists.some((p) => p.id === b.id)) throw NEED('playlist_exists');
        id = b.id;
      }
      const p = { id, name: str(b.name ?? '', 'nome', { max: 100 }), description: b.description == null ? '' : str(b.description, 'descrizione', { allowEmpty: true }), trackIds: [], createdAt: now, updatedAt: now };
      u.playlists.push(p);
      changedUser(srv, u, { playlists: [p.id] });
      sendJson(req, res, 201, { playlist: p }, userHeaders(srv, u));
    },
  ],
  [
    'POST',
    /^\/api\/playlists\/([^/]+)\/tracks$/,
    async (srv, req, res, m) => {
      const u = userOf(srv);
      const p = findPlaylist(u, decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'Playlist non trovata');
      const b = await readJson(req);
      const ids = trackIdsOf(b.trackIds);
      const pos = Number.isInteger(b.position) ? Math.max(0, Math.min(b.position, p.trackIds.length)) : p.trackIds.length;
      p.trackIds = [...p.trackIds.slice(0, pos), ...ids, ...p.trackIds.slice(pos)];
      p.updatedAt = Date.now();
      changedUser(srv, u, { edits: [[p.id, ['a', pos, ids]]] });
      sendJson(req, res, 200, { playlist: p }, userHeaders(srv, u));
    },
  ],
  [
    'DELETE',
    /^\/api\/playlists\/([^/]+)\/tracks$/,
    async (srv, req, res, m) => {
      const u = userOf(srv);
      const p = findPlaylist(u, decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'Playlist non trovata');
      const b = await readJson(req);
      if (!Array.isArray(b.indexes)) throw new HttpError(400, 'indexes deve essere una lista');
      // With the ids seen at each position (and their counts), the source's own rule.
      const ids = Array.isArray(b.ids) && b.ids.length === b.indexes.length && b.indexes.every((i) => Number.isInteger(i) && i >= 0) ? b.ids : null;
      const counts = ids && Array.isArray(b.counts) && b.counts.length === ids.length ? b.counts : null;
      const drop = ids ? removalSlots(p.trackIds, b.indexes, ids, counts) : new Set(b.indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < p.trackIds.length));
      if (drop.size) {
        p.trackIds = p.trackIds.filter((_, i) => !drop.has(i));
        p.updatedAt = Date.now();
        changedUser(srv, u, { edits: [[p.id, ['r', [...drop].sort((x, y) => x - y)]]] });
      }
      sendJson(req, res, 200, { playlist: p }, userHeaders(srv, u));
    },
  ],
  [
    'PATCH',
    /^\/api\/playlists\/([^/]+)$/,
    async (srv, req, res, m) => {
      const u = userOf(srv);
      const p = findPlaylist(u, decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'Playlist non trovata');
      const b = await readJson(req);
      if (b.name !== undefined) p.name = str(b.name, 'nome', { max: 100 });
      if (b.description !== undefined) p.description = str(b.description, 'descrizione', { allowEmpty: true });
      // With base (the list the order was made from), the order is applied to the list as it is now.
      if (b.trackIds !== undefined) p.trackIds = Array.isArray(b.base) && !srv.legacy ? rebaseOrder(p.trackIds, trackIdsOf(b.base), trackIdsOf(b.trackIds)) : trackIdsOf(b.trackIds);
      p.updatedAt = Date.now();
      changedUser(srv, u, { playlists: [p.id] });
      sendJson(req, res, 200, { playlist: p }, userHeaders(srv, u));
    },
  ],
  [
    'DELETE',
    /^\/api\/playlists\/([^/]+)$/,
    (srv, req, res, m) => {
      const u = userOf(srv);
      const id = decodeURIComponent(m[1]);
      if (!findPlaylist(u, id)) throw new HttpError(404, 'Playlist non trovata');
      u.playlists = u.playlists.filter((p) => p.id !== id);
      const hadCover = !!u.covers.playlist[id];
      delete u.covers.playlist[id];
      changedUser(srv, u, { removedPlaylists: [id], covers: hadCover ? [id] : [] });
      sendJson(req, res, 200, { ok: true }, userHeaders(srv, u));
    },
  ],
  [
    'PUT',
    /^\/api\/likes\/([^/]+)$/,
    (srv, req, res, m, url) => {
      const u = userOf(srv);
      const id = trackIdParam(m[1]);
      if (!u.likes.some((l) => l.id === id)) {
        u.likes.unshift({ id, at: Date.now() });
        changedUser(srv, u, { liked: [id] });
      }
      const brief = url.searchParams.get('brief') === '1' && !srv.legacy && !srv.oldLibrary;
      sendJson(req, res, 200, brief ? { ok: true } : { likes: u.likes }, userHeaders(srv, u));
    },
  ],
  [
    'DELETE',
    /^\/api\/likes\/([^/]+)$/,
    (srv, req, res, m, url) => {
      const u = userOf(srv);
      const id = trackIdParam(m[1]);
      const before = u.likes.length;
      u.likes = u.likes.filter((l) => l.id !== id);
      if (u.likes.length !== before) changedUser(srv, u, { unliked: [id] });
      const brief = url.searchParams.get('brief') === '1' && !srv.legacy && !srv.oldLibrary;
      sendJson(req, res, 200, brief ? { ok: true } : { likes: u.likes }, userHeaders(srv, u));
    },
  ],
  [
    // Many likes at once: the removes, then the adds in the given order (each the newest when
    // it is added), one version for the request.
    'POST',
    /^\/api\/likes$/,
    async (srv, req, res) => {
      if (srv.legacy || srv.oldLibrary) throw new HttpError(404, 'Risorsa non trovata');
      const b = await readJson(req);
      const list = (x) => x === undefined || Array.isArray(x);
      if (!b || typeof b !== 'object' || Array.isArray(b) || !list(b.add) || !list(b.remove)) throw NEED('bad_request');
      const add = b.add || [];
      const remove = b.remove || [];
      if (add.length + remove.length > BULK_LIKES) throw NEED('bad_request');
      for (const id of [...add, ...remove]) if (typeof id !== 'string' || !TRACK_ID.test(id)) throw new HttpError(400, 'Identificativo del brano non valido');
      const u = userOf(srv);
      const liked = new Set(u.likes.map((l) => l.id));
      const rm = new Set(remove.filter((id) => liked.has(id)));
      const adds = [...new Set(add)].filter((id) => rm.has(id) || !liked.has(id));
      if (liked.size - rm.size + adds.length > MAX_LIKES) throw NEED('too_many_likes');
      if (rm.size || adds.length) {
        const at = Date.now();
        const kept = rm.size ? u.likes.filter((l) => !rm.has(l.id)) : u.likes;
        u.likes = [...adds.map((id) => ({ id, at })).reverse(), ...kept];
        changedUser(srv, u, { unliked: [...rm], liked: adds });
      }
      sendJson(req, res, 200, { ok: true, added: adds.length, removed: rm.size }, userHeaders(srv, u));
    },
  ],
  [
    'POST',
    /^\/api\/played$/,
    async (srv, req, res) => {
      const u = userOf(srv);
      const b = await readJson(req);
      if (typeof b.trackId !== 'string' || !TRACK_ID.test(b.trackId)) throw new HttpError(400, 'Id di brano non valido');
      const types = ['playlist', 'album', 'artist', 'liked', 'library', 'search'];
      const c = b.context && types.includes(b.context.type) ? { type: b.context.type, id: b.context.id ?? null } : { type: 'library', id: null };
      const now = Date.now();
      const at = Number.isFinite(b.at) && b.at > now - 30 * 86400000 && b.at <= now + 60000 ? b.at : now;
      u.recents.unshift({ trackId: b.trackId, at, context: c });
      u.recents.sort((x, y) => y.at - x.at);
      u.recents.length = Math.min(u.recents.length, 50);
      changedUser(srv, u, { recents: true });
      sendJson(req, res, 200, { ok: true }, userHeaders(srv, u));
    },
  ],
  [
    'PUT',
    /^\/api\/cover-for\/([^/]+)\/([^/]+)$/,
    async (srv, req, res, m, url) => {
      const kind = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      const size = url.searchParams.get('size') === 'small' ? 'small' : 'large';
      if (!['track', 'album', 'playlist'].includes(kind)) throw new HttpError(400, 'Tipo non valido');
      if (!OPAQUE_ID.test(id)) throw new HttpError(400, 'Id non valido');
      if (kind === 'track') {
        const t = findTrack(srv, id);
        if (t && !mayTouch(srv, t)) throw NEED('forbidden');
      }
      if (kind === 'album' && !mayTouchAlbum(srv, id)) throw NEED('forbidden');
      if (kind === 'playlist' && !findPlaylist(userOf(srv), id)) throw new HttpError(404, 'Playlist non trovata');
      const buf = await readBody(req, MAX_COVER_BYTES);
      if (buf.length < 8 || !isImage(buf)) throw new HttpError(415, 'Immagine non valida');
      const coverId = sha24(buf);
      if (!covers.has(coverId)) covers.set(coverId, { buf, mime: buf[0] === 0xff ? 'image/jpeg' : 'image/png', sized: {} });
      const map = kind === 'playlist' ? userOf(srv).covers.playlist : srv.db.covers[kind];
      map[id] = { ...(map[id] || {}), [size]: coverId };
      if (kind === 'playlist') changedUser(srv, userOf(srv), { covers: [id] });
      else changedShared(srv, { covers: { [kind]: [id] } });
      sendJson(req, res, 200, { covers: coversView(srv) }, kind === 'playlist' ? userHeaders(srv) : sharedHeaders(srv));
    },
  ],
  [
    'DELETE',
    /^\/api\/cover-for\/([^/]+)\/([^/]+)$/,
    (srv, req, res, m) => {
      const kind = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!['track', 'album', 'playlist'].includes(kind)) throw new HttpError(400, 'Tipo non valido');
      if (kind === 'track') {
        const t = findTrack(srv, id);
        if (t && !mayTouch(srv, t)) throw NEED('forbidden');
      }
      if (kind === 'album' && !mayTouchAlbum(srv, id)) throw NEED('forbidden');
      const map = kind === 'playlist' ? userOf(srv).covers.playlist : srv.db.covers[kind];
      if (map[id]) {
        delete map[id];
        if (kind === 'playlist') changedUser(srv, userOf(srv), { covers: [id] });
        else changedShared(srv, { covers: { [kind]: [id] } });
      }
      sendJson(req, res, 200, { covers: coversView(srv) }, kind === 'playlist' ? userHeaders(srv) : sharedHeaders(srv));
    },
  ],
  [
    'GET',
    /^\/api\/profile$/,
    (srv, req, res) => {
      if (srv.legacy) throw new HttpError(404, 'Risorsa non trovata');
      const p = device.profile;
      const rec = p ? srv.profiles.get(p.id) : null;
      const blob = p ? srv.recovery.get(p.id)?.devices[CLIENT_KEY] : null;
      sendJson(req, res, 200, { profileId: p?.id || null, name: rec?.name || '', nameUpdatedAt: rec?.nameUpdatedAt || 0, role: roleOn(srv), recovery: blob ? { updatedAt: blob.updatedAt } : null, source: { ...sourceView(srv), ownerProfileId: srv.ownerProfileId } });
    },
  ],
  [
    'PATCH',
    /^\/api\/admin\/source$/,
    async (srv, req, res) => {
      if (srv.legacy) throw new HttpError(404, 'Risorsa non trovata');
      if (roleOn(srv) !== 'owner') throw NEED('forbidden');
      const b = await readJson(req);
      const hasName = b && b.name !== undefined;
      const hasDetails = b && b.details !== undefined;
      if ((!hasName && !hasDetails) || (hasDetails && typeof b.details !== 'boolean')) throw NEED('bad_request');
      if (hasDetails && srv.detailsFail) throw new HttpError(500, 'Errore interno');
      if (hasName) {
        srv.name = cleanName(b.name);
        srv.named = true;
      }
      if (hasDetails) srv.details = b.details;
      changedShared(srv, {});
      sendJson(req, res, 200, { source: { name: srv.name, named: srv.named, details: typeof srv.details === 'boolean' ? srv.details : true } });
    },
  ],
  ['GET', /^\/api\/admin\/code$/, (srv, req, res) => sendJson(req, res, 200, { code: showCode(srv.code) })],
  // The memory card of the source (MOCK_CARD: found, use, moving, full, readonly, away, leaving,
  // other, bad; unset: none), and the owner's three choices.
  ['GET', /^\/api\/admin\/storage$/, (srv, req, res) => sendJson(req, res, 200, storageView(srv))],
  [
    'PUT',
    /^\/api\/admin\/storage$/,
    async (srv, req, res) => {
      const b = await readJson(req);
      if (b && typeof b.use === 'string') srv.card = 'use';
      else if (b && b.leave === true) srv.card = 'leaving';
      else if (b && b.forget === true) srv.card = 'none';
      else throw NEED('bad_request');
      sendJson(req, res, 200, storageView(srv));
    },
  ],
  [
    'POST',
    /^\/api\/admin\/code\/rotate$/,
    (srv, req, res) => {
      if (roleOn(srv) === 'member') throw NEED('forbidden');
      srv.code = makeCode(`mpfy-mock-rotate-${crypto.randomBytes(8).toString('hex')}`);
      sendJson(req, res, 200, { code: showCode(srv.code) });
    },
  ],
  [
    'GET',
    /^\/api\/admin\/clients$/,
    (srv, req, res) => {
      const member = roleOn(srv) === 'member';
      const list = srv.clients.filter((c) => !member || c.profileId === actor() || c.publicKey === CLIENT_KEY);
      sendJson(req, res, 200, {
        clients: list.map((c) => ({
          publicKey: c.publicKey,
          name: c.name,
          addedAt: c.addedAt,
          connected: c.connected,
          you: c.publicKey === CLIENT_KEY,
          ...(srv.legacy ? {} : { profileId: c.profileId || null, profileName: c.profileId ? srv.profiles.get(c.profileId)?.name || null : null, legacy: !!c.legacy }),
        })),
      });
    },
  ],
  [
    'DELETE',
    /^\/api\/admin\/clients\/([^/]+)$/,
    (srv, req, res, m) => {
      const raw = decodeURIComponent(m[1]);
      const key = raw === 'self' ? CLIENT_KEY : raw;
      const c = srv.clients.find((x) => x.publicKey === key);
      if (!c) throw new HttpError(404, 'Dispositivo sconosciuto');
      if (roleOn(srv) === 'member' && key !== CLIENT_KEY && c.profileId !== actor()) throw NEED('forbidden');
      srv.clients = srv.clients.filter((x) => x.publicKey !== key);
      for (const r of srv.recovery.values()) delete r.devices[key];
      sendJson(req, res, 200, { ok: true });
    },
  ],
  [
    'PUT',
    /^\/api\/recovery$/,
    (srv, req, res) => {
      const p = device.profile;
      if (!p) throw NEED('no_profile');
      if (!srv.recovery.has(p.id)) srv.recovery.set(p.id, { devices: {}, failures: [], lockedUntil: 0, locks: 0 });
      srv.recovery.get(p.id).devices[CLIENT_KEY] = { deviceName: 'PC', updatedAt: device.recoveryUpdatedAt };
      sendJson(req, res, 200, { ok: true, updatedAt: device.recoveryUpdatedAt });
    },
  ],
];

// ---------------------------------------------------------------------------------------------
// the songs part of a source (social 3): comments on tracks and their lyrics
//
// Comments: per track, newest first, ONE per author (a newer `at` replaces the author's comment
// and keeps its first id; the same id again with no newer time is answered as it is), at most
// 1,000 per track (the oldest goes), 20 writes a minute per profile (then 429 slow_down with
// retryAt). Hidden from the caller: authors they blocked, and authors made invisible here
// (/__mock/songs?invisible=<profileId>, served to the author only). The owner deletes any; a
// member only their own (403 forbidden). An id belongs to its author and to its track: another
// author's, or the author's own on another track, is 400 bad_comment. GET answers with an ETag
// "k<16 hex>" and 304, as the source does.
// Lyrics: { kind: 'synced', lines } or { kind: 'plain', text } per track (instrumental: kept,
// never served); the library's track gains `lyrics` (synced or plain) only from a source at 3,
// and a change of it moves the library version. PUT takes an .lrc or a text (64 KB at most, a
// text with no time tag is plain), ?beside=1 keeps it only when the track has no synced lyrics;
// rights as track edits (403 forbidden), an unknown track 404 version_gone; GET ETag "y<16 hex>".
// Every line of lyrics here is invented: no real song's words.

const COMMENT_CAP = 1000;
const COMMENT_WRITES = 20;
const LYRICS_MAX = 65536;
const LYRICS_LINES = 2000;
const HEX32 = /^[0-9a-f]{32}$/;

function newSongs() {
  return { gets: [], posts: [], deletes: [], lyricsGets: [], lyricsPuts: [], lyricsDeletes: [], writes: [], failPosts: 0, getMs: 0, postMs: 0, invisible: [] };
}

/** The lyrics of one source's track, or null. */
const lyricsOf = (srv, id) => (srv.lyrics && srv.lyrics.get(id)) || null;
/** What the library says of them: synced, plain, or nothing (none, instrumental, removed). */
const lyricsFlag = (srv, id) => {
  const l = lyricsOf(srv, id);
  return l && (l.kind === 'synced' || l.kind === 'plain') ? l.kind : null;
};

/** An LRC text as lines ({ t, text }): the time tags of every form, [offset:], word times out. */
function parseLrc(text) {
  let offset = 0;
  const lines = [];
  const rows = String(text).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  for (const raw of rows) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i.exec(raw);
    if (off) {
      offset = Number(off[1]);
      continue;
    }
    const times = [];
    let rest = raw;
    for (;;) {
      const m = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest);
      if (!m) break;
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      times.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue;
    const words = Array.from(rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim()).slice(0, 500).join('');
    for (const t of times) lines.push({ t, text: words });
  }
  return lines
    .map((l, i) => ({ t: Math.max(0, l.t - offset), text: l.text, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ t, text: w }) => ({ t, text: w }));
}

const hasTimeTag = (text) => /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text);

function lyricsView(srv, id) {
  const l = lyricsOf(srv, id);
  return l.kind === 'synced' ? { trackId: id, kind: 'synced', lines: l.lines, from: l.from } : { trackId: id, kind: 'plain', text: l.text, from: l.from };
}

/** The songs routes exist on a source at 3, for a caller with a profile. */
const songsOn = (srv) => {
  if (socialOf(srv) < 3) throw new HttpError(404, 'Risorsa non trovata');
  if (!device.profile) throw NEED('no_profile');
};

/** What a caller sees of a track's comments: not those of authors they blocked, nor of invisible ones (but their own). */
function commentsSeen(srv, id) {
  const me = actor();
  const blocked = device.chat ? device.chat.blocked : [];
  return (srv.comments.get(id) || []).filter((c) => !blocked.includes(c.from) && (c.from === me || !device.songs.invisible.includes(c.from)));
}

function authorName(srv, pid) {
  if (device.profile && pid === device.profile.id) return device.profile.name;
  const x = device.social.people.find((y) => y.id === pid);
  return x ? x.name : (srv.profiles.get(pid) && srv.profiles.get(pid).name) || 'Qualcuno';
}

const commentOut = (srv, c) => ({ id: c.id, trackId: c.trackId, from: c.from, name: authorName(srv, c.from), at: c.at, text: c.text });

/** 20 comment writes a minute per profile; beyond, 429 with the time it may write again. */
function slowDown(now) {
  const s = device.songs;
  s.writes = s.writes.filter((t) => t > now - 60000);
  if (s.writes.length >= COMMENT_WRITES) throw new HttpError(429, 'Troppe richieste, riprova tra poco', 'slow_down', { retryAt: s.writes[0] + 60000 });
  s.writes.push(now);
}

/** May the caller change this track's lyrics: the owner, or a member on a track of theirs. */
function lyricsRights(srv, id) {
  const t = findTrack(srv, id);
  if (!t) throw NEED('version_gone');
  if (!mayTouch(srv, t)) throw NEED('forbidden');
  return t;
}

routes.push(
  [
    'GET',
    /^\/api\/comments$/,
    async (srv, req, res, m, url) => {
      songsOn(srv);
      const ids = String(url.searchParams.get('tracks') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 20 || ids.some((x) => !TRACK_ID.test(x))) throw NEED('bad_request');
      if (device.songs.getMs) await sleep(device.songs.getMs);
      const list = ids
        .filter((id) => findTrack(srv, id))
        .flatMap((id) => commentsSeen(srv, id))
        .sort((a, b) => b.at - a.at)
        .map((c) => commentOut(srv, c));
      const body = { comments: list };
      const tag = `"k${sha(JSON.stringify(body)).slice(0, 16)}"`;
      const same = etagMatches(req.headers['if-none-match'], tag);
      device.songs.gets.push({ at: Date.now(), source: srv.id, tracks: ids, notModified: same });
      if (same) {
        res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(req, res, 200, body, { ETag: tag });
    },
  ],
  [
    'POST',
    /^\/api\/comments$/,
    async (srv, req, res) => {
      songsOn(srv);
      const b = await readJson(req);
      device.songs.posts.push({ at: Date.now(), source: srv.id, body: b });
      if (device.songs.postMs) await sleep(device.songs.postMs);
      const now = Date.now();
      if (device.songs.failPosts > 0) {
        device.songs.failPosts--;
        throw new HttpError(500, 'Errore interno');
      }
      if (!b || typeof b !== 'object' || !HEX32.test(b.id || '') || !TRACK_ID.test(b.trackId || '')) throw new HttpError(400, 'Commento non valido', 'bad_comment');
      if (!Number.isInteger(b.at) || b.at > now + 300000 || b.at < now - 30 * 86400000) throw new HttpError(400, 'Momento non valido', 'bad_time');
      const text = cleanNoteText(b.text);
      if (!text || points(text) > 300) throw new HttpError(400, 'Commento non valido', 'bad_comment');
      if (!findTrack(srv, b.trackId)) throw NEED('version_gone');
      const me = actor();
      for (const list of srv.comments.values()) if (list.some((c) => c.id === b.id && (c.from !== me || c.trackId !== b.trackId))) throw new HttpError(400, 'Commento non valido', 'bad_comment');
      slowDown(now);
      const list = srv.comments.get(b.trackId) || [];
      const own = list.find((c) => c.from === me);
      if (own) {
        // One per author: a newer one replaces it (its first id stays); the same again is answered as it is.
        if (b.at > own.at) Object.assign(own, { at: b.at, text });
        srv.comments.set(b.trackId, list.sort((x, y) => y.at - x.at));
        sendJson(req, res, 200, { comment: commentOut(srv, own) });
        return;
      }
      const c = { id: b.id, trackId: b.trackId, from: me, at: b.at, text };
      srv.comments.set(b.trackId, [c, ...list].sort((x, y) => y.at - x.at).slice(0, COMMENT_CAP));
      sendJson(req, res, 201, { comment: commentOut(srv, c) });
    },
  ],
  [
    'DELETE',
    /^\/api\/comments\/([^/]+)$/,
    (srv, req, res, m) => {
      songsOn(srv);
      const id = decodeURIComponent(m[1]);
      device.songs.deletes.push({ at: Date.now(), source: srv.id, id });
      for (const [tid, list] of srv.comments) {
        const c = list.find((x) => x.id === id);
        if (!c) continue;
        if (c.from !== actor() && roleOn(srv) !== 'owner') throw NEED('forbidden');
        srv.comments.set(tid, list.filter((x) => x !== c));
        sendJson(req, res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, 'Commento non trovato', 'comment_gone');
    },
  ],
  [
    'GET',
    /^\/api\/lyrics\/([^/]+)$/,
    (srv, req, res, m) => {
      songsOn(srv);
      const id = decodeURIComponent(m[1]);
      const kind = findTrack(srv, id) ? lyricsFlag(srv, id) : null;
      const seen = { at: Date.now(), source: srv.id, id, found: !!kind, notModified: false };
      device.songs.lyricsGets.push(seen);
      if (!kind) throw new HttpError(404, 'Testo non trovato', 'no_lyrics');
      const body = lyricsView(srv, id);
      const tag = `"y${sha(JSON.stringify(body)).slice(0, 16)}"`;
      if (etagMatches(req.headers['if-none-match'], tag)) {
        seen.notModified = true;
        res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(req, res, 200, body, { ETag: tag });
    },
  ],
  [
    'PUT',
    /^\/api\/lyrics\/([^/]+)$/,
    async (srv, req, res, m, url) => {
      songsOn(srv);
      const id = decodeURIComponent(m[1]);
      const beside = url.searchParams.get('beside') === '1';
      let buf;
      try {
        buf = await readBody(req, LYRICS_MAX);
      } catch {
        throw new HttpError(400, 'Testo non valido', 'bad_lyrics');
      }
      const text = buf.toString('utf8');
      device.songs.lyricsPuts.push({ at: Date.now(), source: srv.id, id, beside, bytes: buf.length, type: req.headers['content-type'] || '' });
      lyricsRights(srv, id);
      let next;
      if (hasTimeTag(text)) {
        const lines = parseLrc(text);
        if (!lines.length || lines.length > LYRICS_LINES) throw new HttpError(400, 'Testo non valido', 'bad_lyrics');
        next = { kind: 'synced', lines, from: 'lrc' };
      } else {
        const plain = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim();
        if (!plain || plain.split('\n').length > LYRICS_LINES) throw new HttpError(400, 'Testo non valido', 'bad_lyrics');
        next = { kind: 'plain', text: plain, from: 'lrc' };
      }
      const had = lyricsOf(srv, id);
      // Beside its song in a folder: never over synced lyrics.
      if (!(beside && had && had.kind === 'synced')) {
        srv.lyrics.set(id, next);
        changedShared(srv, { tracks: [id] });
      }
      sendJson(req, res, 200, lyricsView(srv, id), sharedHeaders(srv));
    },
  ],
  [
    'DELETE',
    /^\/api\/lyrics\/([^/]+)$/,
    (srv, req, res, m) => {
      songsOn(srv);
      const id = decodeURIComponent(m[1]);
      device.songs.lyricsDeletes.push({ at: Date.now(), source: srv.id, id });
      lyricsRights(srv, id);
      srv.lyrics.set(id, { kind: null, removed: true });
      changedShared(srv, { tracks: [id] });
      sendJson(req, res, 200, { ok: true }, sharedHeaders(srv));
    },
  ]
);

/** Invented lines, one every `step` seconds from `start`. */
function timed(words, start, step) {
  return words.map((text, i) => ({ t: Math.round((start + i * step) * 1000), text }));
}

const LUCE = ['Lascio il molo al buio', 'rosso a sinistra', 'verde a destra', 'non chiedo dove vado', 'basta che tu mi veda', 'Luce di posizione', 'resta accesa stanotte', 'piccola nella corrente', 'sono qui, sono qui', 'ogni faro ha un nome', 'ogni barca un filo', 'tienimi nella rotta', 'finché non torno a riva'];
const GUARDIANO = ['Sale la scala a chiocciola', 'conta i gradini a memoria', '', 'la lampada gira e gira', 'disegna il mare a fette', 'nessuno lo saluta', 'ma tutti lo guardano', 'quando la notte è nera'];
const FREQUENZE = ['Giro la manopola piano', 'cerco una voce nel fruscio', 'onde che vanno e vengono', 'una stazione lontana', 'parla di un posto di mare', 'resto in ascolto'];
const CITTA = 'Strade bianche di sale\ncase basse contro il vento\n\nil porto dorme a mezzogiorno\ne le barche aspettano la sera\nnessuno corre, nessuno chiama\nsolo il mare che tiene il tempo';

/**
 * The sample's comments and lyrics. "Luce di posizione": four comments on the Mi A2 version, two
 * on the VPS copy, synced lyrics on the Mi A2. "Il guardiano del faro": synced lyrics only on the
 * VPS copy (a few items later: the offset applies). "Citta' di sale": plain lyrics. "Frequenze"
 * (the same file on both): Giulia's comment held by both under one id, one more on each, synced
 * lyrics on the VPS only. "Cassiopea": an instrumental (no card).
 */
function seedSongs(mi, vps) {
  const now = Date.now();
  for (const s of [mi, vps]) {
    s.comments = new Map();
    s.lyrics = new Map();
  }
  device.songs = newSongs();
  const luce = catalog[0];
  const luceCopy = sha24(`mpfy-mock-copy-${luce.rec}`);
  const guardianoCopy = sha24(`mpfy-mock-copy-${catalog[1].rec}`);
  const cid = (k) => sha(`mpfy-mock-comment-${k}`).slice(0, 32);
  const c = (k, trackId, from, minutesAgo, text) => ({ id: cid(k), trackId, from, at: now - minutesAgo * 60000, text });
  mi.comments.set(luce.id, [
    c('marco-luce', luce.id, MARCO_ID, 12, "l'ascolto da una settimana \u{1F30A}"),
    c('giulia-luce', luce.id, SIS_ID, 60, 'in macchina di notte è perfetta'),
    c('sara-luce', luce.id, SARA_ID, 26 * 60, "mi ricorda l'estate al mare"),
    c('chiara-luce', luce.id, CHIARA_ID, 27 * 60, 'il finale!'),
  ]);
  vps.comments.set(luceCopy, [c('luca-luce', luceCopy, LUCA_ID, 4 * 1440, "la voce all'inizio, che bella"), c('giulia2-luce', luceCopy, GIULIA2_ID, 4 * 1440 + 30, 'finalmente qualcuno che la conosce')]);
  const freq = catalog[7 * 5];
  const shared = c('giulia-freq', freq.id, SIS_ID, 90, 'questa la metto sempre');
  mi.comments.set(freq.id, [{ ...shared }, c('marco-freq', freq.id, MARCO_ID, 200, 'il ritornello resta in testa')]);
  vps.comments.set(freq.id, [{ ...shared }, c('luca-freq', freq.id, LUCA_ID, 300, 'perfetta per guidare')]);
  mi.lyrics.set(luce.id, { kind: 'synced', lines: timed(LUCE, 6, 9.5), from: 'tag' });
  vps.lyrics.set(guardianoCopy, { kind: 'synced', lines: timed(GUARDIANO, 5, 11), from: 'lrc' });
  mi.lyrics.set(catalog[5].id, { kind: 'plain', text: CITTA, from: 'tag' });
  vps.lyrics.set(freq.id, { kind: 'synced', lines: timed(FREQUENZE, 4, 12), from: 'lrclib' });
  mi.lyrics.set(catalog[2 * 5 + 1].id, { kind: 'instrumental', from: 'lrclib' });
}

async function handleSource(srv, req, res, rest, url) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const candidates = routes.filter(([, re]) => re.test(rest));
  if (!candidates.length) throw new HttpError(404, 'Risorsa non trovata');
  const route = candidates.find(([m]) => m === method);
  if (!route) throw new HttpError(405, 'Metodo non consentito');
  const isMedia = /^\/api\/(stream|cover|upload|uploads)\b/.test(rest);
  const wait = srv.rttMs + (isMedia ? 0 : DELAY);
  if (wait > 0) await sleep(wait);
  bind(srv);
  await route[2](srv, req, res, rest.match(route[1]), url);
}

// ---------------------------------------------------------------------------------------------
// the client core: /local/... and /s/<id>/...

/** The role and name the core keeps for a source (null while the first sync is still running). */
function entryJson(p) {
  const srv = servers.get(p.id);
  const up = !!srv?.connected;
  const jitter = up ? Math.round(srv.rttMs * (0.9 + Math.random() * 0.2)) : null;
  const known = !p.roleAt || Date.now() >= p.roleAt;
  return {
    id: p.id,
    name: srv?.name || p.id,
    principal: p.principal,
    connected: up,
    rttMs: jitter,
    throughputKbps: up ? srv.throughputKbps : null,
    lastError: up ? null : 'Fonte non raggiungibile',
    addedAt: p.addedAt,
    role: srv && known ? roleOn(srv) : null,
    named: srv && known && !srv.legacy ? srv.named : null,
    profiles: srv && known ? !srv.legacy : null,
    social: srv && known ? socialOf(srv) : null,
  };
}

const PROFILE_BODY = 56;
/** The mock's own profile codes: 51 characters and a 5 character check. */
function profileCodeOf(secretHex) {
  const body = Array.from(crypto.createHash('sha512').update(`body:${secretHex}`).digest()).slice(0, 51).map((b) => B32[b & 31]).join('');
  const check = Array.from(crypto.createHash('sha256').update(`check:${body}`).digest()).slice(0, 5).map((b) => B32[b & 31]).join('');
  const all = body + check;
  return `MPFY-P-${all.match(/.{4}/g).join('-')}`;
}
function parseProfileCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[\s\-_]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length === 36 || s.length === 32) return { kind: 'source' };
  const body = s.length === 61 && s.startsWith('MPFYP') ? s.slice(5) : s;
  if (body.length !== PROFILE_BODY || /[^0-9A-HJKMNP-TV-Z]/.test(body)) return { kind: 'bad' };
  const check = Array.from(crypto.createHash('sha256').update(`check:${body.slice(0, 51)}`).digest()).slice(0, 5).map((b) => B32[b & 31]).join('');
  return body.slice(51) === check ? { kind: 'profile', body } : { kind: 'bad' };
}

const localError = (status, code, error, extra = {}) => new HttpError(status, error, code, extra);
const sourcesOut = () => ({ sources: paired.map(entryJson), ...(phone ? { phone: phoneEntry() } : {}) });

// "Locale" at /s/0000/...: the library, covers, lyrics, streams (a PC "Locale" plays the file),
// the switch, and the person's routes while the phone's store is the home (forwarded as they came
// to the home once a real source is it). Anything else a source answers is not there.
const PHONE_PERSON = /^\/api\/(playlists|likes|played|recents|cover-for\/playlist)(\/|$)/;
const PHONE_OWN = /^\/api\/(library|stream\/[^/]+|cover\/[^/]+|playlists(\/.*)?|likes(\/[^/]+)?|played|recents|cover-for\/playlist\/[^/]+)$/;
async function phoneRoute(req, res, rest, url) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (PHONE_PERSON.test(rest) && phoneHome() !== PHONE_ID) {
    const to = servers.get(phoneHome());
    if (!to?.connected) throw new HttpError(503, 'Fonte non raggiungibile');
    phone.forwarded = (phone.forwarded || 0) + 1;
    return handleSource(to, req, res, rest, url);
  }
  const ly = /^\/api\/lyrics\/([^/]+)$/.exec(rest);
  if (ly && method === 'GET') {
    if (DELAY > 0) await sleep(DELAY);
    const id = decodeURIComponent(ly[1]);
    if (!findTrack(phone, id) || !lyricsFlag(phone, id)) throw new HttpError(404, 'Testo non trovato', 'no_lyrics');
    const body = lyricsView(phone, id);
    const tag = `"y${sha(JSON.stringify(body)).slice(0, 16)}"`;
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' });
      res.end();
      return undefined;
    }
    return sendJson(req, res, 200, body, { ETag: tag });
  }
  if (rest === '/api/admin/source' && method === 'PATCH') {
    const b = await readJson(req);
    if (!b || typeof b.details !== 'boolean' || Object.keys(b).some((k) => k !== 'details')) throw NEED('bad_request');
    phone.details = b.details;
    changedShared(phone, {});
    return sendJson(req, res, 200, { source: { name: 'Locale', named: true, details: phone.details } }, sharedHeaders(phone));
  }
  if (!PHONE_OWN.test(rest)) throw new HttpError(404, 'Risorsa non trovata');
  return handleSource(phone, req, res, rest, url);
}

/** The phone's tracks as the permission leaves them: none while it is off or the first scan runs. */
function phoneState(state) {
  phone.state = state;
  const want = state === 'ready' ? phone.all : [];
  const have = new Set(phone.db.tracks.map((t) => t.id));
  const keep = new Set(want.map((t) => t.id));
  const removed = [...have].filter((id) => !keep.has(id));
  const added = want.filter((t) => !have.has(t.id)).map((t) => t.id);
  phone.db.tracks = want.slice();
  if (removed.length || added.length) changedShared(phone, { tracks: added, removed });
}
const fileNameOf = (name) => `${(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().replace(/^\.+/, '').slice(0, 60) || 'MPfy'}.mpfy`;
const localProfile = () => (device.profile ? { id: device.profile.id, pid: pidOf(device.profile.id), name: device.profile.name, nameUpdatedAt: device.profile.nameUpdatedAt, photo: device.photo ? device.photo.hash : null } : null);
const MAX_PHOTO = 48 * 1024;
/** A JPEG as the core takes it: 1 to 48 KB, FF D8 FF in front, FF D9 at the end. */
const validPhoto = (b) => b.length >= 1 && b.length <= MAX_PHOTO && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

function identity() {
  const p = device.profile;
  return {
    format: 'mpfy-identity',
    v: 1,
    profile: { id: p.id, secret: device.secret, name: p.name, nameUpdatedAt: p.nameUpdatedAt },
    clientSeed: sha('mpfy-mock-client-seed'),
    sources: paired.map((x) => ({ id: x.id, name: servers.get(x.id)?.name || x.id, serverPublicKey: servers.get(x.id)?.publicKey, principal: x.principal, addedAt: x.addedAt })),
    recovery: null,
    exportedAt: Date.now(),
  };
}

/** After an identity change every source hears it (bindings, names, recovery blobs). */
function syncAll() {
  for (const p of paired) {
    const srv = servers.get(p.id);
    if (!srv?.connected) continue;
    bind(srv);
    if (device.profile) {
      const r = srv.recovery.get(device.profile.id);
      if (device.recovery) {
        if (!r) srv.recovery.set(device.profile.id, { devices: {}, failures: [], lockedUntil: 0, locks: 0 });
        srv.recovery.get(device.profile.id).devices[CLIENT_KEY] = { deviceName: 'PC', updatedAt: device.recoveryUpdatedAt };
      } else if (r) delete r.devices[CLIENT_KEY];
    }
  }
}

let newSeed = 10;
async function addSource(req, res) {
  const b = await readJson(req);
  const kind = parseProfileCode(b.code);
  const body = parseCode(b.code);
  if (!body) {
    if (kind.kind === 'profile') throw localError(400, 'profile_code', 'Questo e il codice del profilo');
    throw localError(400, 'bad_code', 'Codice non valido');
  }
  await sleep(PAIR_DELAY);
  if (/^0+$/.test(body)) throw localError(504, 'unreachable', 'Fonte non raggiungibile');
  let srv = [...servers.values()].find((s) => s.code === body);
  if (!srv) srv = [...servers.values()].find((s) => !paired.some((p) => p.id === s.id));
  if (!srv) {
    const seed = newSeed++;
    srv = makeServer({ seed, name: `Nuova fonte ${seed - 9}`, albums: [], rttMs: 70, linkKbps: 5000, diskFreeBytes: Math.round(9.5 * 1024 ** 3), owner: device.profile?.id || null, named: false });
    srv.clients = [];
    srv.recovery = new Map();
    srv.code = body;
    servers.set(srv.id, srv);
  }
  const existing = paired.find((p) => p.id === srv.id);
  if (existing) return sendJson(req, res, 200, { source: entryJson(existing) });
  if (!srv.clients.some((c) => c.publicKey === CLIENT_KEY)) srv.clients.push({ publicKey: CLIENT_KEY, name: 'PC', addedAt: Date.now(), connected: true, profileId: null, legacy: false });
  const entry = { id: srv.id, principal: paired.length === 0, addedAt: Date.now(), roleAt: device.roleDelay ? Date.now() + device.roleDelay : 0 };
  paired.push(entry);
  bind(srv);
  syncAll();
  sendJson(req, res, 201, { source: entryJson(entry) });
}

// ---------------------------------------------------------------------------------------------
// the people of the sources (the client core's union of every social source)

// The people of the sample, by profileId (their profile IDs in the comments). Two Giulia (their
// IDs follow the name), a second Bacca (yours follows his), someone seen only in a chat (never in
// Amici), someone playing a song this library has under another id (found by title and artist).
const GIULIA2_ID = 'c3b1e5a7d9f20468ace13579bdf02468'; // RERY-B9YS
const MARCO_ID = '6d4a1f0c2e3b5a7988c1d2e3f4051627'; // DN51-Y31E
const SARA_ID = '8a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d'; // H8NM-RVCE
const LUCA_ID = 'b1c2d3e4f5061728394a5b6c7d8e9f00'; // P71D-7S7N
const CHIARA_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'; // 1WF2-TF2B, seen in a chat only
const BACCA2_ID = '2a3b4c5d6e7f80910a1b2c3d4e5f6071'; // 58XM-RQBE
// SIS_ID (Giulia, the owner of the VPS) is MZ0Y-1MNK; ME_ID (you, Bacca) 4BF2-ASGW.
const SOCIAL_FIELDS = ['invisible', 'showNow', 'privateSession', 'showRecent'];

/** The profile ID of a profileId: its first 40 bits as 8 Crockford base32 digits. */
function pidOf(id) {
  let n = BigInt(`0x${id.slice(0, 10)}`);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = B32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A track of the catalog as an activity names it. */
function played(ai, ti, at, extra = {}) {
  const t = catalog[ai * 5 + ti];
  return { trackId: t.id, title: t.title, artist: t.artist, album: t.album, at, ...extra };
}

function newSocial() {
  const now = Date.now();
  const mi = [...servers.values()].find((s) => s.name === 'Mi A2');
  const vps = [...servers.values()].find((s) => s.name === 'VPS prova');
  const photo = (seed, c1, c2) => {
    const buf = makeCover(c1, c2, seed, 160);
    return { hash: sha(buf), bytes: buf };
  };
  const giuliaPhoto = photo(91, [112, 54, 74], [230, 150, 190]);
  const saraPhoto = photo(92, [150, 80, 20], [250, 190, 90]);
  const unknown = (title, artist, at) => ({ trackId: sha24(`mpfy-mock-elsewhere-${title}`), title, artist, album: '', at });
  const people = [
    {
      id: SIS_ID,
      name: 'Giulia',
      photo: giuliaPhoto,
      seen: 'all',
      sources: [mi.id, vps.id],
      now: played(7, 1, now - 20000),
      last: played(2, 0, now - 2 * 3600000),
      recent: [played(7, 1, now - 20000), played(3, 0, now - 3600000, { artistPage: true }), unknown('Voce sola', 'Nessuno qui', now - 5000000), played(2, 0, now - 2 * 3600000), played(7, 2, now - 3 * 3600000)],
    },
    { id: GIULIA2_ID, name: 'Giulia', photo: null, seen: 'all', sources: [vps.id], now: null, last: unknown('Canto lontano', 'Voce sola', now - 26 * 3600000), recent: [unknown('Canto lontano', 'Voce sola', now - 26 * 3600000)] },
    // Marco plays a song this library holds under another trackId: found by its title and artist.
    { id: MARCO_ID, name: 'Marco', photo: null, seen: 'all', sources: [mi.id], now: { ...unknown('Stella polare', 'Orsa Minore', now - 40000), album: 'Costellazioni' }, last: null, recent: [] },
    { id: SARA_ID, name: 'Sara', photo: saraPhoto, seen: 'all', sources: [mi.id], now: null, last: played(4, 1, now - 3 * 86400000), recent: [played(4, 1, now - 3 * 86400000)] },
    { id: LUCA_ID, name: 'Luca', photo: null, seen: 'all', sources: [vps.id], now: null, last: null, recent: [] },
    { id: CHIARA_ID, name: 'Chiara', photo: null, seen: 'chat', sources: [mi.id], now: null, last: null, recent: [] },
    { id: BACCA2_ID, name: 'Bacca', photo: null, seen: 'all', sources: [vps.id], now: null, last: played(10, 0, now - 2 * 3600000 - 60000), recent: [played(10, 0, now - 2 * 3600000 - 60000)] },
  ];
  return {
    on: true, // every source with profiles speaks the people part (social 1)
    privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 },
    people,
    patchFail: 0,
    peopleMs: 0,
    peopleGets: 0,
    patches: [],
    activity: [],
    recentsOff: false,
    recentsGets: [],
  };
}

/** sendJson, saying the request was answered. */
function answered(req, res, status, obj) {
  sendJson(req, res, status, obj);
  return true;
}

/** What a source speaks of the social part: 3 (songs), 2 (chats), 1 (people only), 0 (none, or a source without profiles). */
const socialOf = (srv) => (!srv || srv.legacy ? 0 : device.social.on ? Math.min(device.chat ? device.chat.level : 1, srv.socialMax == null ? 3 : srv.socialMax) : 0);
const socialOn = () => paired.some((p) => socialOf(servers.get(p.id)) >= 1);
const privateNow = () => device.social.privacy.privateUntil > Date.now();
const samName = (a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }) === 0;

/** The people the core lists now: on a paired social source; the tag where a name clashes, yours included. */
function peopleNow() {
  const on = new Set(paired.filter((p) => socialOf(servers.get(p.id)) >= 1).map((p) => p.id));
  const list = device.social.people.filter((x) => x.sources.some((s) => on.has(s)));
  const names = [...list.map((x) => x.name), device.profile?.name || ''];
  const clash = (name) => names.filter((n) => n && samName(n, name)).length > 1;
  return list.map((x) => ({
    id: x.id,
    pid: pidOf(x.id),
    name: x.name,
    tag: clash(x.name) ? pidOf(x.id).slice(0, 4) : null,
    photo: x.photo ? x.photo.hash : null,
    seen: x.seen,
    blocked: !!device.chat && device.chat.blocked.includes(x.id),
    chat: sha(`chat:${[x.id, device.profile?.id || ''].sort().join('')}`).slice(0, 32),
    sources: x.sources.filter((s) => on.has(s)),
    now: x.seen === 'all' && x.now ? { trackId: x.now.trackId, title: x.now.title, artist: x.now.artist, album: x.now.album, at: x.now.at } : null,
    last: x.seen === 'all' && x.last ? { trackId: x.last.trackId, title: x.last.title, artist: x.last.artist, album: x.last.album, at: x.last.at, artistPage: x.last.artistPage === true } : null,
  }));
}

/** You as the others see you: what the page's own reports said, as your settings allow. */
function meAsOthers() {
  const p = device.profile;
  const s = device.social;
  const hidden = s.privacy.invisible;
  const quiet = hidden || privateNow();
  const reports = s.activity.filter((a) => a.body.track && a.body.playing);
  const lastReport = s.activity[s.activity.length - 1];
  const nowT = !quiet && s.privacy.showNow && lastReport && lastReport.body.playing && lastReport.body.track ? { ...lastReport.body.track, at: lastReport.at } : null;
  const recent = [];
  if (!quiet && s.privacy.showRecent) {
    for (const a of [...reports].reverse()) {
      if (recent.some((r) => r.trackId === a.body.track.trackId)) continue;
      recent.push({ ...a.body.track, at: a.at });
      if (recent.length >= 20) break;
    }
  }
  const names = peopleNow().map((x) => x.name);
  const tag = names.some((n) => samName(n, p.name)) ? pidOf(p.id).slice(0, 4) : null;
  return {
    person: { id: p.id, pid: pidOf(p.id), name: p.name, tag, photo: device.photo ? device.photo.hash : null, seen: 'all', blocked: false, chat: null, sources: hidden ? [] : paired.map((x) => x.id), now: hidden ? null : nowT, last: hidden ? null : recent[0] || null, hidden },
    recent: hidden ? [] : recent,
  };
}

/** /local/people and /local/people/<id>[/photo]; null when p is none of them. */
async function localPeople(req, res, p, url) {
  const s = device.social;
  if (p === '/local/people' && req.method === 'GET') {
    s.peopleGets++;
    if (s.peopleMs) await sleep(s.peopleMs);
    const supported = !!device.profile && socialOn();
    const people = supported ? peopleNow() : [];
    const me = device.profile ? { id: device.profile.id, pid: pidOf(device.profile.id), name: device.profile.name, photo: device.photo ? device.photo.hash : null, tag: meAsOthers().person.tag } : null;
    const v = sha(JSON.stringify([supported, me, people])).slice(0, 16);
    return answered(req, res, 200, { supported, v, me, people });
  }
  const m = /^\/local\/people\/([0-9a-f]{32})(\/photo)?$/.exec(p);
  if (!m || req.method !== 'GET') return null;
  const id = m[1];
  if (m[2]) {
    const x = s.people.find((y) => y.id === id && peopleNow().some((z) => z.id === id));
    const bytes = x && x.photo ? x.photo.bytes : id === device.profile?.id && device.photo ? device.photo.bytes : null;
    if (!bytes) throw localError(404, 'no_photo', 'Nessuna foto');
    res.writeHead(200, { 'Content-Type': x ? 'image/png' : 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-cache' });
    res.end(bytes);
    return true;
  }
  if (device.profile && id === device.profile.id && socialOn()) return answered(req, res, 200, meAsOthers());
  const person = peopleNow().find((x) => x.id === id);
  if (!person) throw localError(404, 'not_found', 'Persona non trovata');
  const rec = s.people.find((x) => x.id === id);
  const recent = person.seen === 'all' ? rec.recent.map((r) => ({ ...r, artistPage: r.artistPage === true })) : [];
  return answered(req, res, 200, { person, recent });
}

/** /local/social (GET, PATCH) and /local/activity (PUT); null when p is none of them. */
async function localSocial(req, res, p) {
  const s = device.social;
  const out = () => ({ invisible: s.privacy.invisible, showNow: s.privacy.showNow, privateSession: privateNow(), privateUntil: s.privacy.privateUntil, showRecent: s.privacy.showRecent, updatedAt: s.privacy.updatedAt });
  if (p === '/local/social') {
    if (req.method === 'GET') return answered(req, res, 200, { supported: !!device.profile && socialOn(), privacy: out(), blocked: device.chat ? device.chat.blocked : [], mutes: device.chat ? device.chat.mutes : {} });
    if (req.method !== 'PATCH') throw new HttpError(405, 'Metodo non consentito');
    if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
    const b = await readJson(req);
    const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : null;
    if (!keys || !keys.length || keys.some((k) => !SOCIAL_FIELDS.includes(k) || typeof b[k] !== 'boolean')) throw localError(400, 'bad_request', 'Richiesta non valida');
    s.patches.push({ body: b, at: Date.now() });
    if (s.patchFail > 0) {
      s.patchFail--;
      throw new HttpError(503, 'Qualcosa non ha funzionato');
    }
    for (const k of keys) {
      if (k === 'privateSession') s.privacy.privateUntil = b[k] ? Date.now() + 6 * 3600000 : 0;
      else s.privacy[k] = b[k];
    }
    s.privacy.updatedAt = Date.now();
    return answered(req, res, 200, { privacy: out() });
  }
  if (p === '/local/activity') {
    if (req.method !== 'PUT') throw new HttpError(405, 'Metodo non consentito');
    if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
    const b = await readJson(req);
    const t = b ? b.track : undefined;
    // The texts as the core keeps them: one line, at most 200 code points; the title not empty.
    const line = (v) => (typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200).join('').trim() : null);
    const okText = (v, need) => (v === undefined || v === null ? !need : line(v) !== null && (!need || line(v) !== ''));
    const okTrack = t === null || (t && typeof t === 'object' && /^[0-9a-f]{24}$/.test(t.trackId) && okText(t.title, true) && okText(t.artist, false) && okText(t.album, false) && (t.artistPage === undefined || typeof t.artistPage === 'boolean'));
    if (!b || typeof b !== 'object' || !okTrack || typeof b.playing !== 'boolean' || Object.keys(b).some((k) => k !== 'track' && k !== 'playing')) throw localError(400, 'bad_request', 'Richiesta non valida');
    if (t) b.track = { trackId: t.trackId, title: line(t.title), artist: line(t.artist) || '', album: line(t.album) || '', artistPage: t.artistPage === true };
    s.activity.push({ body: b, at: Date.now() });
    if (s.activity.length > 500) s.activity.shift();
    return answered(req, res, 200, { ok: true });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the chats of the sources (the client core's union of every source at social 2)
//
// A group per paired source that holds chats (its id from the source's id), the direct
// conversations of the sample (Giulia on both sources, Marco, the other Giulia, Sara, Chiara who
// is seen in a chat only, silenced), music cards of the three kinds, a reply. Times are relative
// to the reset. The messages are kept as the core shows them (plaintext: the mock is the core).

const groupIdOf = (srvId) => sha(`mpfy-mock-group:${srvId}`).slice(0, 32);
const directIdOf = (a, b) => sha(`chat:${[a, b].sort().join('')}`).slice(0, 32);
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/** One message as the core keeps it here. */
function chatMsg(from, at, extra = {}) {
  return { id: crypto.randomBytes(16).toString('hex'), from, at, t: extra.card ? 'card' : 'text', text: '', card: null, reply: null, state: 'sent', deleted: false, ...extra };
}

function newChat() {
  const now = Date.now();
  const mi = [...servers.values()].find((s) => s.name === 'Mi A2');
  const vps = [...servers.values()].find((s) => s.name === 'VPS prova');
  const me = ME_ID;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Times of today, in their order, always in the past: minsAgo minutes ago, or (early in the day)
  // one second apart from a minute after midnight on.
  const todayAt = (minsAgo) => Math.min(now - 1000, Math.max(today.getTime() + 60000 + (600 - minsAgo) * 1000, now - minsAgo * MIN));
  // A time of an earlier day (n days back on the calendar), whatever the hour now.
  const dayAt = (n, h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, h, m).getTime();
  const trackCard = (ai, ti) => {
    const t = catalog[ai * 5 + ti];
    return { kind: 'track', id: t.id, title: t.title, sub: t.artist };
  };
  const albumCard = (ai) => ({ kind: 'album', id: albumId(ai), title: CATALOG[ai].album, sub: CATALOG[ai].artist });
  const myLists = mi.users.get(me)?.playlists || [];
  const viaggio = myLists.find((x) => x.name === 'Viaggio in macchina');
  const convs = new Map();
  const add = (c) => convs.set(c.id, { readAt: 0, readId: null, ...c });
  // Sara's playlist lives on the Mi A2: its tracks, read whole when someone opens it.
  const saraList = { id: 'a1b2c3d4e5f60718', name: 'Studio notturno', trackIds: [T(4, 0), T(4, 1), T(6, 2), T(3, 1), T(8, 0), 'ffffffffffffffffffffffff'] };

  // Giulia: yesterday a playlist card of yours, today her track card and a question, unread 2.
  const g1 = chatMsg(SIS_ID, dayAt(2, 18, 40), { text: 'hai sentito il disco nuovo?' });
  const g2 = chatMsg(me, dayAt(2, 18, 52), { text: 'non ancora, stasera' });
  const g3 = chatMsg(SIS_ID, dayAt(1, 21, 58), { text: 'mi mandi la playlist del viaggio?' });
  const g4 = chatMsg(me, dayAt(1, 22, 10), { card: viaggio ? { kind: 'playlist', id: viaggio.id, title: viaggio.name, sub: '', n: viaggio.trackIds.length, sources: [mi.id] } : trackCard(1, 0), text: 'per sabato' });
  const g5 = chatMsg(SIS_ID, dayAt(1, 22, 14), { text: 'la ascolto domani \u{1F604}' });
  const g6 = chatMsg(SIS_ID, todayAt(40), { card: trackCard(7, 1), text: 'senti il ritornello' });
  const g7 = chatMsg(SIS_ID, todayAt(38), { text: 'stasera la mettiamo in macchina?\npasso alle 9' });
  add({ id: directIdOf(me, SIS_ID), kind: 'direct', with: SIS_ID, sources: [mi.id, vps.id], messages: [g1, g2, g3, g4, g5, g6, g7], readAt: g5.at, readId: g5.id });
  // Marco: a while ago, all read; he plays something now.
  const m1 = chatMsg(MARCO_ID, todayAt(300), { text: 'ci sei domenica?' });
  const m2 = chatMsg(me, todayAt(290), { text: 'sì, porto la musica', reply: { id: m1.id, from: MARCO_ID, text: 'ci sei domenica?', card: null } });
  add({ id: directIdOf(me, MARCO_ID), kind: 'direct', with: MARCO_ID, sources: [mi.id], messages: [m1, m2], readAt: m2.at, readId: m2.id });
  // The other Giulia (VPS): an album card yesterday.
  const h1 = chatMsg(me, dayAt(1, 17, 5), { card: albumCard(9) });
  const h2 = chatMsg(GIULIA2_ID, dayAt(1, 18, 20), { text: 'grazie, bellissimo album' });
  add({ id: directIdOf(me, GIULIA2_ID), kind: 'direct', with: GIULIA2_ID, sources: [vps.id], messages: [h1, h2], readAt: h2.at, readId: h2.id });
  // Sara: her playlist card, three days ago, read.
  const s1 = chatMsg(SARA_ID, dayAt(3, 20, 30), { card: { kind: 'playlist', id: saraList.id, title: saraList.name, sub: '', n: saraList.trackIds.length, sources: [mi.id] }, text: 'per stasera' });
  add({ id: directIdOf(me, SARA_ID), kind: 'direct', with: SARA_ID, sources: [mi.id], messages: [s1], readAt: s1.at, readId: s1.id, playlists: { [s1.id]: saraList } });
  // Chiara, seen only in a chat: four unread, silenced.
  const c0 = [0, 1, 2, 3].map((i) => chatMsg(CHIARA_ID, dayAt(2, 11, 10 + i), { text: i === 3 ? 'Mamma chiede se venite domenica' : `messaggio ${i + 1}` }));
  const c4 = chatMsg(CHIARA_ID, dayAt(2, 11, 20), { card: trackCard(4, 3) });
  add({ id: directIdOf(me, CHIARA_ID), kind: 'direct', with: CHIARA_ID, sources: [mi.id], messages: [...c0, c4] });
  // The group of the Mi A2: an album card, people writing today, you once; unread 2.
  const r1 = chatMsg(SIS_ID, dayAt(4, 18, 31), { text: 'ho caricato il disco nuovo' });
  const r2 = chatMsg(CHIARA_ID, dayAt(4, 18, 55), { text: 'qualcuno ha musica per sabato?' });
  const r3 = chatMsg(MARCO_ID, dayAt(4, 19, 2), { card: albumCard(0), text: 'per il viaggio' });
  const r4 = chatMsg(SIS_ID, todayAt(25), { text: 'io porto le casse' });
  const r5 = chatMsg(MARCO_ID, todayAt(22), { text: 'chi c\'è sabato?' });
  const r6 = chatMsg(me, todayAt(20), { text: 'io!' });
  const r7 = chatMsg(CHIARA_ID, todayAt(19), { text: 'anche io, porto Luca' });
  const r8 = chatMsg(MARCO_ID, todayAt(18), { text: 'perfetto' });
  add({ id: groupIdOf(mi.id), kind: 'group', source: mi.id, sources: [mi.id], messages: [r1, r2, r3, r4, r5, r6, r7, r8], readAt: r6.at, readId: r6.id });
  // The group of the VPS: nothing written yet.
  add({ id: groupIdOf(vps.id), kind: 'group', source: vps.id, sources: [vps.id], messages: [] });
  return {
    level: 3, // the sources hold chats and the songs part (social 3); 2: chats, no songs; 1: the people part only
    convs,
    mutes: { [directIdOf(me, CHIARA_ID)]: 0 },
    blocked: [],
    postMs: 0,
    failNext: 0,
    playlistDown: false,
    plCopies: new Map(), // message id -> the playlist last read (the core keeps it in memory)
    posts: [],
    reads: [],
    deletes: [],
    gets: { conversations: 0, sameV: 0, messages: 0, shared: 0, playlist: 0 },
  };
}

const chatOn = () => !!device.profile && paired.some((p) => socialOf(servers.get(p.id)) >= 2);
const nameOf = (pid) => {
  if (pid === device.profile?.id) return device.profile.name;
  const x = peopleNow().find((y) => y.id === pid);
  return x ? `${x.name}${x.tag ? ` \u00b7 ${x.tag}` : ''}` : 'Qualcuno';
};
const mutedUntil = (cid) => {
  const u = device.chat.mutes[cid];
  return u === 0 || (typeof u === 'number' && u > Date.now()) ? u : null;
};
const blockedSender = (m) => m.from !== ME_ID && device.chat.blocked.includes(m.from);
/** A conversation's sources now: the paired ones that hold chats. */
const convSources = (c) => c.sources.filter((s) => paired.some((p) => p.id === s) && socialOf(servers.get(s)) >= 2);
/** Shown: its sources are paired, a group's source holds chats, a direct one has a message and no block. */
function convShown(c) {
  if (!convSources(c).length) return false;
  if (c.kind === 'group') return true;
  if (device.chat.blocked.includes(c.with)) return false;
  return c.messages.some((m) => !m.deleted);
}
const visible = (c) => c.messages.filter((m) => !m.deleted && !blockedSender(m));

function previewOf(m) {
  if (m.card) return `${{ track: 'Brano', album: 'Album', playlist: 'Playlist' }[m.card.kind]}: ${m.card.title}`;
  return Array.from(m.text).slice(0, 100).join('');
}

/** A quote as the core gives it: its sender only once the quoted message was deleted for everyone. */
function replyOut(r) {
  for (const c of device.chat.convs.values()) if (c.messages.some((x) => x.id === r.id && x.deleted)) return { id: r.id, from: r.from, gone: true };
  return r;
}

/** A message as /local/chat answers it (M). */
function msgOut(m) {
  const mine = m.from === device.profile?.id;
  return { id: m.id, from: m.from, name: nameOf(m.from), mine, at: m.at, t: m.t, ...(m.text ? { text: m.text } : {}), ...(m.card ? { card: m.card } : {}), ...(m.reply ? { reply: replyOut(m.reply) } : {}), state: m.state, preview: previewOf(m) };
}

function unreadOf(c) {
  return Math.min(999, visible(c).filter((m) => m.from !== device.profile?.id && (m.at > c.readAt || (m.at === c.readAt && c.readId && m.id > c.readId))).length);
}

/** A conversation as /local/chat/conversations lists it (C). */
function convOut(c) {
  const list = visible(c);
  const last = list.length ? list[list.length - 1] : null;
  const until = mutedUntil(c.id);
  const srcName = c.kind === 'group' ? servers.get(c.source)?.name || 'Fonte' : null;
  return {
    id: c.id,
    kind: c.kind,
    with: c.kind === 'direct' ? c.with : null,
    name: srcName,
    display: c.kind === 'group' ? srcName : nameOf(c.with),
    sources: convSources(c),
    ids: [c.id],
    last: last ? msgOut(last) : null,
    unread: unreadOf(c),
    muted: until !== null,
    mutedUntil: until,
    at: last ? last.at : 0,
  };
}

/** The conversation of cid, or a new direct one with a listed person whose direct id it is. */
function convOf(cid) {
  const c = device.chat.convs.get(cid);
  if (c) return c;
  const p = peopleNow().find((x) => x.chat === cid && x.seen === 'all');
  if (!p) return null;
  const on = paired.filter((x) => socialOf(servers.get(x.id)) >= 2).map((x) => x.id);
  const fresh = { id: cid, kind: 'direct', with: p.id, sources: p.sources.filter((s) => on.includes(s)), messages: [], readAt: 0, readId: null };
  device.chat.convs.set(cid, fresh);
  return fresh;
}

/** A tag of a body: the same body, the same tag. */
const vOf = (obj) => sha(JSON.stringify(obj)).slice(0, 16);
const heldV = (req) => String(req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/"/g, '');

/**
 * The body with its v, as the core answers it: a 304 with no body when If-None-Match names that v
 * (the page holds it already), else the whole body (no ETag). sameV counts the asks that held the
 * v of the answer (nothing had changed for them).
 */
function answerV(req, res, body) {
  const v = vOf(body);
  if (String(req.headers['if-none-match'] || '') === `"${v}"`) {
    device.chat.gets.sameV++;
    res.writeHead(304, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  sendJson(req, res, 200, { ...body, v });
  return true;
}

const cleanChatText = (s) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim() : '');
const cleanNoteText = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() : '');
const points = (s) => Array.from(s).length;

/** A text of a card: one line of min to 200 code points, else null (as the core takes it). */
function cardText(v, min) {
  if (typeof v !== 'string') return null;
  const t = cleanNoteText(v);
  return points(t) >= min && points(t) <= 200 ? t : null;
}

/**
 * A card as the core takes it: track { id: 24 hex, title, sub }, album { id: 16 hex, title, sub },
 * playlist { id: 16 hex, title, sub: "", n, sources (8 hex each, at most 16), cover (24 hex) or
 * null }; null when it is not one.
 */
function cardOk(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const title = cardText(c.title, 1);
  if (title === null) return null;
  if (c.kind === 'track' || c.kind === 'album') {
    const sub = c.sub === undefined || c.sub === null ? '' : cardText(c.sub, 0);
    if (typeof c.id !== 'string' || !(c.kind === 'track' ? /^[0-9a-f]{24}$/ : /^[0-9a-f]{16}$/).test(c.id) || sub === null) return null;
    return { kind: c.kind, id: c.id, title, sub };
  }
  if (c.kind === 'playlist') {
    if (typeof c.id !== 'string' || !/^[0-9a-f]{16}$/.test(c.id) || !Number.isSafeInteger(c.n) || c.n < 0) return null;
    const sources = Array.isArray(c.sources) ? [...new Set(c.sources.filter((x) => typeof x === 'string' && /^[0-9a-f]{8}$/.test(x)))].slice(0, 16) : [];
    const cover = typeof c.cover === 'string' && /^[0-9a-f]{24}$/.test(c.cover) ? c.cover : null;
    return { kind: 'playlist', id: c.id, title, sub: '', n: c.n, sources, cover };
  }
  return null;
}

/** /local/chat/... and /local/social/blocked; null when p is none of them. */
async function localChat(req, res, p, url) {
  const ch = device.chat;
  if (p === '/local/social/blocked' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b || Object.keys(b).some((k) => k !== 'profileId') || !/^[0-9a-f]{32}$/.test(b.profileId || '') || b.profileId === device.profile?.id) throw localError(400, 'bad_request', 'Richiesta non valida');
    if (!ch.blocked.includes(b.profileId)) ch.blocked.push(b.profileId);
    return answered(req, res, 200, { blocked: ch.blocked });
  }
  const ub = /^\/local\/social\/blocked\/([0-9a-f]{32})$/.exec(p);
  if (ub && req.method === 'DELETE') {
    ch.blocked = ch.blocked.filter((x) => x !== ub[1]);
    return answered(req, res, 200, { blocked: ch.blocked });
  }
  if (!p.startsWith('/local/chat/')) return null;
  if (p === '/local/chat/conversations' && req.method === 'GET') {
    ch.gets.conversations++;
    const supported = chatOn();
    const list = supported ? [...ch.convs.values()].filter(convShown).map(convOut).sort((a, b) => b.at - a.at) : [];
    const unread = list.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0);
    return answerV(req, res, { supported, unread, conversations: list });
  }
  if (p === '/local/chat/shared' && req.method === 'GET') {
    ch.gets.shared++;
    const cards = [];
    const seen = new Set();
    const all = [];
    for (const c of ch.convs.values()) {
      if (!convShown(c)) continue;
      for (const m of visible(c)) if (m.card && m.from !== device.profile?.id) all.push({ c, m });
    }
    all.sort((a, b) => b.m.at - a.m.at);
    for (const { c, m } of all) {
      const k = `${m.card.kind}:${m.card.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cards.push({ cid: c.id, messageId: m.id, from: m.from, at: m.at, card: m.card, note: m.text || null, unseen: m.at > c.readAt || (m.at === c.readAt && !!c.readId && m.id > c.readId), muted: mutedUntil(c.id) !== null });
      if (cards.length >= 12) break;
    }
    return answerV(req, res, { cards });
  }
  const m = /^\/local\/chat\/([0-9a-f]{32})\/(messages|read|mute)(?:\/([0-9a-f]{32})(\/playlist)?)?$/.exec(p);
  if (!m) throw localError(404, 'not_found', 'Risorsa non trovata');
  const [, cid, what, mid, plPart] = m;
  const c = what === 'messages' && req.method === 'POST' && !mid ? convOf(cid) : ch.convs.get(cid);
  if (!c || !chatOn()) throw localError(404, 'not_found', 'Conversazione non trovata');
  if (what === 'messages' && !mid && req.method === 'GET') {
    ch.gets.messages++;
    // As the core: limit a whole number from 1 (50 without one, 200 at most), before a message id;
    // a before it does not know gives the newest.
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null && (!/^\d{1,6}$/.test(rawLimit) || Number(rawLimit) < 1)) throw localError(400, 'bad_request', 'Richiesta non valida');
    const limit = Math.min(200, rawLimit === null ? 50 : Number(rawLimit));
    const before = url.searchParams.get('before');
    if (before !== null && !/^[0-9a-f]{32}$/.test(before)) throw localError(400, 'bad_request', 'Richiesta non valida');
    const list = visible(c);
    let end = list.length;
    if (before) {
      const at = list.findIndex((x) => x.id === before);
      end = at >= 0 ? at : list.length;
    }
    const start = Math.max(0, end - limit);
    return answerV(req, res, { messages: list.slice(start, end).map(msgOut), more: start > 0 });
  }
  if (what === 'messages' && !mid && req.method === 'POST') {
    const b = await readJson(req);
    if (!b || Object.keys(b).some((k) => !['id', 'text', 'card', 'replyTo'].includes(k))) throw localError(400, 'bad_request', 'Richiesta non valida');
    const id = b.id === undefined || b.id === null ? crypto.randomBytes(16).toString('hex') : /^[0-9a-f]{32}$/.test(b.id || '') ? b.id : null;
    if (!id) throw localError(400, 'bad_request', 'Richiesta non valida');
    ch.posts.push({ cid, body: b, at: Date.now() });
    const again = c.messages.find((x) => x.id === id);
    if (again) return answered(req, res, 200, { message: msgOut(again) });
    const card = b.card === undefined || b.card === null ? null : cardOk(b.card);
    if (b.card !== undefined && b.card !== null && !card) throw localError(400, 'bad_request', 'Richiesta non valida');
    // A playlist is read from the sources the page named that hold this conversation (the
    // principal when it named none).
    if (card && card.kind === 'playlist') {
      const named = card.sources.length ? card.sources : paired.filter((x) => x.principal).map((x) => x.id);
      card.sources = named.filter((sid) => convSources(c).includes(sid));
    }
    const text = card ? cleanNoteText(b.text || '') : cleanChatText(b.text || '');
    if ((!card && (!text || points(text) > 2000)) || (card && points(text) > 300)) throw localError(400, 'bad_request', 'Richiesta non valida');
    let reply = null;
    if (b.replyTo !== undefined && b.replyTo !== null) {
      const q = c.messages.find((x) => x.id === b.replyTo && !x.deleted);
      if (!q) throw localError(400, 'bad_request', 'Richiesta non valida');
      // As the core writes it: { id, from, text? (its text or note, 100 at most), card? }.
      reply = { id: q.id, from: q.from };
      if (q.text) reply.text = Array.from(q.text).slice(0, 100).join('');
      if (q.card) reply.card = { kind: q.card.kind, id: q.card.id, title: q.card.title };
    }
    const msg = chatMsg(device.profile.id, Date.now(), { id, text, card, reply, t: card ? 'card' : 'text' });
    if (ch.failNext > 0) {
      ch.failNext--;
      msg.state = 'failed';
      return answered(req, res, 201, { message: msgOut(msg) });
    }
    // A slow source: the answer comes within 4 s, pending until it is through.
    const slow = ch.postMs;
    if (slow > 0) msg.state = 'pending';
    c.messages.push(msg);
    c.readAt = msg.at;
    c.readId = msg.id;
    if (slow > 0) {
      setTimeout(() => (msg.state = 'sent'), slow);
      await sleep(Math.min(slow, 4000));
    }
    return answered(req, res, 201, { message: msgOut(msg) });
  }
  if (what === 'messages' && mid && plPart && req.method === 'GET') {
    ch.gets.playlist++;
    const msg = c.messages.find((x) => x.id === mid && !x.deleted);
    if (!msg || !msg.card || msg.card.kind !== 'playlist') throw localError(404, 'not_found', 'Risorsa non trovata');
    // No source of the card answers: the copy read last in this run (live false), else 404.
    if (ch.playlistDown) {
      const had = ch.plCopies.get(mid);
      if (!had) throw localError(404, 'not_found', 'Risorsa non trovata');
      return answered(req, res, 200, { playlist: { ...had, live: false } });
    }
    const srv = servers.get(msg.card.sources[0]) || servers.values().next().value;
    const list = (c.playlists && c.playlists[mid]) || userOf(srv, msg.from).playlists.find((x) => x.id === msg.card.id);
    if (!list) {
      // Gone there (the playlist removed): no older copy shown.
      ch.plCopies.delete(mid);
      throw localError(404, 'not_found', 'Risorsa non trovata');
    }
    const own = srv ? userOf(srv, msg.from).covers.playlist[list.id] : null;
    const pl = { id: list.id, name: list.name, n: list.trackIds.length, trackIds: list.trackIds.slice(), cover: (own && own.small) || null, updatedAt: list.updatedAt || 0 };
    ch.plCopies.delete(mid);
    ch.plCopies.set(mid, pl);
    while (ch.plCopies.size > 32) ch.plCopies.delete(ch.plCopies.keys().next().value);
    return answered(req, res, 200, { playlist: { ...pl, live: true } });
  }
  if (what === 'messages' && mid && !plPart && req.method === 'DELETE') {
    // As the core: someone else's is refused; one it does not know goes all the same.
    const msg = c.messages.find((x) => x.id === mid);
    if (msg && msg.from !== device.profile?.id) throw localError(403, 'refused', 'Non consentito');
    if (msg) msg.deleted = true;
    ch.plCopies.delete(mid);
    ch.deletes.push({ cid, id: mid, at: Date.now() });
    return answered(req, res, 200, { ok: true });
  }
  if (what === 'read' && req.method === 'PUT') {
    const b = await readJson(req);
    if (!b || typeof b.id !== 'string' || !/^[0-9a-f]{32}$/.test(b.id) || Object.keys(b).some((k) => k !== 'id')) throw localError(400, 'bad_request', 'Richiesta non valida');
    const msg = c.messages.find((x) => x.id === b.id);
    if (!msg) throw localError(404, 'not_found', 'Messaggio non trovato');
    ch.reads.push({ cid, id: msg.id, at: Date.now() });
    if (msg.at > c.readAt || (msg.at === c.readAt && msg.id > (c.readId || ''))) {
      c.readAt = msg.at;
      c.readId = msg.id;
    }
    return answered(req, res, 200, { ok: true });
  }
  if (what === 'mute' && req.method === 'PUT') {
    const b = await readJson(req);
    if (!b || Object.keys(b).some((k) => k !== 'mute') || typeof b.mute !== 'string') throw localError(400, 'bad_request', 'Richiesta non valida');
    const until = { '8h': Date.now() + 8 * HOUR, '1w': Date.now() + 7 * DAY, always: 0, off: null }[b?.mute];
    if (until === undefined) throw localError(400, 'bad_request', 'Richiesta non valida');
    if (until === null) delete ch.mutes[cid];
    else ch.mutes[cid] = until;
    return answered(req, res, 200, { mutes: ch.mutes });
  }
  throw new HttpError(405, 'Metodo non consentito');
}

async function local(req, res, p, url) {
  const method = req.method;
  if (p === '/local/sources') {
    if (method === 'GET') return sendJson(req, res, 200, sourcesOut());
    if (method === 'POST') return addSource(req, res);
    throw new HttpError(405, 'Metodo non consentito');
  }
  if (p === '/local/phone/shadowed' && phone) {
    if (method !== 'PUT') throw new HttpError(405, 'Metodo non consentito');
    const b = await readJson(req);
    const ids = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string' && TRACK_ID.test(x)));
    if (!b || typeof b !== 'object' || (b.all === undefined && b.add === undefined && b.remove === undefined) || !ids(b.all) || !ids(b.add) || !ids(b.remove) || (b.all !== undefined && (b.add !== undefined || b.remove !== undefined))) throw NEED('bad_request');
    phone.shadow.puts.push(b.all !== undefined ? { all: b.all.length } : { add: (b.add || []).length, remove: (b.remove || []).length });
    if (b.all !== undefined) phone.shadow = { key: realKey(), ids: new Set(b.all), puts: phone.shadow.puts };
    else {
      for (const id of b.remove || []) phone.shadow.ids.delete(id);
      for (const id of b.add || []) phone.shadow.ids.add(id);
    }
    return sendJson(req, res, 200, { ok: true, shadowed: phone.shadow.ids.size });
  }
  if (p === '/local/phone/moved' && phone) {
    if (method !== 'POST') throw new HttpError(405, 'Metodo non consentito');
    const b = await readJson(req);
    if (!b || typeof b.to !== 'string' || !Number.isSafeInteger(b.uv) || typeof b.ue !== 'string') throw NEED('bad_request');
    // holdMoved: the answer waits (a page reloaded meanwhile leaves it unanswered, and it changes nothing).
    let gone = false;
    res.on('close', () => {
      if (!res.writableEnded) gone = true;
    });
    while (phone.holdMoved && !gone) await sleep(100);
    if (gone) return undefined;
    const pr = realPrincipal();
    if (!pr || pr.id !== b.to) throw new HttpError(404, 'Fonte sconosciuta', 'not_found');
    const u = userOf(phone);
    if (u.userVersion !== b.uv || ulOf(u).epoch !== b.ue) throw new HttpError(409, 'I dati sono cambiati nel frattempo', 'changed');
    phone.moved.push({ to: b.to, at: Date.now(), playlists: u.playlists.length, likes: u.likes.length, recents: (u.history || u.recents).length });
    phone.users.set(actor(), emptyUser());
    changedUser(phone, userOf(phone)); // a new epoch, nothing in it
    phone.holds = false;
    return sendJson(req, res, 200, { ok: true });
  }
  if (p === '/local/sync' && method === 'POST') {
    syncAll();
    if (device.syncMs) await sleep(device.syncMs); // the core waits for every source's answer
    return sendJson(req, res, 200, { ok: true });
  }
  if (device.noProfiles && (p === '/local/profile' || p.startsWith('/local/profile/'))) throw new HttpError(404, 'Risorsa non trovata');
  if (p.startsWith('/local/chat/') || p.startsWith('/local/social/blocked')) {
    if (!device.noProfiles && (await localChat(req, res, p, url))) return undefined;
    throw new HttpError(404, 'Risorsa non trovata');
  }
  if (p === '/local/people' || p.startsWith('/local/people/') || p === '/local/social' || p === '/local/activity') {
    if (!device.noProfiles && (p === '/local/social' || p === '/local/activity' ? await localSocial(req, res, p) : await localPeople(req, res, p, url))) return undefined;
    throw new HttpError(404, 'Risorsa non trovata');
  }
  if (p === '/local/profile') {
    if (method === 'GET') return sendJson(req, res, 200, { profile: localProfile(), recovery: device.recovery, fileName: device.profile ? fileNameOf(device.profile.name) : null });
    const b = await readJson(req);
    if (method === 'POST') {
      if (device.profile) throw localError(409, 'profile_exists', 'Profilo gia presente');
      const name = cleanName(b.name);
      device.profile = { id: crypto.randomBytes(16).toString('hex'), name, nameUpdatedAt: Date.now() };
      device.secret = crypto.randomBytes(32).toString('hex');
      device.photo = null;
      syncAll();
      return sendJson(req, res, 201, { profile: localProfile() });
    }
    if (method === 'PATCH') {
      if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
      device.profile.name = cleanName(b.name);
      device.profile.nameUpdatedAt = Date.now();
      syncAll();
      return sendJson(req, res, 200, { profile: localProfile() });
    }
    throw new HttpError(405, 'Metodo non consentito');
  }
  if (p === '/local/profile/photo') {
    if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
    if (method === 'GET' || method === 'HEAD') {
      if (!device.photo || device.photoGone) throw localError(404, 'no_photo', 'Nessuna foto');
      const etag = `"${device.photo.hash}"`;
      const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etag };
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return undefined;
      }
      res.writeHead(200, { ...headers, 'Content-Length': device.photo.bytes.length });
      res.end(method === 'HEAD' ? undefined : device.photo.bytes);
      return undefined;
    }
    if (method === 'PUT') {
      // Read to the end even when it is too big: the connection stays good for the next request.
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      }
      if (size > 64 * 1024) throw localError(413, 'too_large', 'Richiesta troppo grande');
      const buf = Buffer.concat(chunks);
      device.photoPuts++;
      if (device.photoMs) await sleep(device.photoMs);
      if (device.photoFail) throw new HttpError(503, 'Qualcosa non ha funzionato');
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'image/jpeg' || !validPhoto(buf)) throw localError(400, 'bad_photo', 'Foto non valida');
      device.photo = { hash: sha(buf), bytes: buf };
      return sendJson(req, res, 200, { profile: localProfile() });
    }
    if (method === 'DELETE') {
      device.photo = null;
      return sendJson(req, res, 200, { profile: localProfile() });
    }
    throw new HttpError(405, 'Metodo non consentito');
  }
  if (p === '/local/profile/code' && method === 'GET') {
    if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
    return sendJson(req, res, 200, { code: profileCodeOf(device.secret) });
  }
  if (p === '/local/profile/export' && method === 'GET') {
    if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
    return sendJson(req, res, 200, { fileName: fileNameOf(device.profile.name), identity: identity() });
  }
  if (p === '/local/profile/import' && method === 'POST') {
    const b = await readJson(req);
    if (device.profile) throw localError(409, 'profile_exists', 'Profilo gia presente');
    if (b.identity) {
      const id = b.identity;
      if (id.format !== 'mpfy-identity' || id.v !== 1 || !id.profile || typeof id.profile.id !== 'string' || !/^[0-9a-f]{32}$/.test(id.profile.id) || !Array.isArray(id.sources)) throw localError(400, 'bad_file', 'File non valido');
      device.profile = { id: id.profile.id, name: String(id.profile.name || ''), nameUpdatedAt: Number(id.profile.nameUpdatedAt) || 0 };
      device.photo = null;
      device.secret = String(id.profile.secret || device.secret);
      paired = id.sources.filter((s) => servers.has(s.id)).map((s, i) => ({ id: s.id, principal: !!s.principal, addedAt: Number(s.addedAt) || Date.now() + i }));
      if (paired.length && !paired.some((x) => x.principal)) paired[0].principal = true;
      syncAll();
      return sendJson(req, res, 200, { profile: localProfile(), sources: sourcesOut().sources });
    }
    const k = parseProfileCode(b.code);
    if (k.kind === 'source') throw localError(400, 'source_code', 'Questo e il codice di una fonte');
    if (k.kind !== 'profile') throw localError(400, 'bad_code', 'Codice non valido');
    const stranger = k.body === parseProfileCode(profileCodeOf('mpfy-mock-stranger-secret')).body;
    device.profile = { id: stranger ? STRANGER_ID : ME_ID, name: '', nameUpdatedAt: 0 };
    device.photo = null;
    syncAll();
    return sendJson(req, res, 200, { profile: localProfile(), sources: sourcesOut().sources });
  }
  if (p === '/local/profile/recovery') {
    if (method === 'PUT') {
      if (!device.profile) throw localError(404, 'no_profile', 'Nessun profilo');
      const b = await readJson(req);
      if (typeof b.password !== 'string' || Array.from(b.password.normalize('NFC')).length < 8) throw localError(400, 'short_password', 'Almeno 8 caratteri');
      await sleep(400); // Argon2id
      device.recovery = true;
      device.recoveryUpdatedAt = Date.now();
      syncAll();
      const out = {};
      for (const x of paired) out[x.id] = servers.get(x.id)?.connected ? 'ok' : 'pending';
      return sendJson(req, res, 200, { recovery: true, sources: out });
    }
    if (method === 'DELETE') {
      device.recovery = false;
      syncAll();
      return sendJson(req, res, 200, { recovery: false });
    }
  }
  if (p === '/local/recovery' && method === 'POST') {
    if (device.profile) throw localError(409, 'profile_exists', 'Profilo gia presente');
    const b = await readJson(req);
    const body = parseCode(b.code);
    if (!body) {
      if (parseProfileCode(b.code).kind === 'profile') throw localError(400, 'profile_code', 'Questo e il codice del profilo');
      throw localError(400, 'bad_code', 'Codice non valido');
    }
    await sleep(PAIR_DELAY);
    const srv = [...servers.values()].find((s) => s.code === body);
    if (!srv || !srv.connected) throw localError(504, 'unreachable', 'Fonte non raggiungibile');
    const sessionId = crypto.randomBytes(8).toString('hex');
    device.recoverySessions.set(sessionId, { srv: srv.id, until: Date.now() + 600000 });
    return sendJson(req, res, 200, { sessionId, source: { name: srv.name }, entries: recoveryEntries(srv).map(({ profileId, name, device: d, deviceName }) => ({ profileId, name, device: d, deviceName })) });
  }
  const rs = /^\/local\/recovery\/([0-9a-f]+)$/.exec(p);
  if (rs) {
    const sess = device.recoverySessions.get(rs[1]);
    if (method === 'DELETE') {
      device.recoverySessions.delete(rs[1]);
      return sendJson(req, res, 200, { ok: true });
    }
    if (method !== 'POST') throw new HttpError(405, 'Metodo non consentito');
    const b = await readJson(req);
    if (!sess || sess.until < Date.now() || device.expireNext) {
      device.expireNext = false;
      device.recoverySessions.delete(rs[1]);
      throw localError(404, 'session_gone', 'Sessione scaduta');
    }
    const srv = servers.get(sess.srv);
    const r = srv.recovery.get(b.profileId);
    if (!r || !r.devices[b.device]) throw localError(404, 'no_recovery', 'Recupero non attivo');
    const now = Date.now();
    if (r.lockedUntil > now) throw localError(429, 'locked', 'Troppi tentativi', { retryAt: r.lockedUntil });
    await sleep(300); // Argon2id
    if (b.password !== PASSWORD) {
      r.failures = r.failures.filter((t) => t > now - 3600000);
      r.failures.push(now);
      if (r.failures.length >= 5) {
        r.lockedUntil = now + 3600000 * 2 ** r.locks;
        r.locks++;
        throw localError(429, 'locked', 'Troppi tentativi', { retryAt: r.lockedUntil });
      }
      throw localError(403, 'wrong_password', 'Password errata', { triesLeft: 5 - r.failures.length });
    }
    r.locks = 0;
    device.recoverySessions.delete(rs[1]);
    const name = srv.profiles.get(b.profileId)?.name || '';
    device.profile = { id: b.profileId, name, nameUpdatedAt: srv.profiles.get(b.profileId)?.nameUpdatedAt || 0 };
    device.photo = null;
    device.recovery = true;
    device.recoveryUpdatedAt = now;
    const mi = [...servers.values()][0];
    const others = [...servers.values()].filter((s) => s !== mi && s.recovery.has(b.profileId));
    paired = [{ id: mi.id, principal: true, addedAt: now - 7 * 86400000 }, ...others.map((s, i) => ({ id: s.id, principal: false, addedAt: now - 7 * 86400000 + 3600000 * (i + 1) }))];
    for (const x of paired) {
      const s = servers.get(x.id);
      if (!s.clients.some((c) => c.publicKey === CLIENT_KEY)) s.clients.push({ publicKey: CLIENT_KEY, name: 'PC', addedAt: now, connected: true, profileId: b.profileId, legacy: false });
    }
    syncAll();
    return sendJson(req, res, 200, { profile: localProfile(), sources: sourcesOut().sources });
  }
  const m = /^\/local\/sources\/([^/]+)$/.exec(p);
  if (!m) throw new HttpError(404, 'Risorsa non trovata');
  const entry = paired.find((x) => x.id === decodeURIComponent(m[1]));
  if (!entry) throw new HttpError(404, 'Fonte sconosciuta');
  if (method === 'PATCH') {
    const b = await readJson(req);
    if (b.name !== undefined) throw new HttpError(400, 'Richiesta non valida');
    if (b.principal === true) for (const x of paired) x.principal = x === entry;
    return sendJson(req, res, 200, { source: entryJson(entry) });
  }
  if (method === 'DELETE') {
    // The core first asks the source to forget this device (2 s timeout), then forgets it.
    const srv = servers.get(entry.id);
    if (srv?.connected) srv.clients = srv.clients.filter((c) => c.publicKey !== CLIENT_KEY);
    paired = paired.filter((x) => x !== entry);
    if (entry.principal && paired.length) paired[0].principal = true;
    return sendJson(req, res, 200, { ok: true });
  }
  throw new HttpError(405, 'Metodo non consentito');
}

/** The core's CSRF guard: no Origin, or exactly our own. */
function originOk(req, p) {
  const o = req.headers.origin;
  if (!o) return true;
  const own = o === `http://127.0.0.1:${actualPort}`;
  if (req.method !== 'GET' && req.method !== 'HEAD') return own;
  if (p.startsWith('/local/')) return own;
  return true;
}


// ---------------------------------------------------------------------------------------------
// static files (no-cache + ETag), SPA fallback

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB, `.${path.posix.normalize(rel)}`);
  const inside = file.startsWith(WEB + path.sep) && !file.startsWith(path.join(WEB, 'dev') + path.sep);
  let target = inside ? file : null;
  let st = null;
  if (target) {
    try {
      st = await fs.promises.stat(target);
      if (!st.isFile()) target = null;
    } catch {
      target = null;
    }
  }
  if (!target) {
    target = path.join(WEB, 'index.html'); // SPA: unknown paths get the app
    st = await fs.promises.stat(target);
  }
  const tag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: tag, 'Content-Security-Policy': CSP };
  if (etagMatches(req.headers['if-none-match'], tag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const body = await fs.promises.readFile(target);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------------------------
// server

function mockHelper(url, res) {
  const p = url.pathname;
  const q = url.searchParams;
  const text = (s) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`${s}\n`);
  };
  if (p === '/__mock/offline') {
    const off = q.get('on') !== '0';
    const id = q.get('source');
    const list = id ? [servers.get(id)].filter(Boolean) : [...servers.values()];
    if (!list.length) return text(`unknown source ${id}`);
    for (const s of list) {
      s.connected = !off;
      if (off) s.throughputKbps = null;
    }
    return text(list.map((s) => `${s.id} ${s.name}: ${s.connected ? 'online' : 'offline'}`).join('\n'));
  }
  if (p === '/__mock/source') {
    const s = servers.get(q.get('source'));
    if (!s) return text('unknown source');
    if (q.has('rtt')) s.rttMs = Math.max(0, Number(q.get('rtt')) || 0);
    if (q.has('kbps')) s.linkKbps = s.throughputKbps = Math.max(1, Number(q.get('kbps')) || 1);
    if (q.has('legacy')) s.legacy = q.get('legacy') === '1';
    if (q.has('sevenZip')) s.archives.sevenZip = q.get('sevenZip') === '1';
    if (q.has('rar')) s.archives.rar = q.get('rar') === '1';
    if (q.has('role')) s.ownerProfileId = q.get('role') === 'owner' ? actor() : SIS_ID;
    if (q.has('maxSessions')) s.maxSessions = Math.max(0, Number(q.get('maxSessions')) || 0);
    if (q.has('pipelineMs')) s.pipelineMs = Math.max(0, Number(q.get('pipelineMs')) || 0);
    if (q.has('extractMs')) s.extractMs = Math.max(0, Number(q.get('extractMs')) || 0);
    if (q.has('healthMs')) s.healthMs = Math.max(0, Number(q.get('healthMs')) || 0);
    if (q.has('drop')) s.drop = Math.max(0, Number(q.get('drop')) || 0);
    if (q.has('fail')) s.fail = Math.max(0, Number(q.get('fail')) || 0);
    if (q.has('streamFail')) s.streamFail = q.get('streamFail') === '1';
    if (q.has('streamStall')) s.streamStall = q.get('streamStall') === '1';
    if (q.has('details')) s.details = q.get('details') === '1' ? true : q.get('details') === '0' ? false : undefined;
    if (q.has('detailsFail')) s.detailsFail = q.get('detailsFail') === '1';
    if (q.has('social')) s.socialMax = q.get('social') === '' ? null : Math.max(0, Math.min(3, Number(q.get('social')) || 0));
    if (q.has('delta')) s.oldLibrary = q.get('delta') === '0';
    if (q.has('card')) s.card = q.get('card');
    if (q.get('restart') === '1') {
      s.lib.newRun = true;
      for (const u of s.users.values()) ulOf(u).newRun = true;
    }
    if (q.has('legacy') || q.has('role') || q.has('social') || q.has('delta') || q.get('forget') === '1') changedShared(s);
    else if (q.has('details')) changedShared(s, {});
    if (q.get('forget') === '1') for (const u of s.users.values()) changedUser(s, u);
    return text(`${s.id} ${s.name}: rtt ${s.rttMs} ms, ${s.linkKbps} kbps, legacy ${s.legacy}, role ${roleOn(s)}, archives ${JSON.stringify(s.archives)}`);
  }
  if (p === '/__mock/quality') {
    const on = q.get('on') === '1';
    const changed = [];
    for (const s of servers.values()) {
      const ids = [];
      for (const t of s.db.tracks) {
        if (t.codec !== 'mp3' || t.bitrate !== 320000) continue;
        t.cutoffHz = on ? 17000 : null;
        t.equivKbps = on ? 128 : null;
        t.score = scoreOf(t);
        changed.push(t.title);
        ids.push(t.id);
      }
      changedShared(s, { tracks: ids });
    }
    return text(`quality ${on ? 'measured' : 'not measured'}: ${changed.length} tracks`);
  }
  if (p === '/__mock/grow') {
    const s = servers.get(q.get('source'));
    if (!s) return text('unknown source');
    const k = grow(s, Math.max(0, Number(q.get('tracks')) || 0), { from: q.has('from') ? Math.max(0, Number(q.get('from')) || 0) : undefined, likes: Math.max(0, Number(q.get('likes')) || 0), playlist: Math.max(0, Number(q.get('playlist')) || 0) });
    return text(`${s.id} ${s.name}: ${s.db.tracks.length} tracks, ${k} generated, ${userOf(s).likes.length} likes, version ${s.db.version}`);
  }
  if (p === '/__mock/reset') {
    buildSample(q.has('sources') ? Number(q.get('sources')) : START_SOURCES, q.has('profile') ? q.get('profile') === '1' : q.has('sources') ? Number(q.get('sources')) > 0 : START_PROFILE, q.has('phone') ? q.get('phone') === '1' : START_PHONE);
    return text(`reset: ${paired.length} sources paired, profile ${device.profile ? 'yes' : 'no'}, phone ${phone ? 'yes' : 'no'}`);
  }
  // /__mock/phone?state=off|scanning|ready (the permission and the first scan), retag=<k> (the
  // k-th own song written again by a tag editor: a new id whose `was` holds the old one).
  if (p === '/__mock/phone') {
    if (!phone) return text('no phone music');
    if (q.has('state')) phoneState(q.get('state'));
    if (q.has('holdMoved')) phone.holdMoved = q.get('holdMoved') === '1';
    if (q.has('retag')) {
      const i = phone.all.findIndex((t) => t.id === sha24(`mpfy-mock-local-${Number(q.get('retag'))}`));
      if (i < 0) return text('no such song');
      const old = phone.all[i];
      const t = { ...old, id: sha24(`mpfy-mock-local-re-${old.id}`), was: [old.id], size: old.size + 512 };
      t.fileHash = t.id;
      phone.all[i] = t;
      const j = phone.db.tracks.findIndex((x) => x.id === old.id);
      if (j >= 0) {
        phone.db.tracks[j] = t;
        changedShared(phone, { tracks: [t.id], removed: [old.id] });
      }
      return text(`${old.id} -> ${t.id}`);
    }
    return text(`phone ${phone.state}, ${phone.db.tracks.length} tracks, home ${phoneHome()}`);
  }
  if (p === '/__mock/core') {
    if (q.has('roleDelay')) device.roleDelay = Math.max(0, Number(q.get('roleDelay')) || 0);
    if (q.has('syncMs')) device.syncMs = Math.max(0, Number(q.get('syncMs')) || 0);
    if (q.has('photoFail')) device.photoFail = q.get('photoFail') === '1';
    if (q.has('photoMs')) device.photoMs = Math.max(0, Number(q.get('photoMs')) || 0);
    if (q.has('photoGone')) device.photoGone = q.get('photoGone') === '1';
    if (q.has('noProfiles')) device.noProfiles = q.get('noProfiles') === '1';
    return text(`roleDelay ${device.roleDelay}, syncMs ${device.syncMs}, photoFail ${device.photoFail}, photoMs ${device.photoMs}, photoGone ${device.photoGone}, noProfiles ${device.noProfiles}`);
  }
  if (p === '/__mock/recovery') {
    if (q.get('expire') === '1') device.expireNext = true;
    return text(`expire next: ${device.expireNext}`);
  }
  if (p === '/__mock/social') {
    const s = device.social;
    if (q.has('on')) s.on = q.get('on') === '1';
    if (q.has('patchFail')) s.patchFail = Math.max(0, Number(q.get('patchFail')) || 0);
    if (q.has('peopleMs')) s.peopleMs = Math.max(0, Number(q.get('peopleMs')) || 0);
    if (q.has('recents')) s.recentsOff = q.get('recents') === '0';
    if (q.has('privateMs')) s.privacy.privateUntil = Date.now() + Math.max(0, Number(q.get('privateMs')) || 0);
    if (q.has('crowd')) {
      // n more people on the Mi A2 (no cap on people): every third one plays something now.
      const n = Math.max(0, Number(q.get('crowd')) || 0);
      const mi = [...servers.values()].find((x) => x.name === 'Mi A2');
      const now = Date.now();
      s.people = s.people.filter((x) => !x.crowd);
      for (let i = 0; i < n; i++) {
        const id = sha(`mpfy-mock-crowd-${i}`).slice(0, 32);
        const t = i % 3 === 0 ? played(i % 12, i % 5, now - 10000) : null;
        s.people.push({ id, name: `Amico ${String(i + 1).padStart(3, '0')}`, photo: null, seen: 'all', sources: [mi.id], now: t, last: t ? null : played((i + 5) % 12, (i + 2) % 5, now - (i + 1) * 3600000), recent: [], crowd: true });
      }
    }
    if (q.get('clear') === '1') {
      s.patches = [];
      s.activity = [];
      s.recentsGets = [];
      s.peopleGets = 0;
    }
    if (q.has('now')) {
      const x = s.people.find((y) => y.id === q.get('now'));
      const [ai, ti] = String(q.get('track') || '0,0').split(',').map(Number);
      if (x) {
        x.now = played(ai, ti, Date.now());
        x.recent = [{ ...x.now }, ...x.recent.filter((r) => r.trackId !== x.now.trackId)].slice(0, 20);
      }
    }
    if (q.has('stop')) {
      const x = s.people.find((y) => y.id === q.get('stop'));
      if (x && x.now) {
        x.last = { ...x.now };
        x.now = null;
      }
    }
    if (q.has('history')) {
      const n = Math.max(0, Number(q.get('history')) || 0);
      const step = Math.max(1, Number(q.get('step')) || 180) * 60000;
      const principal = paired.find((x) => x.principal);
      const srv = principal && servers.get(principal.id);
      if (srv) {
        const ids = srv.db.tracks.map((t) => t.id);
        const now = Date.now();
        const plays = Array.from({ length: n }, (_, i) => ({ trackId: ids[i % ids.length], at: now - 60000 - i * step, context: i % 3 === 0 ? { type: 'library', id: null } : { type: 'album', id: albumIdOf(srv.db.tracks[i % ids.length]) } }));
        // midnight=1: one play right after today's midnight and one right before it (when today's is past).
        if (q.get('midnight') === '1') {
          const today = new Date();
          today.setHours(0, 0, 30, 0);
          const t0 = today.getTime();
          if (t0 < now - 1000) plays.push({ trackId: ids[1], at: t0, context: { type: 'library', id: null } });
          plays.push({ trackId: ids[2], at: t0 - 60000, context: { type: 'library', id: null } });
        }
        userOf(srv).history = plays.sort((a, b) => b.at - a.at);
      }
    }
    return text(`social ${s.on ? 'on' : 'off'}, patchFail ${s.patchFail}, peopleMs ${s.peopleMs}, recents ${s.recentsOff ? 'off' : 'on'}`);
  }
  if (p === '/__mock/chat') {
    const ch = device.chat;
    if (q.has('level')) {
      ch.level = q.get('level') === '1' ? 1 : q.get('level') === '2' ? 2 : 3;
      for (const s of servers.values()) changedShared(s); // the lyrics flag comes and goes with it
    }
    if (q.has('postMs')) ch.postMs = Math.max(0, Number(q.get('postMs')) || 0);
    if (q.has('failNext')) ch.failNext = Math.max(0, Number(q.get('failNext')) || 0);
    if (q.has('playlistDown')) ch.playlistDown = q.get('playlistDown') === '1';
    if (q.get('clear') === '1') {
      ch.posts = [];
      ch.reads = [];
      ch.deletes = [];
      ch.gets = { conversations: 0, sameV: 0, messages: 0, shared: 0, playlist: 0 };
      ch.plCopies.clear();
    }
    if (q.has('unread')) {
      const c = ch.convs.get(q.get('unread'));
      if (c) {
        c.readAt = 0;
        c.readId = null;
      }
    }
    if (q.has('say')) {
      const c = ch.convs.get(q.get('say'));
      const from = q.get('from') || SIS_ID;
      if (c) {
        const kind = q.get('card');
        const t = catalog[(Number(q.get('ai')) || 7) * 5 + (Number(q.get('ti')) || 2)];
        const card = kind === 'album' ? { kind: 'album', id: albumId(Number(q.get('ai')) || 7), title: CATALOG[Number(q.get('ai')) || 7].album, sub: CATALOG[Number(q.get('ai')) || 7].artist } : kind ? { kind: 'track', id: t.id, title: t.title, sub: t.artist } : null;
        // One after the other, as a person writes them: never two at the same millisecond.
        const at = Math.max(Date.now(), c.messages.length ? c.messages[c.messages.length - 1].at + 1 : 0);
        c.messages.push(chatMsg(from, at, { text: q.get('text') || '', card }));
      }
    }
    if (q.has('unquote')) {
      const c = ch.convs.get(q.get('unquote'));
      const r = c ? [...c.messages].reverse().find((x) => x.reply && !x.deleted) : null;
      const quoted = r ? c.messages.find((x) => x.id === r.reply.id) : null;
      if (quoted) quoted.deleted = true;
    }
    if (q.has('bulk')) {
      const c = ch.convs.get(q.get('bulk'));
      const n = Math.max(0, Number(q.get('n')) || 0);
      if (c) {
        const first = c.messages.length ? Math.min(...c.messages.map((x) => x.at)) : Date.now();
        const other = c.kind === 'group' ? SIS_ID : c.with;
        const old = Array.from({ length: n }, (_, i) => chatMsg(i % 3 === 0 ? device.profile.id : other, first - (n - i) * 60000, { text: `messaggio di prova ${i + 1}` }));
        c.messages = [...old, ...c.messages];
      }
    }
    return text(`chat level ${ch.level}, postMs ${ch.postMs}, failNext ${ch.failNext}, playlistDown ${ch.playlistDown}`);
  }
  if (p === '/__mock/songs') {
    const so = device.songs;
    if (q.get('clear') === '1') Object.assign(so, { gets: [], posts: [], deletes: [], lyricsGets: [], lyricsPuts: [], lyricsDeletes: [], writes: [] });
    if (q.has('failPosts')) so.failPosts = Math.max(0, Number(q.get('failPosts')) || 0);
    if (q.has('getMs')) so.getMs = Math.max(0, Number(q.get('getMs')) || 0);
    if (q.has('postMs')) so.postMs = Math.max(0, Number(q.get('postMs')) || 0);
    if (q.has('invisible')) so.invisible = q.get('invisible') ? q.get('invisible').split(',') : [];
    const srv = servers.get(q.get('source') || '') || null;
    // say=<trackId>&source=<id>&from=<profileId>&text=<t>: someone comments now (theirs replaced).
    if (q.has('say') && srv && findTrack(srv, q.get('say'))) {
      const tid = q.get('say');
      const from = q.get('from') || SIS_ID;
      const list = (srv.comments.get(tid) || []).filter((c) => c.from !== from);
      srv.comments.set(tid, [{ id: q.get('id') || crypto.randomBytes(16).toString('hex'), trackId: tid, from, at: Date.now(), text: q.get('text') || 'bella' }, ...list]);
    }
    // many=<trackId>&source=<id>&n=<k>: k comments of k invented people, one a minute back from now.
    if (q.has('many') && srv && findTrack(srv, q.get('many'))) {
      const tid = q.get('many');
      const n = Math.max(0, Math.min(COMMENT_CAP, Number(q.get('n')) || 0));
      const now = Date.now();
      const more = Array.from({ length: n }, (_, i) => ({ id: sha(`mpfy-mock-many-${tid}-${i}`).slice(0, 32), trackId: tid, from: sha(`mpfy-mock-person-${i}`).slice(0, 32), at: now - (i + 1) * 60000, text: `commento di prova ${i + 1}` }));
      srv.comments.set(tid, [...(srv.comments.get(tid) || []), ...more].sort((a, b) => b.at - a.at).slice(0, COMMENT_CAP));
    }
    // lyrics=<trackId>&source=<id>&kind=synced|plain|instrumental|none: its lyrics there now.
    if (q.has('lyrics') && srv && findTrack(srv, q.get('lyrics'))) {
      const tid = q.get('lyrics');
      const kind = q.get('kind') || 'synced';
      if (kind === 'none') srv.lyrics.delete(tid);
      else if (kind === 'plain') srv.lyrics.set(tid, { kind: 'plain', text: "Una riga ferma\nun'altra ancora", from: 'lrc' });
      else if (kind === 'instrumental') srv.lyrics.set(tid, { kind: 'instrumental', from: 'lrclib' });
      else srv.lyrics.set(tid, { kind: 'synced', lines: timed(['Prima riga di prova', 'seconda riga di prova', 'terza riga di prova', 'quarta riga di prova'], 3, 8), from: 'lrc' });
      changedShared(srv, { tracks: [tid] });
    }
    return text(`songs: failPosts ${so.failPosts}, getMs ${so.getMs}, invisible ${so.invisible.join(',') || 'none'}`);
  }
  if (p === '/__mock/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const pid = actor();
    res.end(
      JSON.stringify({
        paired,
        phone: phone ? { home: phoneHome(), holds: phone.holds, state: phone.state, tracks: phone.db.tracks.map((t) => t.id), same: phone.all.slice(0, 20).map((t) => t.id), shadow: { key: phone.shadow.key, size: phone.shadow.ids.size, puts: phone.shadow.puts }, moved: phone.moved, forwarded: phone.forwarded || 0, user: userOf(phone) } : null,
        profile: device.profile,
        photo: device.photo ? { hash: device.photo.hash, size: device.photo.bytes.length } : null,
        photoPuts: device.photoPuts,
        social: { on: device.social.on, privacy: device.social.privacy, patches: device.social.patches, activity: device.social.activity, peopleGets: device.social.peopleGets, recentsGets: device.social.recentsGets, people: device.social.people.map((x) => ({ id: x.id, pid: pidOf(x.id), name: x.name, seen: x.seen, photo: x.photo ? x.photo.hash : null, now: x.now, last: x.last, chat: directIdOf(device.profile?.id || '', x.id) })) },
        chat: {
          level: device.chat.level,
          posts: device.chat.posts,
          reads: device.chat.reads,
          deletes: device.chat.deletes,
          gets: device.chat.gets,
          mutes: device.chat.mutes,
          blocked: device.chat.blocked,
          convs: [...device.chat.convs.values()].map((c) => ({ id: c.id, kind: c.kind, with: c.with || null, source: c.source || null, count: c.messages.filter((m) => !m.deleted).length, last: c.messages.length ? c.messages[c.messages.length - 1].id : null, ids: c.messages.filter((m) => !m.deleted).map((m) => m.id) })),
        },
        songs: {
          gets: device.songs.gets,
          posts: device.songs.posts,
          deletes: device.songs.deletes,
          lyricsGets: device.songs.lyricsGets,
          lyricsPuts: device.songs.lyricsPuts,
          lyricsDeletes: device.songs.lyricsDeletes,
          sources: [...servers.values()].map((s) => ({
            id: s.id,
            social: socialOf(s),
            comments: Object.fromEntries([...(s.comments || new Map())].map(([tid, list]) => [tid, list.map((c) => ({ id: c.id, from: c.from, at: c.at, text: c.text }))])),
            lyrics: Object.fromEntries([...(s.lyrics || new Map())].map(([tid, l]) => [tid, l.kind])),
          })),
        },
        recovery: device.recovery,
        profileCode: device.profile ? profileCodeOf(device.secret) : null,
        anyProfileCode: profileCodeOf('mpfy-mock-another-secret'),
        strangerProfileCode: profileCodeOf('mpfy-mock-stranger-secret'),
        servers: [...servers.values()].map((s) => ({
          id: s.id,
          name: s.name,
          named: s.named,
          role: roleOn(s),
          legacy: s.legacy,
          details: s.details,
          code: showCode(s.code),
          connected: s.connected,
          rttMs: s.rttMs,
          linkKbps: s.linkKbps,
          version: s.db.version,
          tracks: s.db.tracks.length,
          trackList: s.db.tracks.map((t) => ({ id: t.id, title: t.title, album: t.album, fileHash: t.fileHash, uploaders: t.uploaders })),
          playlists: userOf(s, pid).playlists.map((x) => x.name),
          playlistData: userOf(s, pid).playlists,
          likes: userOf(s, pid).likes.length,
          likeIds: userOf(s, pid).likes.map((x) => x.id),
          clients: s.clients.length,
          sessions: [...s.sessions.values()].map((x) => ({ id: x.id, name: x.name, offset: x.offset, size: x.size, done: x.done, profileId: x.profileId, puts: x.puts })),
        })),
      })
    );
    return undefined;
  }
  return text('unknown mock helper');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p.startsWith('/__mock/')) return mockHelper(url, res);
    if (!originOk(req, p)) throw new HttpError(403, 'Richiesta rifiutata');
    if (p.startsWith('/local/')) {
      if (DELAY > 0) await sleep(DELAY);
      return await local(req, res, p, url);
    }
    if (p.startsWith('/__native/')) throw new HttpError(404, 'Risorsa non trovata');
    const sm = /^\/s\/([^/]+)(\/.*)$/.exec(p);
    if (sm) {
      const id = decodeURIComponent(sm[1]);
      if (id === PHONE_ID && phone) return await phoneRoute(req, res, sm[2], url);
      const srv = paired.some((x) => x.id === id) ? servers.get(id) : null;
      if (!srv) throw new HttpError(404, 'Fonte sconosciuta');
      if (!srv.connected) {
        await sleep(OFFLINE_WAIT); // the core waits for the link before giving up
        if (!srv.connected) throw new HttpError(503, 'Fonte non raggiungibile');
      }
      return await handleSource(srv, req, res, sm[2], url);
    }
    if (p.startsWith('/api/')) throw new HttpError(404, 'Usa /s/<fonte>/api/...');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito');
    await serveStatic(req, res, p);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const body = err instanceof HttpError ? { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) } : { error: 'Errore interno' };
    if (!res.headersSent) {
      if (!req.complete) req.resume();
      sendJson(req, res, status, body);
    } else res.destroy();
  }
  return undefined;
});

buildSample();
server.listen(PORT, '127.0.0.1', () => {
  actualPort = server.address().port;
  const list = [...servers.values()].map((s) => `${s.name} (${s.id})`).join(', ');
  console.log(`MPfy mock: http://127.0.0.1:${actualPort}/  fonti: ${list}; collegate: ${paired.length}`);
  console.log(`MOCK_PORT=${actualPort}`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
