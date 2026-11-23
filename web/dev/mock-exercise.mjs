// Starts web/dev/mock-server.mjs on a free port, walks the API flows the UI uses (the client
// core's /local/... and the source API under /s/<id>/api/...: library with the user part,
// profiles and roles, the profile photo, uploads in one PUT and in sessions, the "maybe" choice,
// the password recovery, the people, the social settings, the activity and your plays, the chats:
// the list and its 304, messages and pages, sends, deletes, read marks, silences, the shared cards,
// a shared playlist, blocks; the songs part: comments with their ETag and 304, one per author,
// the rules and codes, the owner's delete, hidden authors, the rate limit; lyrics with their ETag,
// an .lrc put in every time tag form, beside=1, plain, the limits, the rights, the library flag
// and its version, a source below 3), then stops it.
// Usage: node web/dev/mock-exercise.mjs <log file>   (exit 1 when a check fails)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const logFile = process.argv[2];
const out = [];
const log = (...a) => out.push(a.join(' '));
let fails = 0;
const check = (cond, label) => {
  log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

const child = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '0', MOCK_OFFLINE_WAIT: '300', MOCK_PAIR_DELAY: '50', MOCK_SOURCES: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('mock did not start')), 15000);
  child.stdout.on('data', (d) => {
    buf += d;
    const m = /MOCK_PORT=(\d+)/.exec(buf);
    if (m) {
      clearTimeout(t);
      log(buf.split('\n')[0]);
      resolve(Number(m[1]));
    }
  });
  child.on('exit', (code) => reject(new Error(`mock exited ${code}: ${stderr}`)));
});
const base = `http://127.0.0.1:${port}`;

async function j(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { res, data };
}
const jpegBytes = (seed) => {
  const b = Buffer.alloc(600, seed);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
};

