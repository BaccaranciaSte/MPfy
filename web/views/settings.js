// Impostazioni, a plain list:
//   /impostazioni                 the person (name, "Modifica", "Collega un altro dispositivo"),
//                                 Fonti musicali, Social (while a source speaks the people part),
//                                 Qualità audio, Memoria, Informazioni
//   /impostazioni/qualita         the three quality choices (Wi-Fi, mobile data, download)
//   /impostazioni/fonte/<id>      one source: its name and "Cerca i dettagli in rete" (owner),
//                                 principal, code, devices, remove
//   /impostazioni/bloccate        the people you blocked, each with "Sblocca"
// The person's own pages are in profile.js.
//
// The pages re-render only when something they show changes (the source list is polled every
// few seconds and its RTT moves all the time), so a tap never lands on a row being replaced.
// The state of a source shows only here, as a dot before its name: blue connected, grey not.
// What a member may not do is not shown (renaming the source, changing its code, other people's
// devices); a source without profiles shows everything, as before. Words: short, calm, never a
// code or a server's own text.

import { h, iconBtn, put, oneAtATime, sep } from '../js/dom.js';
import { icon, logoEl } from '../icons/icons.js';
import { sources, PHONE_ID } from '../js/sources.js';
import { srcApi, errorText } from '../js/api.js';
import { native, nativeCall, bridgeVersion } from '../js/native.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { downloads } from '../js/downloads.js';
import { quality, CHOICES, KINDS } from '../js/quality.js';
import { goBack, navigate } from '../js/router.js';
import { BRAND, APP_VERSION, fmtInt, fmtSize, nBrani } from '../js/util.js';
import { openDialog, openPanel, openSheet, actionDialog, confirmDialog, progressDialog } from '../components/sheet.js';
import { toast } from '../components/toast.js';
import { openAddSource, formatCode, codeBody, renameSource } from '../components/add-source.js';
import { profile } from '../js/profile.js';
import { memory } from '../js/memory.js';
import { renameSelf } from './profile.js';
import { askNameDialog, askNameIfMissing } from './welcome.js';
import { avatar, personAvatar } from '../components/avatar.js';
import { fmtSpace } from '../js/util.js';
import { storageState } from '../js/storage-row.js';
import { social, photoUrlOf } from '../js/social.js';
import { profileIdText } from '../js/profile-id.js';
import { qrSvg } from '../js/qr.js';
import { sourceLink } from '../js/links.js';

// ---------------------------------------------------------------------------------------------
// building blocks

function topBar(title) {
  const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
  return h('header', { class: 'set-top' }, back, h('h1', { class: 'set-top-title' }, title), h('span', { class: 'icon-spacer' }));
}

/** The state dot: blue when connected, grey when not, with a spoken label. */
const stateDot = (up) => h('span', { class: `src-dot${up ? ' up' : ''}`, role: 'img', 'aria-label': up ? 'connessa' : 'non raggiungibile' });

const AUTHOR_URL = 'https://baccarancia.com';
/**
 * "By Baccarancia": a link to the author's site, opened in the system browser (the app's
 * openExternal; a new tab in a plain browser). Nothing is ever fetched from it.
 */
function authorLink(cls) {
  const a = h('a', { class: cls, href: AUTHOR_URL, target: '_blank', rel: 'noopener noreferrer' }, 'By Baccarancia');
  a.addEventListener('click', (e) => {
    if (!native || typeof native.openExternal !== 'function') return;
    e.preventDefault();
    nativeCall('openExternal', AUTHOR_URL);
  });
  return a;
}

/** "Cerca i dettagli in rete" of the phone's own music: Locale's library says it, else the core's entry. */
const phoneDetails = () => {
  const v = store.libOf(PHONE_ID)?.source?.details;
  return typeof v === 'boolean' ? v : sources.phone?.details !== false;
};

const section = (title, ...rows) => h('section', { class: 'set-section' }, h('h2', { class: 'set-section-title' }, title), h('div', { class: 'set-list' }, rows));

/** One list row: a link (href), a button (onClick) or plain text. */
function row({ ic, title, sub, badge, dot = null, href, onClick, danger = false, chevron = !!(href || onClick), cls = '' }) {
  const kids = [
    h('span', { class: 'set-icon' }, typeof ic === 'string' ? icon(ic, 24) : ic),
    h(
      'span',
      { class: 'set-text' },
      h('span', { class: 'set-title' }, dot != null ? stateDot(dot) : null, h('span', { class: 'set-title-text' }, title), badge ? h('span', { class: 'badge' }, badge) : null),
      sub ? h('span', { class: 'set-sub' }, sub) : null
    ),
    chevron ? h('span', { class: 'set-chev' }, icon('chevronRight', 20)) : null,
  ];
  const c = `set-row${danger ? ' danger' : ''}${cls ? ' ' + cls : ''}`;
  if (href) return h('a', { class: c, href, 'data-link': '' }, kids);
  if (onClick) {
    const b = h('button', { type: 'button', class: c }, kids);
    b.addEventListener('click', onClick);
    return b;
  }
  return h('div', { class: `${c} static` }, kids);
}

/**
 * A switch row: the whole row is the switch (role switch, aria-checked), drawn as a track and a
 * thumb in CSS, with an optional line under the title. onToggle(next) runs on a tap, except on a
 * row held by another switch (is-held, aria-disabled): it keeps its state and ignores taps. Its
 * state is changed in place (aria-checked), so the thumb slides: a new row would show the new
 * state at once.
 */
function switchRow({ ic, title, sub = null, on, onToggle, cls = '' }) {
  const b = h(
    'button',
    { type: 'button', class: `set-row switch-row${cls ? ' ' + cls : ''}`, role: 'switch', 'aria-checked': String(!!on) },
    h('span', { class: 'set-icon' }, icon(ic, 24)),
    h('span', { class: 'set-text' }, h('span', { class: 'set-title' }, h('span', { class: 'set-title-text' }, title)), sub ? h('span', { class: 'set-sub' }, sub) : null),
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' }))
  );
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    onToggle(b.getAttribute('aria-checked') !== 'true');
  });
  return b;
}

/** Turning "Invisibile" on asks once; off asks nothing. One question at a time. */
const askInvisible = oneAtATime(async () => {
  const ok = await confirmDialog({
    title: 'Diventare invisibile?',
    message: 'Nessuno ti vedrà tra gli amici, su nessuna fonte. Chi gestisce una fonte vede comunque che la usi.',
    okLabel: 'Diventa invisibile',
  });
  if (ok) social.setPrivacy('invisible', true);
});

/** "Notifiche dei messaggi": the app keeps it (bridge 6), on unless turned off. */
const chatNotify = () => nativeCall('getChatNotify') !== '0';

/**
 * Social: "Invisibile", then "Mostra cosa ascolto", "Sessione privata" and "Mostra i miei ascolti
 * recenti", which "Invisibile" holds (greyed, their own state kept for when it is off again).
 * Every change goes to the core at once and comes back if the core refuses it (social.js). The
 * rows are drawn once and painted in place: paint() follows the store. Where the sources hold
 * chats: "Notifiche dei messaggi" (the Android app only, which keeps it) and "Persone bloccate".
 */
function socialSection() {
  const rows = {
    invisible: switchRow({ ic: 'invisible', title: 'Invisibile', sub: 'Sparisci dalle liste degli amici', on: false, cls: 'social-invisible', onToggle: (v) => (v ? askInvisible() : social.setPrivacy('invisible', false)) }),
    showNow: switchRow({ ic: 'eq', title: 'Mostra cosa ascolto', on: true, cls: 'social-now', onToggle: (v) => social.setPrivacy('showNow', v) }),
    privateSession: switchRow({ ic: 'lock', title: 'Sessione privata', sub: 'Nasconde la tua attività per 6 ore', on: false, cls: 'social-private', onToggle: (v) => social.setPrivacy('privateSession', v) }),
    showRecent: switchRow({ ic: 'history', title: 'Mostra i miei ascolti recenti', on: true, cls: 'social-recent', onToggle: (v) => social.setPrivacy('showRecent', v) }),
  };
  let ends = 0;
  const paint = () => {
    const p = social.privacy;
    for (const k of Object.keys(rows)) rows[k].setAttribute('aria-checked', String(!!p[k]));
    for (const k of ['showNow', 'privateSession', 'showRecent']) {
      rows[k].classList.toggle('is-held', p.invisible);
      if (p.invisible) rows[k].setAttribute('aria-disabled', 'true');
      else rows[k].removeAttribute('aria-disabled');
    }
    // The private session ends by itself: the row turns off then.
    clearTimeout(ends);
    ends = p.privateSession && p.privateUntil > Date.now() ? setTimeout(paint, Math.min(p.privateUntil - Date.now() + 50, 2147483000)) : 0;
  };
  const chats = social.chatsSupported;
  let notify = null;
  if (chats && bridgeVersion() >= 6) {
    notify = switchRow({
      ic: 'bell',
      title: 'Notifiche dei messaggi',
      on: chatNotify(),
      cls: 'social-notify',
      onToggle: (v) => {
        nativeCall('setChatNotify', v ? '1' : '0');
        notify.setAttribute('aria-checked', String(chatNotify()));
      },
    });
  }
  const blocked = chats ? row({ ic: 'block', title: 'Persone bloccate', href: '/impostazioni/bloccate', cls: 'social-blocked' }) : null;
  const el = h('section', { class: 'set-section social-section' }, h('h2', { class: 'set-section-title' }, 'Social'), h('div', { class: 'set-list' }, rows.invisible, rows.showNow, rows.privateSession, rows.showRecent, notify, blocked));
  paint();
  return { el, paint, stop: () => clearTimeout(ends) };
}