try {
  // ---- static shell ----
  const root = await fetch(base + '/');
  const html = await root.text();
  check(root.status === 200 && html.includes('<title>MPfy</title>') && root.headers.get('content-security-policy')?.includes("img-src 'self' blob: data:"), `GET / -> ${root.status}, title MPfy, CSP ${root.headers.get('content-security-policy') ? 'present' : 'missing'}`);
  const icon = await fetch(base + '/icons/mpfy-192.png');
  const png = Buffer.from(await icon.arrayBuffer());
  check(icon.status === 200 && icon.headers.get('content-type') === 'image/png' && png.readUInt32BE(16) === 192, `GET /icons/mpfy-192.png -> ${icon.status} ${icon.headers.get('content-type')} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  const mf = await fetch(base + '/manifest.webmanifest');
  const M = await mf.json();
  check(mf.headers.get('content-type').startsWith('application/manifest+json') && M.name === 'MPfy' && M.icons.length === 2, `GET /manifest.webmanifest -> ${mf.headers.get('content-type')} name=${M.name}`);
  const spa = await fetch(base + '/impostazioni/fonte/abc');
  check(spa.status === 200 && (await spa.text()).includes('id="app"'), `SPA fallback for /impostazioni/fonte/abc -> ${spa.status}`);
  const old = await j('GET', '/api/library');
  check(old.res.status === 404, `the v1 path /api/library is gone -> ${old.res.status} ${JSON.stringify(old.data)}`);

  // ---- /local/sources ----
  let S = (await j('GET', '/local/sources')).data.sources;
  check(S.length === 2 && S.filter((s) => s.principal).length === 1 && S.every((s) => s.connected && Number.isFinite(s.rttMs)), `GET /local/sources -> ${S.map((s) => `${s.name}(${s.id}${s.principal ? ', principale' : ''}, ${s.rttMs} ms)`).join(', ')}`);
  const mi = S.find((s) => s.name === 'Mi A2');
  const vps = S.find((s) => s.name === 'VPS prova');
  check(mi.principal && !vps.principal, 'Mi A2 is the principal');

  // ---- libraries, union ----
  const LA = await fetch(`${base}/s/${mi.id}/api/library`, { headers: { 'Accept-Encoding': 'gzip' } });
  const libA = await LA.json();
  const LB = await fetch(`${base}/s/${vps.id}/api/library`);
  const libB = await LB.json();
  const idsA = new Set(libA.tracks.map((t) => t.id));
  const idsB = new Set(libB.tracks.map((t) => t.id));
  const both = [...idsA].filter((id) => idsB.has(id));
  const union = new Set([...idsA, ...idsB]);
  check(libA.tracks.length === 45 && libB.tracks.length === 35 && both.length === 15 && union.size === 65, `libraries: Mi A2 ${idsA.size}, VPS ${idsB.size} (5 of them other files of Mi A2 songs), on both ${both.length}, union ${union.size}`);
  check(libA.you?.role === 'owner' && libB.you?.role === 'member' && libA.source?.name === 'Mi A2', `you: owner on the Mi A2, member on the VPS (${JSON.stringify([libA.you, libB.you])})`);
  check(libA.tracks.every((t) => typeof t.mine === 'boolean' && typeof t.others === 'boolean' && !('uploaders' in t) && t.fileHash && t.fp?.s && Number.isFinite(t.score)), 'tracks carry fileHash, fp, score, mine and others, never uploaders');
  const have = await j('GET', `/s/${mi.id}/api/library?have=${libA.version}`);
  check(have.data.tracks === null && !('track' in have.data.covers) && Array.isArray(have.data.likes), '?have=<current version>: tracks null, the user part only');
  const haveOld = await j('GET', `/s/${mi.id}/api/library?have=1`);
  check(Array.isArray(haveOld.data.tracks) && haveOld.data.tracks.length === 45, '?have=<an old version>: every track');
  check(['tracks', 'playlists', 'likes', 'recents', 'covers'].every((k) => k in libA) && libA.covers.track && libA.covers.album && libA.covers.playlist, `library has covers map: ${JSON.stringify(Object.keys(libA.covers))}`);
  check(libA.tracks.every((t) => t.qualities && typeof t.qualities.low === 'boolean'), 'every track has qualities');
  const foreignInPl = libA.playlists[0].trackIds.filter((id) => !idsA.has(id));
  check(foreignInPl.length > 0 && foreignInPl.every((id) => idsB.has(id)), `principal playlist "${libA.playlists[0].name}" holds ${foreignInPl.length} VPS-only track ids`);
  const nm = await fetch(`${base}/s/${mi.id}/api/library`, { headers: { 'If-None-Match': LA.headers.get('etag') } });
  check(nm.status === 304, `library If-None-Match -> ${nm.status}`);

  // ---- stream with ?q= and X-MPfy-Quality ----
  const t = libA.tracks.find((x) => x.qualities.normal && !x.qualities.high);
  const hq = await fetch(`${base}/s/${mi.id}/api/stream/${t.id}?q=high`, { method: 'HEAD' });
  check(hq.status === 200 && hq.headers.get('x-mpfy-quality') === 'normal', `HEAD ?q=high, high not made -> served ${hq.headers.get('x-mpfy-quality')}`);
  const mq = await fetch(`${base}/s/${mi.id}/api/stream/${t.id}?q=max`, { headers: { Range: 'bytes=0-43' } });
  const hdr = Buffer.from(await mq.arrayBuffer());
  check(mq.status === 206 && mq.headers.get('x-mpfy-quality') === 'max' && hdr.subarray(0, 4).toString() === 'RIFF', `GET ?q=max Range 0-43 -> ${mq.status} ${mq.headers.get('content-range')} quality ${mq.headers.get('x-mpfy-quality')}`);
  const pending = libA.tracks.find((x) => !x.qualities.low);
  const lq = await fetch(`${base}/s/${mi.id}/api/stream/${pending.id}?q=low`, { method: 'HEAD' });
  check(lq.headers.get('x-mpfy-quality') === 'max', `?q=low with no transcode ready -> ${lq.headers.get('x-mpfy-quality')}`);
  S = (await j('GET', '/local/sources')).data.sources;
  check(S.find((s) => s.id === mi.id).throughputKbps > 0, `throughput measured after a stream: ${S.find((s) => s.id === mi.id).throughputKbps} kbps`);

  // ---- covers small / large ----
  const cs = await fetch(`${base}/s/${mi.id}/api/cover/${t.coverId}?size=small`);
  const cl = await fetch(`${base}/s/${mi.id}/api/cover/${t.coverId}?size=large`);
  const bs = Buffer.from(await cs.arrayBuffer());
  const bl = Buffer.from(await cl.arrayBuffer());
  check(cs.status === 200 && bs.readUInt32BE(16) === 160 && bl.readUInt32BE(16) === 640, `cover ?size=small ${bs.readUInt32BE(16)} px (${bs.length} B), ?size=large ${bl.readUInt32BE(16)} px (${bl.length} B)`);
  const vpsOnlyCover = libB.tracks.find((x) => !idsA.has(x.id)).coverId;
  const nc = await fetch(`${base}/s/${mi.id}/api/cover/${vpsOnlyCover}?size=small`);
  check(nc.status === 404, `a cover the Mi A2 does not have -> ${nc.status}`);

  // ---- cover-for (custom covers on the principal) ----
  const alId = '0123456789abcdef';
  const p1 = await fetch(`${base}/s/${mi.id}/api/cover-for/album/${alId}?size=large`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpegBytes(7) });
  const p2 = await fetch(`${base}/s/${mi.id}/api/cover-for/album/${alId}?size=small`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpegBytes(9) });
  const C = (await p2.json()).covers;
  check(p1.status === 200 && C.album[alId]?.large && C.album[alId]?.small && C.album[alId].large !== C.album[alId].small, `PUT cover-for album large then small -> ${JSON.stringify(C.album[alId])}`);
  const got = await fetch(`${base}/s/${mi.id}/api/cover/${C.album[alId].large}?size=large`);
  check(got.status === 200 && got.headers.get('content-type') === 'image/jpeg', `the custom cover is served -> ${got.status} ${got.headers.get('content-type')}`);
  const bad = await fetch(`${base}/s/${mi.id}/api/cover-for/album/${alId}?size=large`, { method: 'PUT', body: Buffer.from('not an image at all') });
  check(bad.status === 415, `PUT cover-for with text -> ${bad.status}`);
  const del = await j('DELETE', `/s/${mi.id}/api/cover-for/album/${alId}`);
  check(del.res.status === 200 && !del.data.covers.album[alId], 'DELETE cover-for -> back to the automatic cover');

  // ---- foreign ids in user data ----
  const foreign = [...idsB].find((id) => !idsA.has(id));
  const np = await j('POST', `/s/${mi.id}/api/playlists`, { name: 'Prova esercizio' });
  const pa = await j('PATCH', `/s/${mi.id}/api/playlists/${np.data.playlist.id}`, { trackIds: [foreign, [...idsA][0]] });
  check(pa.res.status === 200 && pa.data.playlist.trackIds[0] === foreign, 'PATCH playlist with a VPS-only track id on the Mi A2: kept');
  const lk = await j('PUT', `/s/${mi.id}/api/likes/${foreign}`);
  check(lk.res.status === 200 && lk.data.likes.some((x) => x.id === foreign), 'PUT like of a foreign track id: kept');
  const badId = await j('PUT', `/s/${mi.id}/api/likes/not-an-id`);
  check(badId.res.status === 400, `PUT like with a malformed id -> ${badId.res.status}`);
  const at = Date.now() - 3 * 3600000;
  await j('POST', `/s/${mi.id}/api/played`, { trackId: foreign, context: { type: 'library', id: null }, at });
  const after = (await j('GET', `/s/${mi.id}/api/library`)).data;
  check(after.recents.some((r) => r.trackId === foreign && r.at === at), 'POST played with "at" 3 hours ago keeps that time');
  await j('DELETE', `/s/${mi.id}/api/playlists/${np.data.playlist.id}`);

  // ---- upload to the second source ----
  const wav = Buffer.alloc(44 + 22050);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + 22050, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(11025, 24);
  wav.writeUInt32LE(22050, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(22050, 40);
  const up = await fetch(`${base}/s/${vps.id}/api/upload/${encodeURIComponent('Prova su VPS.wav')}`, { method: 'PUT', body: wav });
  const U = await up.json();
  check(up.status === 201 && U.track.title === 'Prova su VPS' && U.track.qualities, `PUT upload to the VPS -> ${up.status} "${U.track?.title}"`);
  const delT = await j('DELETE', `/s/${vps.id}/api/tracks/${U.track.id}`);
  check(delT.data?.ok === true, 'DELETE the track from the VPS');

  // ---- health and admin ----
  const hA = (await j('GET', `/s/${mi.id}/api/health`)).data;
  check(hA.ok && hA.name === 'Mi A2' && hA.version && Number.isFinite(hA.diskFreeBytes) && hA.ffmpeg === true, `health: ${JSON.stringify(hA)}`);
  const code1 = (await j('GET', `/s/${mi.id}/api/admin/code`)).data.code;
  check(/^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/.test(code1), `admin/code -> ${code1}`);
  const code2 = (await j('POST', `/s/${mi.id}/api/admin/code/rotate`)).data.code;
  check(code2 !== code1 && /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/.test(code2), `admin/code/rotate -> ${code2}`);
  let cl1 = (await j('GET', `/s/${mi.id}/api/admin/clients`)).data.clients;
  check(cl1.length === 4 && cl1.filter((c) => c.you).length === 1 && cl1.some((c) => c.profileName === 'Giulia') && cl1.some((c) => c.profileId === null), `admin/clients (the owner sees everyone's, with profiles) -> ${cl1.map((c) => `${c.name}${c.you ? ' (questo)' : ''}:${c.profileName || '-'}`).join(', ')}`);
  const other = cl1.find((c) => !c.you);
  await j('DELETE', `/s/${mi.id}/api/admin/clients/${other.publicKey}`);
  cl1 = (await j('GET', `/s/${mi.id}/api/admin/clients`)).data.clients;
  check(cl1.length === 3 && cl1.some((c) => c.you), 'DELETE admin/clients/<key> removes the other device');
  const clB = (await j('GET', `/s/${vps.id}/api/admin/clients`)).data.clients;
  check(clB.every((c) => c.profileId === libB.you.profileId || c.you), `a member sees only its own devices: ${clB.map((c) => c.name).join(', ')}`);
  const rotB = await j('POST', `/s/${vps.id}/api/admin/code/rotate`);
  check(rotB.res.status === 403 && rotB.data.code === 'forbidden', `a member cannot change the code -> ${rotB.res.status} ${rotB.data.code}`);

  // ---- CSRF guard ----
  const csrf = await j('POST', '/local/sources', { code: code1 }, { Origin: 'http://evil.example' });
  check(csrf.res.status === 403, `POST /local/sources with a foreign Origin -> ${csrf.res.status}`);
  const own = await j('PATCH', `/local/sources/${vps.id}`, { principal: false }, { Origin: base });
  check(own.res.status === 200, `PATCH with our own Origin -> ${own.res.status}`);
  const alias = await j('PATCH', `/local/sources/${vps.id}`, { name: 'Altro nome' });
  check(alias.res.status === 400, `PATCH /local/sources with a name (no local aliases) -> ${alias.res.status}`);

  // ---- offline source ----
  await fetch(`${base}/__mock/offline?source=${vps.id}&on=1`);
  S = (await j('GET', '/local/sources')).data.sources;
  const vOff = S.find((s) => s.id === vps.id);
  check(!vOff.connected && vOff.rttMs === null && vOff.lastError, `VPS offline in /local/sources: connected=${vOff.connected} lastError="${vOff.lastError}"`);
  const t0 = Date.now();
  const off = await j('GET', `/s/${vps.id}/api/health`);
  check(off.res.status === 503 && off.data.error === 'Fonte non raggiungibile' && Date.now() - t0 >= 250, `request to the offline VPS -> ${off.res.status} after ${Date.now() - t0} ms ${JSON.stringify(off.data)}`);
  await fetch(`${base}/__mock/offline?source=${vps.id}&on=0`);
  check((await j('GET', `/s/${vps.id}/api/health`)).res.status === 200, 'VPS back online');

  // ---- add, rename, principal, remove ----
  const badCode = await j('POST', '/local/sources', { code: 'MPFY-1234' });
  check(badCode.res.status === 400 && badCode.data.error === 'Codice non valido', `POST a short code -> ${badCode.res.status} "${badCode.data.error}"`);
  const zeros = await j('POST', '/local/sources', { code: 'mpfy 0000 0000 0000 0000 oooo 0000 0000 0000' });
  check(zeros.res.status === 504 && /raggiungibile/.test(zeros.data.error), `POST an all-zero code (lowercase, spaces, O for 0) -> ${zeros.res.status} "${zeros.data.error}"`);
  const dup = await j('POST', '/local/sources', { code: code2 });
  check(dup.res.status === 200 && dup.data.source.id === mi.id, `POST the code of a source already paired -> ${dup.res.status} (the same source)`);
  const pcode = await j('POST', '/local/sources', { code: (await (await fetch(`${base}/__mock/state`)).json()).profileCode });
  check(pcode.res.status === 400 && pcode.data.code === 'profile_code', `POST a profile code as a source code -> ${pcode.res.status} ${pcode.data.code}`);
  const add = await j('POST', '/local/sources', { code: 'MPFY-7K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12', name: 'Telefono vecchio' });
  check(add.res.status === 201 && add.data.source.name === 'Nuova fonte 1' && !add.data.source.principal && add.data.source.role === 'owner' && add.data.source.named === false, `POST a new code (the name is the source's own) -> ${add.res.status} ${JSON.stringify(add.data.source)}`);
  const nid = add.data.source.id;
  const ren = await j('PATCH', `/s/${nid}/api/admin/source`, { name: 'Redmi di casa' });
  const S2 = (await j('GET', '/local/sources')).data.sources.find((x) => x.id === nid);
  check(ren.res.status === 200 && ren.data.source.named && S2.name === 'Redmi di casa' && S2.named === true, 'PATCH admin/source: the owner names the source');
  const badName = await j('PATCH', `/s/${nid}/api/admin/source`, { name: 'x'.repeat(41) });
  check(badName.res.status === 400 && badName.data.code === 'bad_name', `a name of 41 characters -> ${badName.res.status} ${badName.data.code}`);
  const memberName = await j('PATCH', `/s/${vps.id}/api/admin/source`, { name: 'Mio' });
  check(memberName.res.status === 403, `a member cannot rename the source -> ${memberName.res.status}`);
  await j('PATCH', `/local/sources/${nid}`, { principal: true });
  S = (await j('GET', '/local/sources')).data.sources;
  check(S.length === 3 && S.find((s) => s.id === nid).principal && S.filter((s) => s.principal).length === 1, 'PATCH principal: exactly one principal, the new one');
  const libN = (await j('GET', `/s/${nid}/api/library`)).data;
  check(libN.tracks.length === 0 && libN.playlists.length === 0, 'the new source starts empty');
  const rm = await j('DELETE', `/local/sources/${nid}`);
  S = (await j('GET', '/local/sources')).data.sources;
  check(rm.data.ok && S.length === 2 && S.filter((s) => s.principal).length === 1, `DELETE the principal: ${S.find((s) => s.principal).name} becomes principal`);
  const gone = await j('GET', `/s/${nid}/api/health`);
  check(gone.res.status === 404, `a removed source -> ${gone.res.status} ${JSON.stringify(gone.data)}`);

  // ---- profile ----
  const pr = (await j('GET', '/local/profile')).data;
  check(pr.profile?.name === 'Bacca' && pr.fileName === 'Bacca.mpfy' && pr.recovery === false, `GET /local/profile -> ${JSON.stringify(pr)}`);
  const again = await j('POST', '/local/profile', { name: 'Altro' });
  check(again.res.status === 409 && again.data.code === 'profile_exists', 'a second profile: 409 profile_exists');
  const rn = await j('PATCH', '/local/profile', { name: '  Bacca   B  ' });
  check(rn.data.profile.name === 'Bacca B', 'PATCH /local/profile cleans the name');
  const longName = await j('PATCH', '/local/profile', { name: 'x'.repeat(41) });
  check(longName.res.status === 400 && longName.data.code === 'bad_name', 'a name of 41 characters: bad_name');
  const emoji = await j('PATCH', '/local/profile', { name: 'B'.repeat(39) + String.fromCodePoint(0x1f3b5) });
  check(emoji.res.status === 200, '40 code points with an emoji at the end are fine');
  await j('PATCH', '/local/profile', { name: 'Bacca' });
  const pc = (await j('GET', '/local/profile/code')).data.code;
  check(/^MPFY-P(-[0-9A-HJKMNP-TV-Z]{4}){14}$/.test(pc), `GET /local/profile/code -> ${pc}`);
  const ex = (await j('GET', '/local/profile/export')).data;
  check(ex.fileName === 'Bacca.mpfy' && ex.identity.format === 'mpfy-identity' && ex.identity.v === 1 && ex.identity.sources.length === 2, 'GET /local/profile/export: the identity file');
  const shortPw = await j('PUT', '/local/profile/recovery', { password: 'corta' });
  check(shortPw.res.status === 400 && shortPw.data.code === 'short_password', 'a short password: short_password');
  const on = await j('PUT', '/local/profile/recovery', { password: 'una frase breve' });
  check(on.data.recovery === true && Object.values(on.data.sources).every((x) => x === 'ok'), `recovery on: every connected source has the blob ${JSON.stringify(on.data.sources)}`);
  const offR = await j('DELETE', '/local/profile/recovery');
  check(offR.data.recovery === false, 'recovery off');

  // ---- the profile photo ----
  const photoOf = (n, seed = 3) => {
    const b = Buffer.alloc(n, seed);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    b[n - 2] = 0xff;
    b[n - 1] = 0xd9;
    return b;
  };
  const putPhoto = (body, type = 'image/jpeg') => fetch(`${base}/local/profile/photo`, { method: 'PUT', headers: { 'Content-Type': type }, body });
  check((await j('GET', '/local/profile')).data.profile.photo === null, 'GET /local/profile: photo null at first');
  const none = await j('GET', '/local/profile/photo');
  check(none.res.status === 404 && none.data.code === 'no_photo', `GET /local/profile/photo with none -> ${none.res.status} ${none.data.code}`);
  const ph = photoOf(2000);
  const phHash = crypto.createHash('sha256').update(ph).digest('hex');
  const set = await putPhoto(ph);
  const SET = await set.json();
  check(set.status === 200 && SET.profile.photo === phHash, `PUT a JPEG: the profile names it by its SHA-256 (${SET.profile?.photo?.slice(0, 12)})`);
  check((await j('GET', '/local/profile')).data.profile.photo === phHash, 'GET /local/profile: the photo hash');
  const photoGot = await fetch(`${base}/local/profile/photo?v=${phHash}`);
  const gotBytes = Buffer.from(await photoGot.arrayBuffer());
  check(photoGot.status === 200 && photoGot.headers.get('content-type') === 'image/jpeg' && photoGot.headers.get('etag') === `"${phHash}"` && photoGot.headers.get('cache-control') === 'no-cache' && gotBytes.equals(ph), `GET the photo: its bytes, image/jpeg, ETag, no-cache (${photoGot.status}, ${gotBytes.length} bytes)`);
  const same = await fetch(`${base}/local/profile/photo`, { headers: { 'If-None-Match': `"${phHash}"` } });
  check(same.status === 304, `If-None-Match with its hash -> ${same.status}`);
  const head = await fetch(`${base}/local/profile/photo`, { method: 'HEAD' });
  check(head.status === 200 && head.headers.get('content-length') === String(ph.length) && (await head.arrayBuffer()).byteLength === 0, `HEAD: the length, no body (${head.headers.get('content-length')})`);
  const photoPng = await putPhoto(ph, 'image/png');
  check(photoPng.status === 400 && (await photoPng.json()).code === 'bad_photo', 'another type: 400 bad_photo');
  const noEnd = Buffer.from(ph);
  noEnd[noEnd.length - 1] = 0;
  const photoCut = await putPhoto(noEnd);
  check(photoCut.status === 400 && (await photoCut.json()).code === 'bad_photo', 'no FF D9 at the end: 400 bad_photo');
  const big = await putPhoto(photoOf(48 * 1024 + 1));
  check(big.status === 400 && (await big.json()).code === 'bad_photo', 'one byte above 48 KB: 400 bad_photo');
  const huge = await putPhoto(photoOf(200 * 1024));
  check(huge.status === 413 && (await huge.json()).code === 'too_large', `far above: 413 too_large (${huge.status})`);
  const edge = await putPhoto(photoOf(48 * 1024, 5));
  check(edge.status === 200, 'exactly 48 KB is taken');
  check((await j('GET', '/local/profile')).data.profile.photo === crypto.createHash('sha256').update(photoOf(48 * 1024, 5)).digest('hex'), 'the newer photo replaces the older');
  await fetch(`${base}/__mock/core?photoFail=1`);
  const failed = await putPhoto(ph);
  await fetch(`${base}/__mock/core?photoFail=0`);
  check(failed.status === 503, `photoFail=1: the PUT answers ${failed.status}`);
  const photoDel = await j('DELETE', '/local/profile/photo');
  check(photoDel.res.status === 200 && photoDel.data.profile.photo === null, 'DELETE: photo null');
  const photoAfter = await j('GET', '/local/profile/photo');
  check(photoAfter.res.status === 404 && photoAfter.data.code === 'no_photo', 'and its bytes are gone: 404 no_photo');
  const del2 = await j('DELETE', '/local/profile/photo');
  check(del2.res.status === 200 && del2.data.profile.photo === null, 'DELETE with no photo: still a 200');
  await fetch(`${base}/__mock/core?noProfiles=1`);
  const photoOld = await j('GET', '/local/profile');
  await fetch(`${base}/__mock/core?noProfiles=0`);
  check(photoOld.res.status === 404, `noProfiles=1: a core from before profiles, GET /local/profile -> ${photoOld.res.status}`);

  // ---- uploads: sessions, maybe, a better file ----
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3 * 1048576 + 7, 1)]);
  const headHash = crypto.createHash('sha256').update(mp3.subarray(0, 65536)).digest('hex');
  const sess = (await j('POST', `/s/${mi.id}/api/uploads`, { name: 'Sessione.mp3', size: mp3.length, lastModified: 5, headHash })).data;
  check(sess.id && sess.offset === 0 && sess.chunkBytes === 8388608, `POST /api/uploads -> ${JSON.stringify(sess)}`);
  const resumed = await j('POST', `/s/${mi.id}/api/uploads`, { name: 'Sessione.mp3', size: mp3.length, lastModified: 5, headHash });
  check(resumed.res.status === 200 && resumed.data.id === sess.id, 'the same file again resumes the session');
  const c1 = await fetch(`${base}/s/${mi.id}/api/uploads/${sess.id}?offset=0`, { method: 'PUT', body: mp3.subarray(0, 2 * 1048576) });
  check((await c1.json()).offset === 2 * 1048576, 'a chunk moves the offset');
  const wrong = await fetch(`${base}/s/${mi.id}/api/uploads/${sess.id}?offset=5`, { method: 'PUT', body: mp3.subarray(0, 10) });
  const W = await wrong.json();
  check(wrong.status === 409 && W.code === 'offset_mismatch' && W.offset === 2 * 1048576, `a wrong offset -> 409 with the stored offset ${W.offset}`);
  const c2 = await fetch(`${base}/s/${mi.id}/api/uploads/${sess.id}?offset=${2 * 1048576}`, { method: 'PUT', body: mp3.subarray(2 * 1048576) });
  const C2 = await c2.json();
  check(C2.done && C2.result.outcome === 'added' && C2.result.track.title === 'Sessione', `the last chunk: done, ${C2.result?.outcome}`);
  const atEnd = await fetch(`${base}/s/${mi.id}/api/uploads/${sess.id}?offset=${mp3.length}`, { method: 'PUT', body: Buffer.alloc(1) });
  check(atEnd.status === 409, 'a PUT on a finished session is 409');
  const maybe = await fetch(`${base}/s/${mi.id}/api/upload/${encodeURIComponent('Nebbia [forse].mp3')}`, { method: 'PUT', body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 9)]) });
  const MB = await maybe.json();
  check(MB.outcome === 'maybe' && MB.pending.match.title === 'Nebbia', `"<title> [forse]" asks: ${MB.outcome} about ${MB.pending?.match?.title}`);
  const ch = await j('POST', `/s/${mi.id}/api/pending/${MB.pending.id}`, { keep: 'both' });
  check(ch.data.outcome === 'added', 'keeping both adds it');
  const better = await fetch(`${base}/s/${mi.id}/api/upload/${encodeURIComponent('Nebbia [hq].mp3')}`, { method: 'PUT', body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 8)]) });
  check((await better.json()).outcome === 'replaced', '"<title> [hq]" replaces');

  // ---- recovery from a new device ----
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  const st0 = await (await fetch(`${base}/__mock/state`)).json();
  const rec = await j('POST', '/local/recovery', { code: st0.servers[0].code });
  check(rec.data.sessionId && rec.data.entries.some((e) => e.name === 'Bacca') && rec.data.entries.some((e) => e.name === 'Giulia'), `POST /local/recovery: who can be recovered: ${rec.data.entries?.map((e) => `${e.name}/${e.deviceName}`).join(', ')}`);
  const me = rec.data.entries.find((e) => e.name === 'Bacca');
  const wpw = await j('POST', `/local/recovery/${rec.data.sessionId}`, { ...me, password: 'sbagliata' });
  check(wpw.res.status === 403 && wpw.data.code === 'wrong_password' && wpw.data.triesLeft === 4, `a wrong password: ${wpw.res.status} ${wpw.data.code}, ${wpw.data.triesLeft} tries left`);
  const okpw = await j('POST', `/local/recovery/${rec.data.sessionId}`, { ...me, password: 'una frase breve' });
  check(okpw.res.status === 200 && okpw.data.profile.name === 'Bacca' && okpw.data.sources.length >= 1, `the right password: the profile and its sources (${okpw.data.sources?.length})`);

  // ---- "Cerca i dettagli in rete", profiles, measured quality ----
  await fetch(`${base}/__mock/reset?sources=2`);
  const st2 = await (await fetch(`${base}/__mock/state`)).json();
  const miD = st2.servers.find((s) => s.name === 'Mi A2');
  const vpsD = st2.servers.find((s) => s.name === 'VPS prova');
  S = (await j('GET', '/local/sources')).data.sources;
  check(S.every((s) => s.profiles === true), `/local/sources: profiles true for sources with profiles (${S.map((s) => s.profiles).join(', ')})`);
  let L0 = await j('GET', `/s/${miD.id}/api/library`);
  check(!('details' in L0.data.source), 'a source that does not say: no details in source');
  await fetch(`${base}/__mock/source?source=${miD.id}&details=1`);
  const tag0 = (await fetch(`${base}/s/${miD.id}/api/library`)).headers.get('etag');
  L0 = await j('GET', `/s/${miD.id}/api/library`);
  check(L0.data.source.details === true, 'details=1: source.details true in the library');
  const pd = await j('PATCH', `/s/${miD.id}/api/admin/source`, { details: false });
  check(pd.res.status === 200 && pd.data.source.details === false && pd.data.source.name === 'Mi A2', `PATCH { details: false }: ${pd.res.status} ${JSON.stringify(pd.data.source)}`);
  const after304 = await fetch(`${base}/s/${miD.id}/api/library`, { headers: { 'If-None-Match': tag0 } });
  check(after304.status === 200 && (await after304.json()).source.details === false, 'the old ETag after the switch: 200 with the new details');
  const pb = await j('PATCH', `/s/${miD.id}/api/admin/source`, { details: 'yes' });
  check(pb.res.status === 400 && pb.data.code === 'bad_request', `a details that is not a boolean: ${pb.res.status} ${pb.data.code}`);
  const pm = await j('PATCH', `/s/${vpsD.id}/api/admin/source`, { details: true });
  check(pm.res.status === 403, `a member: ${pm.res.status}`);
  await fetch(`${base}/__mock/source?source=${miD.id}&detailsFail=1`);
  const pf = await j('PATCH', `/s/${miD.id}/api/admin/source`, { details: true });
  check(pf.res.status === 500, `detailsFail=1: the PATCH answers ${pf.res.status}`);
  await fetch(`${base}/__mock/quality?on=1`);
  const LQ = await j('GET', `/s/${vpsD.id}/api/library`);
  const cut = LQ.data.tracks.filter((x) => x.codec === 'mp3');
  check(cut.length > 0 && cut.every((x) => x.cutoffHz === 17000 && x.equivKbps === 128 && x.score === 128), `quality?on=1: the mp3 320 copies cut at 17 kHz, ~128, score 128 (${cut.length})`);
  await fetch(`${base}/__mock/source?source=${vpsD.id}&legacy=1`);
  S = (await j('GET', '/local/sources')).data.sources;
  check(S.find((s) => s.id === vpsD.id)?.profiles === false, 'a source without profiles: profiles false');

  // ---- the people: the list, a page, a photo, the settings, the activity, your plays ----
  {
    await fetch(`${base}/__mock/reset`);
    S = (await j('GET', '/local/sources')).data.sources;
    check(S.length === 2 && S.every((s) => s.social === 3), `/local/sources: social 3 on both, the songs part with the chats and the people (${S.map((s) => s.social)})`);
    const prof = (await j('GET', '/local/profile')).data.profile;
    check(prof.pid === '4BF2-ASGW', `/local/profile: the profile ID ${prof.pid}`);
    const people = await j('GET', '/local/people');
    const pp = people.data.people;
    const named = pp.map((x) => `${x.name}${x.tag ? ':' + x.tag : ''}/${x.seen}`).sort().join(',');
    check(people.data.supported === true && /^[0-9a-f]{16}$/.test(people.data.v) && people.data.me.pid === '4BF2-ASGW' && people.data.me.tag === '4BF2', `/local/people: supported, v, you (${people.data.me.name} ${people.data.me.tag})`);
    check(named === 'Bacca:58XM/all,Chiara/chat,Giulia:MZ0Y/all,Giulia:RERY/all,Luca/all,Marco/all,Sara/all', `the people, the tags on clashes only, one seen in a chat only: ${named}`);
    const gi = pp.find((x) => x.tag === 'MZ0Y');
    check(!!gi.now && gi.now.title === 'Onda quadra' && gi.sources.length === 2 && /^[0-9a-f]{64}$/.test(gi.photo) && Object.keys(gi).sort().join() === 'blocked,chat,id,last,name,now,photo,pid,seen,sources,tag', `a person: every field (${Object.keys(gi).sort().join()})`);
    const v1 = people.data.v;
    check((await j('GET', '/local/people')).data.v === v1, 'the same people: the same v');
    await fetch(`${base}/__mock/social?stop=${gi.id}`);
    const after = await j('GET', '/local/people');
    check(after.data.v !== v1 && !after.data.people.find((x) => x.id === gi.id).now, 'she stopped: another v, no now');
    const page = await j('GET', `/local/people/${gi.id}`);
    check(page.res.status === 200 && page.data.person.id === gi.id && page.data.recent.length === 5 && page.data.recent.some((r) => r.artistPage === true), `her page: the person and ${page.data.recent.length} recent plays, one from an artist's page`);
    const nobody = await j('GET', '/local/people/ffffffffffffffffffffffffffffffff');
    check(nobody.res.status === 404 && nobody.data.code === 'not_found', `nobody: ${nobody.res.status} ${nobody.data.code}`);
    const photo = await fetch(`${base}/local/people/${gi.id}/photo?v=${gi.photo}`);
    const pbytes = Buffer.from(await photo.arrayBuffer());
    check(photo.status === 200 && photo.headers.get('cache-control') === 'private, max-age=31536000, immutable' && crypto.createHash('sha256').update(pbytes).digest('hex') === gi.photo, `her photo: the bytes of its hash, kept for good (${photo.headers.get('cache-control')})`);
    const nophoto = await j('GET', `/local/people/${pp.find((x) => x.name === 'Luca').id}/photo`);
    check(nophoto.res.status === 404 && nophoto.data.code === 'no_photo', `no photo: ${nophoto.res.status} ${nophoto.data.code}`);
    const soc = await j('GET', '/local/social');
    check(soc.data.supported === true && JSON.stringify(soc.data.privacy) === JSON.stringify({ invisible: false, showNow: true, privateSession: false, privateUntil: 0, showRecent: true, updatedAt: 0 }), `/local/social: ${JSON.stringify(soc.data.privacy)}`);
    const ps = await j('PATCH', '/local/social', { privateSession: true, showRecent: false });
    check(ps.res.status === 200 && ps.data.privacy.privateSession === true && ps.data.privacy.privateUntil > Date.now() + 5.9 * 3600000 && ps.data.privacy.showRecent === false && ps.data.privacy.updatedAt > 0, `PATCH: a private session for 6 hours, recent off (${JSON.stringify(ps.data.privacy)})`);
    const bad = await j('PATCH', '/local/social', { privateUntil: 5 });
    const bad2 = await j('PATCH', '/local/social', { showNow: 'yes' });
    check(bad.res.status === 400 && bad.data.code === 'bad_request' && bad2.res.status === 400, `PATCH of anything else: ${bad.res.status} ${bad.data.code}, ${bad2.res.status}`);
    await fetch(`${base}/__mock/social?patchFail=1`);
    check((await j('PATCH', '/local/social', { showNow: false })).res.status === 503, 'patchFail=1: the next PATCH answers 503');
    const t1 = (await j('GET', `/s/${S[0].id}/api/library`)).data.tracks[0];
    const act = await j('PUT', '/local/activity', { track: { trackId: t1.id, title: t1.title, artist: t1.artist, album: t1.album, artistPage: false }, playing: true });
    const act0 = await j('PUT', '/local/activity', { track: null, playing: false });
    const actBad = await j('PUT', '/local/activity', { track: { trackId: 'x', title: '' }, playing: true });
    const actBad2 = await j('PUT', '/local/activity', { track: null, playing: false, now: true });
    check(act.res.status === 200 && act.data.ok === true && act0.res.status === 200 && actBad.res.status === 400 && actBad2.res.status === 400, `PUT /local/activity: a track, nothing; a bad track and an extra field 400 (${actBad.res.status}, ${actBad2.res.status})`);
    const st = (await j('GET', '/__mock/state')).data.social;
    check(st.activity.length === 2 && st.patches.length === 2, `the mock keeps what it heard (the refused shapes never reach it) (${st.activity.length} reports, ${st.patches.length} PATCHes)`);
    await fetch(`${base}/__mock/social?history=250&step=60`);
    const r1 = await j('GET', `/s/${S[0].id}/api/recents?limit=100`);
    const r2 = await j('GET', `/s/${S[0].id}/api/recents?before=${r1.data.recents[99].at}&limit=100`);
    const r3 = await j('GET', `/s/${S[0].id}/api/recents?before=${r2.data.recents[99].at}&limit=500`);
    check(r1.data.recents.length === 100 && r1.data.more && r2.data.recents.length === 100 && r2.data.more && r3.data.recents.length === 50 && !r3.data.more && r2.data.recents[0].at < r1.data.recents[99].at && r1.data.recents.every((x, i, a) => !i || a[i - 1].at > x.at), '/api/recents: newest first, 100 a page, before, more, at most 200 a page');
    await fetch(`${base}/__mock/social?recents=0`);
    check((await j('GET', `/s/${S[0].id}/api/recents`)).res.status === 404, 'recents=0: an older principal answers 404');
    await fetch(`${base}/__mock/social?on=0`);
    const off = await j('GET', '/local/people');
    check((await j('GET', '/local/sources')).data.sources.every((s) => s.social === 0) && off.data.supported === false && off.data.people.length === 0, 'on=0: social 0, the people not supported, nobody listed');
    await fetch(`${base}/__mock/reset`);
  }

  // ---- the chats: the list and its v, a conversation, send, delete, read, mute, shared, block ----
  {
    await fetch(`${base}/__mock/reset`);
    const st = await (await fetch(`${base}/__mock/state`)).json();
    const conv = (pred) => st.chat.convs.find(pred);
    const SIS = 'a7c1e0d2b3f4051627384950a1b2c3d4';
    const giulia = conv((c) => c.with === SIS).id;
    const group = conv((c) => c.kind === 'group' && c.count > 0).id;
    const L = await j('GET', '/local/chat/conversations');
    const C = L.data.conversations;
    check(L.data.supported === true && /^[0-9a-f]{16}$/.test(L.data.v) && C[0].at >= C[C.length - 1].at && C.some((c) => c.kind === 'group' && c.last === null), `/local/chat/conversations: supported, v, newest first, the empty group listed (${C.map((c) => c.display).join(', ')})`);
    const unread = C.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0);
    check(L.data.unread === unread && C.some((c) => c.muted && c.unread > 0), `unread: the total of the ones not silenced (${L.data.unread})`);
    const g = C.find((c) => c.id === giulia);
    check(g.kind === 'direct' && g.with === SIS && g.display === 'Giulia \u00b7 MZ0Y' && g.last.name === 'Giulia \u00b7 MZ0Y' && typeof g.last.preview === 'string', `a direct conversation: with, display and the sender's name with the tag (${g.display})`);
    // The v the page holds, sent back: a 304 with no body (and no ETag); another one: the whole list.
    const same = await fetch(`${base}/local/chat/conversations`, { headers: { 'If-None-Match': `"${L.data.v}"` } });
    const sameText = await same.text();
    check(same.status === 304 && !same.headers.get('etag') && sameText === '', `the same v held: 304, nothing to read (${same.status})`);
    const other = await fetch(`${base}/local/chat/conversations`, { headers: { 'If-None-Match': '"0000000000000000"' } });
    const otherBody = other.status === 200 ? await other.json() : null;
    check(other.status === 200 && otherBody.v === L.data.v, `another v held: the whole list (${other.status})`);
    const M = await j('GET', `/local/chat/${giulia}/messages?limit=3`);
    check(M.data.messages.length === 3 && M.data.more === true && /^[0-9a-f]{16}$/.test(M.data.v) && M.data.messages[0].at <= M.data.messages[2].at, `messages: the newest 3, ascending, more (${M.data.messages.map((m) => m.preview).join(' | ')})`);
    const older = await j('GET', `/local/chat/${giulia}/messages?limit=50&before=${M.data.messages[0].id}`);
    check(older.data.messages.length === 4 && older.data.more === false && older.data.messages.every((m) => m.at <= M.data.messages[0].at), `before=: the older ones (${older.data.messages.length})`);
    const unknownBefore = await j('GET', `/local/chat/${giulia}/messages?limit=3&before=${'e'.repeat(32)}`);
    const badLimit = await j('GET', `/local/chat/${giulia}/messages?limit=0`);
    check(unknownBefore.data.messages.map((m) => m.id).join() === M.data.messages.map((m) => m.id).join() && badLimit.res.status === 400, 'a before it does not know: the newest; limit 0: 400');
    const id = crypto.randomBytes(16).toString('hex');
    const sent = await j('POST', `/local/chat/${giulia}/messages`, { id, text: '  ciao\r\na tutti  ' });
    check(sent.res.status === 201 && sent.data.message.id === id && sent.data.message.text === 'ciao\na tutti' && sent.data.message.mine && sent.data.message.state === 'sent', `POST: 201, the text cleaned (${JSON.stringify(sent.data.message.text)})`);
    const again = await j('POST', `/local/chat/${giulia}/messages`, { id, text: 'altro' });
    check(again.res.status === 200 && again.data.message.text === 'ciao\na tutti', 'the same id again: 200 with that message, nothing new');
    const tooLong = await j('POST', `/local/chat/${giulia}/messages`, { text: 'x'.repeat(2001) });
    const empty = await j('POST', `/local/chat/${giulia}/messages`, { text: '   ' });
    check(tooLong.res.status === 400 && empty.res.status === 400 && tooLong.data.code === 'bad_request', 'beyond 2000 characters or empty: 400 bad_request');
    const card = await j('POST', `/local/chat/${giulia}/messages`, { card: { kind: 'playlist', id: 'a1b2c3d4e5f60718', title: 'Prova', n: 3, sources: [S[0].id, 'zz'] }, text: 'una nota', replyTo: id });
    const cm = card.data.message;
    check(card.res.status === 201 && cm.t === 'card' && cm.reply.id === id && cm.reply.text === 'ciao\na tutti' && !('card' in cm.reply) && cm.preview === 'Playlist: Prova' && cm.card.sub === '' && cm.card.sources.join() === S[0].id && cm.card.cover === null && !('tracks' in cm.card), `a playlist card with a note and a reply: sub "", the sources that hold the chat, no track list (${cm.preview})`);
    const badCards = await Promise.all([
      { kind: 'track', id: '7f7b5b84', title: 'x' },
      { kind: 'album', id: '7f7b5b8431f309aac7052ce5', title: 'x' },
      { kind: 'playlist', id: 'a1b2c3d4e5f60718', title: 'x', n: -1 },
      { kind: 'track', id: '7f7b5b8431f309aac7052ce5', title: '' },
      { kind: 'video', id: '7f7b5b8431f309aac7052ce5', title: 'x' },
    ].map((c) => j('POST', `/local/chat/${giulia}/messages`, { card: c })));
    const extra = await j('POST', `/local/chat/${giulia}/messages`, { text: 'x', tracks: [] });
    check(badCards.every((r) => r.res.status === 400) && extra.res.status === 400, 'a card that is not one (a short track id, a 24 hex album, n below 0, no title, another kind), or another field: 400');
    const longNote = await j('POST', `/local/chat/${giulia}/messages`, { card: { kind: 'track', id: '7f7b5b8431f309aac7052ce5', title: 'x', sub: 'y' }, text: 'n'.repeat(301) });
    check(longNote.res.status === 400, 'a note beyond 300: 400');
    const marco = (await j('GET', '/local/people')).data.people.find((p) => p.name === 'Luca');
    const first = await j('POST', `/local/chat/${marco.chat}/messages`, { text: 'primo messaggio' });
    check(first.res.status === 201 && (await j('GET', '/local/chat/conversations')).data.conversations.some((c) => c.with === marco.id), 'a first message to someone listed, by their direct id: the conversation is listed from then on');
    const nowhere = await j('POST', `/local/chat/${'9'.repeat(32)}/messages`, { text: 'x' });
    check(nowhere.res.status === 404 && nowhere.data.code === 'not_found', 'no such conversation: 404 not_found');
    await fetch(`${base}/__mock/chat?failNext=1`);
    const failed = await j('POST', `/local/chat/${giulia}/messages`, { text: 'non arriva' });
    check(failed.res.status === 201 && failed.data.message.state === 'failed', 'every source refused: failed');
    await fetch(`${base}/__mock/chat?postMs=4600`);
    const t0 = Date.now();
    const slow = await j('POST', `/local/chat/${giulia}/messages`, { text: 'lento' });
    const took = Date.now() - t0;
    check(slow.data.message.state === 'pending' && took >= 3900 && took < 4500, `a slow source: pending within 4 s (${took} ms)`);
    await new Promise((r) => setTimeout(r, 800));
    const back = (await j('GET', `/local/chat/${giulia}/messages?limit=5`)).data.messages.find((m) => m.id === slow.data.message.id);
    check(back && back.state === 'sent', 'and sent once it is through');
    await fetch(`${base}/__mock/chat?postMs=0`);
    const theirs = M.data.messages.find((m) => !m.mine);
    const notMine = await j('DELETE', `/local/chat/${giulia}/messages/${theirs.id}`);
    const del = await j('DELETE', `/local/chat/${giulia}/messages/${id}`);
    const after = (await j('GET', `/local/chat/${giulia}/messages?limit=50`)).data.messages;
    check(notMine.res.status === 403 && notMine.data.code === 'refused' && del.data.ok === true && !after.some((m) => m.id === id), 'delete: your own goes for everyone, someone else\'s 403 refused');
    await fetch(`${base}/__mock/chat?unread=${group}`);
    const gl = (await j('GET', '/local/chat/conversations')).data.conversations.find((c) => c.id === group);
    const newest = (await j('GET', `/local/chat/${group}/messages?limit=1`)).data.messages[0];
    await j('PUT', `/local/chat/${group}/read`, { id: newest.id });
    const gr = (await j('GET', '/local/chat/conversations')).data.conversations.find((c) => c.id === group);
    check(gl.unread > 0 && gr.unread === 0, `read: the mark moves, unread to 0 (${gl.unread} -> ${gr.unread})`);
    const m8 = await j('PUT', `/local/chat/${group}/mute`, { mute: '8h' });
    const until = m8.data.mutes[group];
    check(until > Date.now() + 7.9 * 3600000 && until < Date.now() + 8.1 * 3600000, '8h: silenced for 8 hours');
    const m1w = await j('PUT', `/local/chat/${group}/mute`, { mute: '1w' });
    const mAlways = await j('PUT', `/local/chat/${group}/mute`, { mute: 'always' });
    const mOff = await j('PUT', `/local/chat/${group}/mute`, { mute: 'off' });
    const mBad = await j('PUT', `/local/chat/${group}/mute`, { mute: 'forever' });
    check(m1w.data.mutes[group] > Date.now() + 6.9 * 86400000 && mAlways.data.mutes[group] === 0 && !(group in mOff.data.mutes) && mBad.res.status === 400, '1w, always (0), off (removed), anything else 400');
    const sh = await j('GET', '/local/chat/shared');
    const cards = sh.data.cards;
    check(cards.length >= 3 && cards.length <= 12 && cards.every((c) => c.from !== st.profile.id) && new Set(cards.map((c) => `${c.card.kind}:${c.card.id}`)).size === cards.length && cards.some((c) => c.muted), `shared: others' cards, newest first, one per item, a silenced one says so (${cards.map((c) => c.card.title).join(', ')})`);
    const sara = cards.find((c) => c.card.kind === 'playlist');
    const pl = await j('GET', `/local/chat/${sara.cid}/messages/${sara.messageId}/playlist`);
    const P = pl.data.playlist;
    check(pl.res.status === 200 && P.name === 'Studio notturno' && P.n === P.trackIds.length && P.live === true && 'cover' in P && Number.isInteger(P.updatedAt) && !('tracks' in sara.card), `a shared playlist is read whole from its source (${P.n} tracks, live); the card holds none`);
    await fetch(`${base}/__mock/chat?playlistDown=1`);
    const down = await j('GET', `/local/chat/${sara.cid}/messages/${sara.messageId}/playlist`);
    const mine = (await j('GET', `/local/chat/${giulia}/messages?limit=50`)).data.messages.find((m) => m.card && m.card.kind === 'playlist' && m.mine);
    const never = await j('GET', `/local/chat/${giulia}/messages/${mine.id}/playlist`);
    check(down.res.status === 200 && down.data.playlist.live === false && down.data.playlist.trackIds.join() === P.trackIds.join() && never.res.status === 404, 'no source of it answers: the copy read last (live false); one never read: 404');
    await fetch(`${base}/__mock/chat?playlistDown=0`);
    const gone = await j('GET', `/local/chat/${giulia}/messages/${card.data.message.id}/playlist`);
    check(gone.res.status === 404 && gone.data.code === 'not_found', 'a playlist no longer there: 404 not_found');
    const readUnknown = await j('PUT', `/local/chat/${group}/read`, { id: 'e'.repeat(32) });
    check(readUnknown.res.status === 404 && readUnknown.data.code === 'not_found', 'a read mark on a message not known: 404 not_found');
    const b1 = await j('POST', '/local/social/blocked', { profileId: SIS });
    const list2 = (await j('GET', '/local/chat/conversations')).data.conversations;
    const people2 = (await j('GET', '/local/people')).data.people;
    check(b1.data.blocked.includes(SIS) && !list2.some((c) => c.with === SIS) && people2.find((p) => p.id === SIS).blocked === true && (await j('GET', '/local/social')).data.blocked.includes(SIS), 'blocked: listed in /local/social, their chat gone, blocked in the people');
    const b2 = await j('DELETE', `/local/social/blocked/${SIS}`);
    check(!b2.data.blocked.includes(SIS) && (await j('GET', '/local/chat/conversations')).data.conversations.some((c) => c.with === SIS), 'unblocked: the chat is back');
    await fetch(`${base}/__mock/chat?level=1`);
    const lv1 = await j('GET', '/local/chat/conversations');
    check((await j('GET', '/local/sources')).data.sources.every((s) => s.social === 1) && lv1.data.supported === false && lv1.data.conversations.length === 0, 'level=1: the sources speak the people part only, no chats');
    await fetch(`${base}/__mock/reset`);
  }

  // ---- the songs part (social 3): comments and lyrics on each source ----
  {
    await fetch(`${base}/__mock/reset`);
    const st = await (await fetch(`${base}/__mock/state`)).json();
    const mi = st.servers.find((s) => s.name === 'Mi A2');
    const vps = st.servers.find((s) => s.name === 'VPS prova');
    const byTitle = (srv, title) => srv.trackList.filter((t) => t.title === title);
    const luce = byTitle(mi, 'Luce di posizione')[0].id;
    const luceCopy = byTitle(vps, 'Luce di posizione')[0].id;
    const freq = byTitle(mi, 'Frequenze')[0].id;
    const ancora = byTitle(vps, 'Àncora')[0].id;
    const ME = st.profile.id;
    const api = (srv, p) => `/s/${srv.id}/api${p}`;
    // the library carries the flag, only from a source at 3
    const lib = (await j('GET', api(mi, '/library'))).data;
    const tl = (id) => lib.tracks.find((t) => t.id === id);
    const instrumental = lib.tracks.find((t) => t.title === 'Cassiopea');
    check(tl(luce).lyrics === 'synced' && lib.tracks.find((t) => t.title === 'Città di sale').lyrics === 'plain' && !('lyrics' in instrumental) && !('lyrics' in tl(freq)), 'the library: lyrics synced or plain on a track that has them, none for an instrumental or a track without');
    // comments: GET with an ETag and 304
    const g1 = await j('GET', api(mi, `/comments?tracks=${luce}`));
    const tag = g1.res.headers.get('etag');
    check(g1.res.status === 200 && g1.data.comments.length === 4 && /^"k[0-9a-f]{16}"$/.test(tag || '') && g1.data.comments.every((c, i, a) => !i || a[i - 1].at >= c.at) && g1.data.comments.every((c) => /^[0-9a-f]{32}$/.test(c.id) && c.trackId === luce && c.name), `GET /api/comments: the track's comments newest first with id, trackId, from, name, at, text, and an ETag (${tag})`);
    const g2 = await fetch(base + api(mi, `/comments?tracks=${luce}`), { headers: { 'If-None-Match': tag } });
    check(g2.status === 304, 'the same ETag again: 304');
    const both = await j('GET', api(vps, `/comments?tracks=${luceCopy},${'f'.repeat(24)}`));
    check(both.res.status === 200 && both.data.comments.length === 2, 'ids not held there are left out');
    check((await j('GET', api(mi, '/comments?tracks='))).res.status === 400 && (await j('GET', api(mi, `/comments?tracks=${Array(21).fill(luce).join(',')}`))).res.status === 400, '0 or 21 trackIds: 400');
    // POST: new 201, the same again 200 as it is, an edit (same id, newer at) replaces, the rules
    const id = crypto.randomBytes(16).toString('hex');
    const at = Date.now();
    const p1 = await j('POST', api(mi, '/comments'), { id, trackId: luce, at, text: '  bella\ndavvero  ' });
    check(p1.res.status === 201 && p1.data.comment.id === id && p1.data.comment.text === 'bella davvero' && p1.data.comment.from === ME, `POST: 201 with the comment, newlines and spaces as one space (${p1.res.status} ${JSON.stringify(p1.data?.comment?.text)})`);
    const p2 = await j('POST', api(mi, '/comments'), { id, trackId: luce, at, text: 'bella davvero' });
    check(p2.res.status === 200 && p2.data.comment.id === id, 'the same id again: 200 with it');
    const p3 = await j('POST', api(mi, '/comments'), { id: crypto.randomBytes(16).toString('hex'), trackId: luce, at: at + 5, text: 'ripensandoci, stupenda' });
    const now5 = (await j('GET', api(mi, `/comments?tracks=${luce}`))).data.comments.filter((c) => c.from === ME);
    check(p3.res.status === 200 && p3.data.comment.id === id && now5.length === 1 && now5[0].text === 'ripensandoci, stupenda', 'one per author: a newer one replaces it and keeps its first id');
    const marcoId = g1.data.comments.find((c) => c.name === 'Marco').id;
    check((await j('POST', api(mi, '/comments'), { id: marcoId, trackId: luce, at: at + 9, text: 'mio' })).data.code === 'bad_comment', "an id of another author: 400 bad_comment");
    check((await j('POST', api(mi, '/comments'), { id, trackId: freq, at: at + 9, text: 'altrove' })).data.code === 'bad_comment', 'your own id on another track: 400 bad_comment, as the source answers');
    check((await j('POST', api(mi, '/comments'), { id: crypto.randomBytes(16).toString('hex'), trackId: freq, at, text: 'x'.repeat(301) })).data.code === 'bad_comment', '301 code points: 400 bad_comment');
    check((await j('POST', api(mi, '/comments'), { id: crypto.randomBytes(16).toString('hex'), trackId: freq, at: Date.now() + 600000, text: 'presto' })).data.code === 'bad_time', 'a time 10 minutes ahead: 400 bad_time');
    check((await j('POST', api(mi, '/comments'), { id: crypto.randomBytes(16).toString('hex'), trackId: 'e'.repeat(24), at, text: 'dove?' })).data.code === 'version_gone', 'a track not here: 404 version_gone');
    // DELETE: the owner deletes anyone's on its source, a member only their own
    const vpsLuca = both.data.comments.find((c) => c.name === 'Luca');
    const d1 = await j('DELETE', api(vps, `/comments/${vpsLuca.id}`));
    check(d1.res.status === 403 && d1.data.code === 'forbidden', "a member deleting someone else's comment: 403 forbidden");
    const d2 = await j('DELETE', api(mi, `/comments/${marcoId}`));
    const d3 = await j('DELETE', api(mi, `/comments/${marcoId}`));
    check(d2.data.ok === true && d3.res.status === 404 && d3.data.code === 'comment_gone', "the owner deletes someone else's on its source; again: 404 comment_gone");
    // hidden: a blocked author, an invisible author (shown to itself)
    const SIS = st.social.people.find((p) => p.name === 'Giulia' && p.photo).id;
    await j('POST', '/local/social/blocked', { profileId: SIS });
    const blk = (await j('GET', api(mi, `/comments?tracks=${luce}`))).data.comments;
    await j('DELETE', `/local/social/blocked/${SIS}`);
    check(!blk.some((c) => c.from === SIS) && (await j('GET', api(mi, `/comments?tracks=${luce}`))).data.comments.some((c) => c.from === SIS), 'a blocked author is hidden from the one who blocked, and back once unblocked');
    await fetch(`${base}/__mock/songs?invisible=${ME}`);
    const self = (await j('GET', api(mi, `/comments?tracks=${luce}`))).data.comments;
    await fetch(`${base}/__mock/songs?invisible=${SIS}`);
    const other = (await j('GET', api(mi, `/comments?tracks=${luce}`))).data.comments;
    await fetch(`${base}/__mock/songs?invisible=`);
    check(self.some((c) => c.from === ME) && !other.some((c) => c.from === SIS), 'an invisible author: shown to itself, hidden from the others');
    // the 21st write in a minute: 429 slow_down with retryAt
    let last = null;
    for (let i = 0; i < 25 && !(last && last.res.status === 429); i++) last = await j('POST', api(vps, '/comments'), { id: crypto.randomBytes(16).toString('hex'), trackId: luceCopy, at: Date.now() + i, text: `prova ${i}` });
    check(last.res.status === 429 && last.data.code === 'slow_down' && last.data.retryAt > Date.now(), `beyond 20 comment writes a minute: 429 slow_down with retryAt (${last.res.status})`);
    // lyrics: GET with an ETag and 304, none 404
    const l1 = await j('GET', api(mi, `/lyrics/${luce}`));
    const ltag = l1.res.headers.get('etag');
    check(l1.res.status === 200 && l1.data.kind === 'synced' && l1.data.lines.length === 13 && l1.data.lines.every((x, i, a) => !i || a[i - 1].t <= x.t) && /^"y[0-9a-f]{16}"$/.test(ltag || ''), `GET /api/lyrics: synced lines sorted, with an ETag (${ltag})`);
    check((await fetch(base + api(mi, `/lyrics/${luce}`), { headers: { 'If-None-Match': ltag } })).status === 304, 'the same ETag again: 304');
    const none = await j('GET', api(mi, `/lyrics/${instrumental.id}`));
    check(none.res.status === 404 && none.data.code === 'no_lyrics' && (await j('GET', api(mi, `/lyrics/${freq}`))).data.code === 'no_lyrics', 'an instrumental, or a track without: 404 no_lyrics');
    // PUT an .lrc: every time tag form, several on a line, [offset:], word times out, metadata out
    const v0 = (await j('GET', api(mi, '/library'))).data.version;
    const lrc = '[ar:Lumen Marino]\n[offset:+500]\n[00:10.00]Prima riga inventata\n[00:20.5][00:40.25]<00:20.60>doppia <00:21.00>riga\n[01:02.123]ultima riga\n[00:30]\nsenza tempo\n';
    const put = await fetch(base + api(mi, `/lyrics/${freq}`), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: lrc });
    const pj = await put.json();
    const v1 = (await j('GET', api(mi, '/library'))).data;
    check(put.status === 200 && pj.kind === 'synced' && pj.lines.map((x) => `${x.t}:${x.text}`).join('|') === '9500:Prima riga inventata|20000:doppia riga|29500:|39750:doppia riga|61623:ultima riga' && v1.version > v0 && v1.tracks.find((t) => t.id === freq).lyrics === 'synced', `PUT an .lrc: synced, sorted, offset applied, word times and metadata out, the empty line kept; the flag and a new library version (${JSON.stringify(pj.lines)})`);
    const beside = await fetch(base + api(mi, `/lyrics/${freq}?beside=1`), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'una riga ferma' });
    check(beside.status === 200 && (await beside.json()).kind === 'synced', 'beside=1 never replaces synced lyrics');
    const plainPut = await fetch(base + api(mi, `/lyrics/${freq}`), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'una riga ferma\nun\'altra' });
    check((await plainPut.json()).kind === 'plain', 'a text with no time tag: plain, and a manual PUT replaces');
    const big = await fetch(base + api(mi, `/lyrics/${freq}`), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'x'.repeat(70000) });
    check(big.status === 400 && (await big.json()).code === 'bad_lyrics', 'over 64 KB: 400 bad_lyrics');
    const foreign = await fetch(base + api(vps, `/lyrics/${ancora}`), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '[00:01]riga' });
    check(foreign.status === 403 && (await foreign.json()).code === 'forbidden', "a member on a track that is not theirs: 403 forbidden");
    const del = await j('DELETE', api(mi, `/lyrics/${freq}`));
    const v2 = (await j('GET', api(mi, '/library'))).data;
    check(del.data.ok === true && !('lyrics' in v2.tracks.find((t) => t.id === freq)) && (await j('GET', api(mi, `/lyrics/${freq}`))).res.status === 404, '"Togli testo": DELETE, the flag gone, GET 404');
    // a source below 3: no flag, no routes
    await fetch(`${base}/__mock/source?source=${mi.id}&social=2`);
    const low = (await j('GET', api(mi, '/library'))).data;
    check(!low.tracks.some((t) => 'lyrics' in t) && (await j('GET', api(mi, `/comments?tracks=${luce}`))).res.status === 404 && (await j('GET', api(mi, `/lyrics/${luce}`))).res.status === 404 && (await j('GET', '/local/sources')).data.sources.find((s) => s.id === mi.id).social === 2, 'a source at 2: no lyrics in the library, the songs routes absent, social 2');
    await fetch(`${base}/__mock/reset`);
  }

  // ---- first run (welcome screen) ----
  await fetch(`${base}/__mock/reset?sources=0`);
  S = (await j('GET', '/local/sources')).data.sources;
  check(S.length === 0, 'reset?sources=0: no source (the UI shows the welcome screen)');
  const first = await j('POST', '/local/sources', { code: code1.toLowerCase() });
  check(first.res.status === 201 && first.data.source.principal, `the first source added is principal: ${first.data.source.name}`);
  await fetch(`${base}/__mock/reset`);
} catch (err) {
  log('ERROR', err.stack || err);
  fails++;
} finally {
  child.kill();
}
log(`fails=${fails}`);
fs.writeFileSync(logFile, out.join('\n') + '\n');
console.log(`fails=${fails} (see ${logFile})`);
process.exit(fails ? 1 : 0);