/** "1.234 brani, 12,3 GB liberi" from the last health answer (or the cached library). */
function sourceLine(s) {
  const hl = sources.healthOf(s.id);
  const parts = [];
  const n = hl && Number.isFinite(hl.tracks) ? hl.tracks : store.libOf(s.id)?.tracks.length;
  if (Number.isFinite(n)) parts.push(nBrani(n).replace(/^\d+/, fmtInt(n)));
  if (hl && Number.isFinite(hl.diskFreeBytes)) parts.push(`${fmtSize(hl.diskFreeBytes)} liberi`);
  return parts.join(', ') || null;
}

/** Re-renders el's content only when sig() changes. */
function keyedRender(build, sig) {
  let last = null;
  return (force = false) => {
    const k = sig();
    if (!force && k === last) return;
    last = k;
    build();
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'visually-hidden', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------------------------
// flows

/** "Mostra codice": its QR code, then the permanent code in big type, in groups of 4, with a copy button. */
function showCode(s, code) {
  const body = codeBody(code);
  const full = formatCode(body);
  const grid = h('div', { class: 'code-big', 'aria-label': full.split('').join(' ') }, h('span', { class: 'code-big-prefix' }, 'MPFY'), (body.match(/.{1,4}/g) || []).map((g) => h('span', { class: 'code-big-group' }, g)));
  const copy = h('button', { type: 'button', class: 'btn btn-light btn-small code-copy' }, icon('copy', 18), 'Copia');
  copy.addEventListener('click', async () => toast((await copyText(full)) ? 'Codice copiato' : 'Copia non riuscita'));
  return openDialog({
    title: `Codice di ${s.name}`,
    body: h('div', { class: 'code-dialog' }, h('p', { class: 'dialog-text' }, 'Per aggiungere questa fonte.'), h('div', { class: 'qr-box' }, qrSvg(sourceLink(full), `Codice QR di ${s.name}`)), grid, h('div', { class: 'code-copy-row' }, copy)),
    actions: [{ label: 'Chiudi', value: null, cls: 'btn-ghost' }],
  });
}

// The flows that ask a source something run one at a time for each source: a second tap while
// the source is still answering (a slow P2P link) does not send the request again or stack a
// second dialog, and a slow source does not hold back the same flow on another one.
const bySource = (s) => s.id;

const showCodeFlow = oneAtATime(async (s) => {
  try {
    const { code } = await srcApi(s.id).adminCode();
    await showCode(s, code);
  } catch (err) {
    toast(errorText(err, 'Codice non disponibile'));
  }
}, bySource);

const rotateCodeFlow = oneAtATime(async (s) => {
  const ok = await confirmDialog({
    title: 'Cambiare il codice?',
    message: 'Quello attuale smette di funzionare.',
    okLabel: 'Cambia codice',
    danger: true,
  });
  if (!ok) return;
  try {
    const { code } = await srcApi(s.id).rotateCode();
    toast('Codice cambiato');
    await showCode(s, code);
  } catch (err) {
    toast(errorText(err, 'Codice non cambiato'));
  }
}, bySource);

function fmtDate(ms) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
  } catch {
    return '';
  }
}

/**
 * "Dispositivi collegati": the clients admitted by a source. The owner sees everyone's, one
 * heading per person (yours "(tu)") and "Senza profilo" for devices not bound to one; a member
 * sees only its own, without headings. "Rimuovi" on what may be removed, never on this device.
 */
function devicesPanel(s) {
  const { body } = openPanel({ title: 'Dispositivi collegati', cls: 'panel-devices' });
  const list = h('div', { class: 'set-list devices-list' });
  body.append(list);
  const load = async () => {
    list.replaceChildren(h('p', { class: 'empty-small' }, 'Caricamento...'));
    let clients;
    try {
      ({ clients } = await srcApi(s.id).clients());
    } catch (err) {
      list.replaceChildren(h('p', { class: 'empty-small' }, errorText(err)));
      return;
    }
    list.replaceChildren();
    const sorted = [...(clients || [])].sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0) || (a.addedAt || 0) - (b.addedAt || 0));
    const role = store.roleOf(s.id);
    const me = store.libOf(s.id)?.you?.profileId || profile.data?.id || null;
    const mineOnly = role === 'member';
    const headed = role === 'owner';
    const order = [];
    const byPerson = new Map();
    for (const c of sorted) {
      const k = c.profileId || '';
      if (!byPerson.has(k)) {
        byPerson.set(k, []);
        order.push(k);
      }
      byPerson.get(k).push(c);
    }
    // You first, people by name, devices without a profile last.
    const label = (k) => {
      if (!k) return 'Senza profilo';
      const name = byPerson.get(k).find((c) => c.profileName)?.profileName || 'Senza nome';
      return k === me ? `${name} (tu)` : name;
    };
    const rank = (k) => (k === me ? 0 : !k ? 2 : 1);
    order.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b), 'it'));
    const shown = headed ? order.flatMap((k) => [k, ...byPerson.get(k)]) : sorted;
    for (const c of shown) {
      if (typeof c === 'string') {
        list.append(h('h3', { class: 'devices-head' }, label(c)));
        continue;
      }
      const sub = [c.addedAt ? `Collegato il ${fmtDate(c.addedAt)}` : '', c.connected ? 'connesso ora' : ''].filter(Boolean).join(', ');
      const r = row({ ic: 'phone', title: c.you ? 'Questo dispositivo' : c.name || 'Dispositivo', sub: c.you ? [c.name, sub].filter(Boolean).join(', ') : sub, chevron: false, cls: 'device-row' });
      const removable = !c.you && (!mineOnly || !c.profileId || c.profileId === me);
      if (removable) {
        const rm = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Rimuovi');
        rm.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: `Rimuovere ${c.name || 'il dispositivo'}?`, message: 'Per tornare servirà il codice.', okLabel: 'Rimuovi', danger: true });
          if (!ok) return;
          try {
            await srcApi(s.id).removeClient(c.publicKey);
            toast('Dispositivo rimosso');
          } catch (err) {
            toast(errorText(err, 'Dispositivo non rimosso'));
          }
          load();
        });
        r.append(rm);
      }
      list.append(r);
    }
    if (!sorted.length) list.append(h('p', { class: 'empty-small' }, 'Nessun dispositivo.'));
  };
  load();
}

/** "Rinomina fonte" (its owner): the name everyone paired with it sees. */
async function renameFlow(s) {
  const input = h('input', { class: 'text-input text-input-big', type: 'text', 'aria-label': 'Nome della fonte', autocomplete: 'off', enterkeyhint: 'done' });
  input.value = s.name;
  let changed = false;
  const ok = await actionDialog({
    title: 'Rinomina fonte',
    body: input,
    okLabel: 'Salva',
    onSubmit: async () => {
      if (input.value.trim() === s.name) return null;
      changed = true;
      return renameSource(s.id, input.value);
    },
  });
  if (ok && changed) toast('Fonte rinominata');
}

/**
 * "Imposta come principale": playlists, likes and playlist covers are copied to the new
 * principal (with a progress dialog), then the principal changes. Downloaded playlists and the
 * player's "playing from" follow the new playlist ids.
 *
 * The old principal may be out of reach (that is when a switch is most wanted): its last known
 * library is copied, and a custom cover that cannot be fetched is skipped, not a reason to stop.
 * When nothing at all is known of it, the dialog says its data cannot be copied, and the switch
 * happens without the copy if confirmed (the data stays on the old principal).
 */
export async function switchPrincipal(toId) {
  const to = sources.get(toId);
  const from = sources.principal();
  if (!to || to.principal) return;
  if (!sources.isUp(toId)) {
    toast('Fonte non raggiungibile');
    return;
  }
  const copy = !!from && (sources.isUp(from.id) || !!store.libOf(from.id));
  const ok = await confirmDialog({
    title: `Usare ${to.name} come principale?`,
    message: !from ? null : copy ? 'Playlist, Mi piace e copertine vengono copiati.' : `Playlist e Mi piace di ${from.name} non vengono copiati.`,
    okLabel: !from ? 'Usa come principale' : copy ? 'Copia e usa' : 'Usa comunque',
    danger: !!from && !copy,
  });
  if (!ok) return;
  const dlg = progressDialog({ title: copy ? `Copia su ${to.name}` : to.name });
  downloads.suspend(true);
  try {
    let idMap = {};
    let skipped = 0;
    if (copy) ({ idMap, skippedCovers: skipped } = await store.copyUserData(from.id, toId, (done, total, label) => dlg.set(done, total, label)));
    await store.refresh(); // the new playlists, before the switch shows them
    downloads.remapPlaylists(idMap);
    player.remapPlaylists(idMap);
    await sources.setPrincipal(toId);
    await store.refresh();
    dlg.finish(skipped ? `Fatto, ${skipped === 1 ? '1 copertina non copiata' : `${skipped} copertine non copiate`}` : 'Fatto');
  } catch (err) {
    dlg.fail(errorText(err, 'Copia non riuscita'));
  } finally {
    downloads.suspend(false);
  }
}

const removeFlow = oneAtATime(async (s) => {
  const others = sources.list.filter((x) => x.id !== s.id);
  // One short sentence; the principal's playlists are the one thing worth saying.
  const message = s.principal && others.length ? `Le tue playlist restano su ${s.name}.` : downloads.available ? 'I brani scaricati restano sul telefono.' : `I brani restano su ${s.name}.`;
  const ok = await confirmDialog({ title: `Rimuovere ${s.name}?`, message, okLabel: 'Rimuovi', danger: true });
  if (!ok) return;
  try {
    await sources.remove(s.id);
    toast(`${s.name} rimossa`);
    store.refresh();
    navigate('/impostazioni', { replace: true });
  } catch (err) {
    toast(errorText(err, 'Fonte non rimossa'));
  }
}, bySource);

// ---------------------------------------------------------------------------------------------
// pages

/** The top: the person's name (to the Profilo page) with "Modifica", and "Collega un altro dispositivo". */
function personBlock() {
  if (!profile.data) return null;
  const edit = h('button', { type: 'button', class: 'btn btn-light btn-small person-edit' }, 'Modifica');
  // "Modifica" opens the person's page (name and photo), like a tap on the card.
  edit.addEventListener('click', () => navigate('/impostazioni/profilo'));
  const name = h(
    'a',
    { class: 'person-main', href: '/impostazioni/profilo', 'data-link': '' },
    avatar(56, { cls: 'person-avatar' }),
    h('span', { class: 'set-text' }, h('span', { class: 'person-name' }, profile.name || 'Senza nome'), h('span', { class: 'set-sub' }, 'Profilo'))
  );
  return h(
    'section',
    { class: 'set-section person' },
    h('div', { class: 'person-card' }, name, edit),
    h('div', { class: 'set-list' }, row({ ic: 'devices', title: 'Collega un altro dispositivo', href: '/impostazioni/collega' }))
  );
}

/** Memoria: this device only. The app: downloads and cache; a browser: the cache. */
function memoryRows() {
  const out = [];
  if (memory.hasDownloads) {
    const n = memory.downloadsCount;
    out.push(
      row({
        ic: 'downloaded',
        title: 'Elimina download',
        sub: n ? `${fmtSpace(memory.downloadsBytes)}, ${nBrani(n)}` : 'Nessun download',
        chevron: false,
        cls: 'mem-downloads',
        onClick: async () => {
          if (!memory.downloadsCount) return;
          const ok = await confirmDialog({ title: 'Eliminare i download?', message: 'Restano sulle fonti.', okLabel: 'Elimina', danger: true });
          if (!ok) return;
          await memory.clearDownloads();
          toast('Download eliminati');
        },
      })
    );
  }
  out.push(
    row({
      ic: 'cache',
      title: 'Svuota cache',
      sub: fmtSpace(memory.cacheBytes),
      chevron: false,
      cls: 'mem-cache',
      onClick: async () => {
        await memory.clearCache();
        toast('Cache svuotata');
      },
    })
  );
  return out;
}

export function settingsView() {
  const el = h('div', { class: 'view view-settings' });
  let soc = null;

  const build = () => {
    const srcRows = sources.ordered().map((s) =>
      row({ ic: 'server', dot: sources.isUp(s.id), title: s.name, badge: s.principal ? 'Principale' : null, sub: sourceLine(s), href: `/impostazioni/fonte/${encodeURIComponent(s.id)}`, cls: sources.isUp(s.id) ? '' : 'is-down' })
    );
    srcRows.push(row({ ic: 'plus', title: 'Aggiungi fonte', onClick: () => openAddSource({ askName: askNameIfMissing }), chevron: false, cls: 'set-add' }));

    const qs = quality.settings;
    const qRow = row({
      ic: 'quality',
      title: 'Qualità audio',
      sub: `Wi-Fi: ${quality.labelOf(qs.wifi)}, dati mobili: ${quality.labelOf(qs.cellular)}, download: ${quality.labelOf(qs.download)}`,
      href: '/impostazioni/qualita',
    });

    // The app's version only: the author signs once, at the foot of the page.
    const info = [row({ ic: logoEl(24), title: BRAND, sub: `Versione ${APP_VERSION}`, chevron: false })];
    // The limit of the chats, said plainly.
    if (social.chatsSupported) info.push(row({ ic: 'lock', title: 'Messaggi', sub: 'Cifrati: le fonti vedono chi scrive a chi e quando, non cosa.', chevron: false, cls: 'info-messages' }));

    if (soc) soc.stop();
    soc = social.settingsSupported ? socialSection() : null;
    // The phone's own music: its access while it is off, then its "Cerca i dettagli in rete".
    const ph = sources.phone;
    const phoneRows = !ph
      ? null
      : ph.state === 'off'
        ? row({ ic: 'note', title: "Consenti l'accesso alla musica", sub: 'Per vedere i brani salvati sul telefono', onClick: () => nativeCall('askMusicAccess', 'settings'), chevron: false, cls: 'phone-access' })
        : switchRow({ ic: 'search', title: 'Cerca i dettagli in rete', on: phoneDetails(), onToggle: (v) => store.setSourceDetails(PHONE_ID, v), cls: 'details-switch phone-details' });
    // The switch shows the player's state as soon as it changed (the page is not drawn again for it).
    const volRow = switchRow({ ic: 'volume', title: 'Volume uniforme', sub: 'Ogni brano allo stesso volume', on: player.volumeNorm, cls: 'volnorm-switch', onToggle: (v) => {
      player.setVolumeNorm(v);
      volRow.setAttribute('aria-checked', String(player.volumeNorm));
    } });
    put(
      el,
      topBar('Impostazioni'),
      personBlock(),
      section('Fonti musicali', ...srcRows),
      phoneRows ? section('Musica del telefono', phoneRows) : null,
      soc ? soc.el : null,
      section('Qualità audio', qRow, volRow),
      section('Memoria', ...memoryRows()),
      section('Informazioni', ...info),
      h('p', { class: 'set-foot' }, authorLink('author-link'))
    );
  };
  const sig = () =>
    JSON.stringify([
      profile.data,
      sources.ordered().map((s) => [s.id, s.name, s.principal, sources.isUp(s.id), sources.healthOf(s.id), store.libOf(s.id)?.tracks.length]),
      sources.phone ? sources.phone.state === 'off' : null,
      quality.settings,
      memory.hasDownloads ? [memory.downloadsCount, memory.downloadsBytes] : null,
      memory.cacheBytes,
      social.settingsSupported,
      social.chatsSupported,
    ]);
  const render = keyedRender(build, sig);

  const offs = [
    sources.subscribe(() => render()),
    // The phone's switch is painted in place (its thumb slides), as a source's is.
    store.subscribe(() => el.querySelector('.phone-details')?.setAttribute('aria-checked', String(phoneDetails()))),
    quality.subscribe(() => render()),
    downloads.subscribe(() => render()),
    profile.subscribe(() => render()),
    memory.subscribe(() => render()),
    social.subscribe(() => {
      render();
      if (soc) soc.paint();
    }),
  ];
  render(true);
  sources.loadHealth();
  memory.refresh();
  social.readSettings();
  return {
    el,
    tab: 'settings',
    update: () => render(),
    destroy: () => {
      if (soc) soc.stop();
      offs.forEach((f) => f());
    },
  };
}

/**
 * "Persone bloccate": each person you blocked (photo, name and tag), with "Sblocca", which asks
 * nothing; none: "Nessuna persona bloccata".
 */
export function blockedView() {
  const el = h('div', { class: 'view view-settings view-blocked' });
  const listEl = h('div', { class: 'set-list blocked-list' });
  const unblocking = new Set();
  const build = () => {
    const ids = social.blocked.filter((id) => !unblocking.has(id));
    if (!ids.length) {
      put(el, topBar('Persone bloccate'), h('div', { class: 'empty' }, h('h2', {}, 'Nessuna persona bloccata')));
      return;
    }
    listEl.replaceChildren(
      ...ids.map((id) => {
        const p = social.byId(id);
        const name = p ? p.name : profileIdText(id) || id.slice(0, 8);
        const b = h('button', { type: 'button', class: 'btn btn-light btn-small' }, 'Sblocca');
        b.addEventListener('click', async () => {
          if (unblocking.has(id)) return;
          unblocking.add(id);
          render(true);
          const ok = await social.unblock(id);
          if (!ok) unblocking.delete(id);
          render(true);
        });
        return h(
          'div',
          { class: 'set-row blocked-row static' },
          personAvatar({ name, photoUrl: p ? photoUrlOf(p) : null, size: 40 }),
          h('span', { class: 'set-text' }, h('span', { class: 'set-title' }, h('span', { class: 'set-title-text' }, name), p && p.tag ? h('span', { class: 'id-tag' }, sep(), p.tag) : null)),
          b
        );
      })
    );
    put(el, topBar('Persone bloccate'), listEl);
  };
  const sig = () => JSON.stringify([social.blocked, [...unblocking], social.blocked.map((id) => { const p = social.byId(id); return p ? [p.name, p.tag, p.photo] : null; })]);
  const render = keyedRender(build, sig);
  const off = social.subscribe(() => render());
  render(true);
  social.readSettings();
  return {
    el,
    tab: 'settings',
    update: () => render(),
    destroy: () => off(),
  };
}

export function qualityView() {
  const el = h('div', { class: 'view view-settings view-quality' });
  const netNote = h('p', { class: 'set-intro' });
  const groups = KINDS.map(({ key, label }) => {
    const list = h('div', { class: 'set-list', role: 'radiogroup', 'aria-label': label });
    const buttons = CHOICES.map((c) => {
      const b = h(
        'button',
        { type: 'button', class: 'set-row radio-row', role: 'radio', dataset: { value: c.value } },
        h('span', { class: 'set-text' }, h('span', { class: 'set-title' }, h('span', { class: 'set-title-text' }, c.label)), h('span', { class: 'set-sub' }, c.desc)),
        h('span', { class: 'radio-dot', 'aria-hidden': 'true' })
      );
      b.addEventListener('click', () => quality.set(key, c.value));
      list.append(b);
      return b;
    });
    return { key, el: h('section', { class: 'set-section' }, h('h2', { class: 'set-section-title' }, label), list), buttons };
  });

  const paint = () => {
    const qs = quality.settings;
    for (const g of groups) {
      for (const b of g.buttons) {
        const on = qs[g.key] === b.dataset.value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }
    const t = quality.networkType();
    netNote.textContent = `Rete attuale: ${t === 'cellular' ? 'dati mobili' : t === 'ethernet' ? 'cavo' : t === 'none' ? 'nessuna' : 'Wi-Fi'}`;
  };

  // Arrow keys move inside a radio group, like native radio buttons.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const b = e.target.closest?.('.radio-row');
    if (!b) return;
    const all = [...b.parentElement.children];
    const next = all[(all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    e.preventDefault();
    next.click();
    next.focus();
  });

  el.append(topBar('Qualità audio'), netNote, ...groups.map((g) => g.el));
  paint();
  const off = quality.subscribe(paint);
  return { el, tab: 'settings', destroy: off };
}

// ------------------------------------------------------------------ the memory card

const STORAGE_TITLE = 'Scheda di memoria';

/** The row, or null when the source has no card to show (an older source answers nothing). */
function storageRow(s, view, done) {
  const st = view ? storageState(view) : null;
  if (!st) return null;
  const tap = st.tap === 'use' ? () => useCardFlow(s, st.found, done) : st.tap === 'inUse' ? () => inUseSheet(s, view, done) : st.tap === 'away' ? () => awaySheet(s, view, done) : null;
  return row({ ic: 'sdcard', title: STORAGE_TITLE, sub: st.sub, onClick: tap || undefined, chevron: false, danger: !!st.danger, cls: 'storage-row' });
}

const storageCall = async (s, body, done) => {
  try {
    done(await srcApi(s.id).setStorage(body));
  } catch {
    toast('Qualcosa non ha funzionato');
  }
};

const useCardFlow = oneAtATime(async (s, f, done) => {
  const body = h(
    'div',
    {},
    h('p', { class: 'dialog-text' }, "La musica nuova andrà sulla scheda e quella che c'è già ci verrà spostata piano piano. Il resto della fonte resta nella memoria interna."),
    f.appFolder ? h('p', { class: 'dialog-text' }, 'La musica starà nella cartella di Termux sulla scheda: se disinstalli Termux, Android la cancella.') : null
  );
  const ok = await openDialog({
    title: 'Usare la scheda per la musica?',
    body,
    actions: [
      { label: 'Annulla', value: false },
      { label: 'Usa la scheda', cls: 'btn-primary', submit: true, value: true },
    ],
  });
  if (ok) await storageCall(s, { use: f.volume }, done);
}, bySource);

function inUseSheet(s, view, done) {
  const c = view.card;
  const short = Number.isFinite(c.needBytes) && c.needBytes > 0;
  openSheet({
    label: STORAGE_TITLE,
    items: [
      short
        ? { info: true, icon: 'sdcard', label: 'Smetti di usare la scheda', lines: [`Servono ${fmtSize(c.needBytes)} liberi nella memoria interna`] }
        : { icon: 'sdcard', label: 'Smetti di usare la scheda', sub: 'La musica torna nella memoria interna', onSelect: () => storageCall(s, { leave: true }, done) },
    ],
  });
}

function awaySheet(s, view, done) {
  const n = view.card ? view.card.awayTracks : 0;
  openSheet({
    label: STORAGE_TITLE,
    items: [{ icon: 'trash', label: 'Dimentica la scheda', danger: true, onSelect: () => forgetCardFlow(s, n, done) }],
  });
}

const forgetCardFlow = oneAtATime(async (s, n, done) => {
  const ok = await confirmDialog({
    title: 'Dimenticare la scheda?',
    message: `I ${fmtInt(n)} brani che erano sulla scheda escono dalla libreria. I file sulla scheda non vengono toccati.`,
    okLabel: 'Dimentica',
    danger: true,
  });
  if (ok) await storageCall(s, { forget: true }, done);
}, bySource);

export function sourceView(id) {
  const el = h('div', { class: 'view view-settings view-source' });
  const stateLine = h('span', { class: 'src-state' });
  const dotSlot = h('span', { class: 'src-dot-slot' });
  // The memory card's state: read when the view opens and when the health is read again, never on a timer.
  let storage = null;
  let storageHealth;
  // Asked once the source and its owner are known: at a cold start the view comes before both.
  let storageAsked = false;
  const loadStorage = async () => {
    const s = sources.get(id);
    if (!s || store.roleOf(s.id) !== 'owner') return;
    storageAsked = true;
    try {
      storage = await srcApi(s.id).storage();
    } catch {
      storage = null;
    }
    render();
  };
  const storageDone = (view) => {
    storage = view;
    render();
  };

  const build = () => {
    const s = sources.get(id);
    if (!s) {
      el.replaceChildren(topBar('Fonte'), h('div', { class: 'empty' }, h('h2', {}, sources.loaded ? 'Fonte non trovata' : 'Caricamento...')));
      return;
    }
    const hl = sources.healthOf(s.id);
    const role = store.roleOf(s.id);
    const owner = role === 'owner';
    // Only a source that says where it stands has the switch (an older one has no such lookup).
    const details = store.libOf(s.id)?.source?.details;
    const hadFocus = !!document.activeElement?.closest?.('.details-switch');
    const stats = [];
    const n = hl && Number.isFinite(hl.tracks) ? hl.tracks : store.libOf(s.id)?.tracks.length;
    if (Number.isFinite(n)) stats.push(nBrani(n).replace(/^\d+/, fmtInt(n)));
    if (hl && Number.isFinite(hl.diskFreeBytes)) stats.push(`${fmtSize(hl.diskFreeBytes)} liberi`);
    const head = h(
      'div',
      { class: 'src-head' },
      h('span', { class: 'src-icon' }, icon('server', 40)),
      h('div', { class: 'src-text' }, h('h2', { class: 'src-name' }, h('span', {}, s.name), s.principal ? h('span', { class: 'badge' }, 'Principale') : null), h('p', { class: 'src-state-row' }, dotSlot, stateLine), stats.length ? h('p', { class: 'src-stats' }, stats.join(', ')) : null)
    );
    el.replaceChildren(
      topBar(s.name),
      head,
      h(
        'div',
        { class: 'set-list src-actions' },
        // The source's own name exists only with profiles, and only its owner changes it.
        owner ? row({ ic: 'edit', title: 'Rinomina fonte', onClick: () => renameFlow(s), chevron: false }) : null,
        owner && typeof details === 'boolean' ? switchRow({ ic: 'search', title: 'Cerca i dettagli in rete', on: details, onToggle: (v) => store.setSourceDetails(s.id, v), cls: 'details-switch' }) : null,
        owner ? storageRow(s, storage, storageDone) : null,
        s.principal ? null : row({ ic: 'star', title: 'Imposta come principale', sub: 'Playlist e Mi piace su questa fonte', onClick: () => switchPrincipal(s.id), chevron: false }),
        row({ ic: 'key', title: 'Mostra codice', sub: 'Per aggiungere questa fonte', onClick: () => showCodeFlow(s), chevron: false }),
        role !== 'member' ? row({ ic: 'rotate', title: 'Cambia codice', sub: 'Il codice attuale smette di funzionare', onClick: () => rotateCodeFlow(s), chevron: false }) : null,
        row({ ic: 'phone', title: 'Dispositivi collegati', onClick: () => devicesPanel(s) }),
        row({ ic: 'trash', title: 'Rimuovi fonte', danger: true, onClick: () => removeFlow(s), chevron: false })
      )
    );
    paintState();
    if (hadFocus) el.querySelector('.details-switch')?.focus();
  };
  // The switch's state is painted in place: the page is drawn again only when it comes or goes.
  const paintSwitch = () => {
    const on = store.libOf(id)?.source?.details;
    const b = el.querySelector('.details-switch');
    if (b && typeof on === 'boolean') b.setAttribute('aria-checked', String(on));
  };
  // The state (dot and word) is updated in place, not re-rendered.
  const paintState = () => {
    const s = sources.get(id);
    if (!s) return;
    const up = sources.isUp(s.id);
    stateLine.textContent = up ? 'Connessa' : 'Non raggiungibile';
    el.classList.toggle('is-down', !up);
    const dot = dotSlot.firstElementChild;
    if (!dot || dot.classList.contains('up') !== up) dotSlot.replaceChildren(stateDot(up));
  };
  const sig = () => {
    const s = sources.get(id);
    return JSON.stringify(s ? [s.name, s.principal, store.roleOf(s.id), sources.healthOf(s.id), store.libOf(s.id)?.tracks.length, typeof store.libOf(s.id)?.source?.details, storage] : [sources.loaded]);
  };
  const render = keyedRender(build, sig);
  const off = sources.subscribe(() => {
    const hl = sources.healthOf(id);
    if (hl && hl !== storageHealth) {
      storageHealth = hl;
      loadStorage();
    } else if (!storageAsked) loadStorage();
    render();
    paintState();
    paintSwitch();
  });
  render(true);
  sources.loadHealth();
  storageHealth = sources.healthOf(id);
  loadStorage();
  return {
    el,
    tab: 'settings',
    update: () => {
      if (!storageAsked) loadStorage();
      render();
      paintSwitch();
    },
    destroy: off,
  };
}
