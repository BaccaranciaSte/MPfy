// The person's own pages in Impostazioni:
//   /impostazioni/profilo    "Profilo": the photo (a tap: "Cambia foto", "Rimuovi foto"), name,
//                            profile code, the profile file (app) or "Esporta profilo" (browser),
//                            "Recupero con password"
//   /impostazioni/collega    "Collega un altro dispositivo": the profile code, only on demand, and
//                            its QR code, which also carries the code of every source of this
//                            person: one scan on the new device brings the profile and its sources
//   /impostazioni/recupero   "Recupero con password": on, change, off
// Nothing here is ever suggested elsewhere: the recovery is the person's choice.

import { h, iconBtn, oneAtATime, repeatTap } from '../js/dom.js';
import { patchParts } from '../js/settle.js';
import { icon } from '../icons/icons.js';
import { profile } from '../js/profile.js';
import { native, nativeCall, nativeJson, onNative, bridgeVersion } from '../js/native.js';
import { goBack } from '../js/router.js';
import { charCount, cleanName } from '../js/util.js';
import { localWords } from '../js/words.js';
import { actionDialog, confirmDialog } from '../components/sheet.js';
import { toast } from '../components/toast.js';
import { avatar, avatarSig } from '../components/avatar.js';
import { openPhotoMenu } from '../components/photo-edit.js';
import { sources } from '../js/sources.js';
import { srcApi } from '../js/api.js';
import { qrSvg } from '../js/qr.js';
import { profileLink, MAX_LINK_SOURCES } from '../js/links.js';

function topBar(title) {
  const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
  return h('header', { class: 'set-top' }, back, h('h1', { class: 'set-top-title' }, title), h('span', { class: 'icon-spacer' }));
}

/** One list row: a link (href), a button (onClick) or plain text. */
function row({ ic, title, sub, href, onClick, chevron = !!(href || onClick), danger = false, cls = '' }) {
  const kids = [
    h('span', { class: 'set-icon' }, icon(ic, 24)),
    h('span', { class: 'set-text' }, h('span', { class: 'set-title' }, h('span', { class: 'set-title-text' }, title)), sub ? h('span', { class: 'set-sub' }, sub) : null),
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

/** "Il tuo nome": rename yourself. */
export function renameSelf() {
  const input = h('input', { class: 'text-input text-input-big', type: 'text', placeholder: 'Nome', 'aria-label': 'Nome', autocomplete: 'off', enterkeyhint: 'done' });
  input.value = profile.name;
  return actionDialog({
    title: 'Il tuo nome',
    body: input,
    okLabel: 'Salva',
    onSubmit: async () => {
      const name = cleanName(input.value);
      if (!name || charCount(name) > 40) return 'Nome non valido';
      if (name === profile.name) return null;
      try {
        await profile.rename(name);
        return null;
      } catch (err) {
        return localWords(err);
      }
    },
  });
}

/** Copies a secret: in the app marked sensitive (no preview, cleared after a while). */
async function copySecret(text) {
  if (native && bridgeVersion() >= 3) {
    nativeCall('copySecret', text);
    return true;
  }
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

/** The profile file: where the app keeps it, or "Non salvato". */
function fileSub() {
  const f = nativeJson('getProfileFile');
  if (f && f.fileName && (f.state === 'ok' || f.state === 'pending')) return `${f.folder || 'Documents/MPfy'}/${f.fileName}`;
  return 'Non salvato';
}

/**
 * "Esporta profilo": the identity as <name>.mpfy, a download of this browser. One file per tap: not
 * a second one for the second tap of a double tap, nor while the first is still on its way.
 */
const exportOnce = oneAtATime(async () => {
  try {
    const { fileName, identity } = await profile.exportFile();
    const blob = new Blob([`${JSON.stringify(identity, null, 2)}\n`], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: fileName || 'MPfy.mpfy', class: 'visually-hidden' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    toast(localWords(err));
  }
});
const exportProfile = () => (repeatTap('export-profile') ? undefined : exportOnce());

/** The photo, large and centred, with the pencil: a tap opens its menu. */
function photoHead() {
  const b = h('button', { type: 'button', class: 'photo-btn', 'aria-label': 'Foto del profilo', 'aria-haspopup': 'menu' }, avatar(112), h('span', { class: 'photo-badge', 'aria-hidden': 'true' }, icon('edit', 18)));
  b.addEventListener('click', () => openPhotoMenu());
  return h('div', { class: 'photo-head' }, b);
}

export function profileView() {
  const el = h('div', { class: 'view view-settings view-profile' });
  // In parts: a new photo draws the photo again, a new name the rows; nothing else moves.
  const build = () => {
    const app = !!native;
    const file = app ? (bridgeVersion() >= 3 ? fileSub() : 'Non salvato') : null;
    const rows = () =>
      h(
        'div',
        { class: 'set-list' },
        row({ ic: 'profile', title: 'Nome', sub: profile.name || null, onClick: () => renameSelf() }),
        row({ ic: 'key', title: 'Codice del profilo', href: '/impostazioni/collega' }),
        app ? row({ ic: 'file', title: 'File del profilo', sub: file, chevron: false, cls: 'file-row' }) : row({ ic: 'file', title: 'Esporta profilo', onClick: exportProfile, chevron: false }),
        h('p', { class: 'set-note' }, "Contiene l'accesso alle tue fonti: tienilo per te."),
        row({ ic: 'lock', title: 'Recupero con password', sub: profile.recovery ? 'Attivo' : 'Disattivato', href: '/impostazioni/recupero' })
      );
    patchParts(
      el,
      [
        { key: 'top', sig: '', build: () => topBar('Profilo') },
        { key: 'photo', sig: avatarSig(), build: photoHead },
        { key: 'rows', sig: JSON.stringify([profile.name, profile.recovery, app, file]), build: rows },
      ],
      { carry: false }
    );
  };
  const offs = [profile.subscribe(build), onNative('profileFileState', build)];
  build();
  profile.refresh();
  return { el, tab: 'settings', destroy: () => offs.forEach((f) => f()) };
}

/** The profile code in big type: MPFY-P, then groups of 4. */
function codeGrid(code) {
  const parts = code.split('-');
  const groups = parts.slice(2);
  return h('div', { class: 'code-big code-big-profile', 'aria-label': code.split('').join(' ') }, h('span', { class: 'code-big-prefix' }, 'MPFY-P'), groups.map((g) => h('span', { class: 'code-big-group' }, g)));
}

/** A source's code as "Mostra codice" reads it, or null when the source does not give it within 8 s. */
function sourceCode(s) {
  const late = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  const asked = srcApi(s.id)
    .adminCode()
    .then(
      (r) => (typeof r?.code === 'string' ? r.code : null),
      () => null
    );
  return Promise.race([asked, late]);
}

export function linkDeviceView() {
  const el = h('div', { class: 'view view-settings view-link' });
  const slot = h('div', { class: 'link-code' });
  const show = h('button', { type: 'button', class: 'btn btn-primary' }, 'Mostra codice');
  show.addEventListener('click', async () => {
    show.disabled = true;
    try {
      const [{ code }, codes] = await Promise.all([profile.code(), Promise.all(sources.ordered().slice(0, MAX_LINK_SOURCES).map(sourceCode))]);
      const got = codes.filter(Boolean);
      const missed = codes.length - got.length;
      const copy = h('button', { type: 'button', class: 'btn btn-light btn-small code-copy' }, icon('copy', 18), 'Copia');
      // The copy carries the sources too, as the QR does: pasted on the other device, it brings everything.
      copy.addEventListener('click', async () => toast((await copySecret(profileLink(code, got))) ? 'Codice copiato' : 'Qualcosa non ha funzionato'));
      const qr = h('div', { class: 'qr-box qr-box-profile' }, qrSvg(profileLink(code, got), 'Codice QR del profilo'));
      const miss = h('p', { class: 'qr-miss' }, missed === 1 ? 'Una fonte non risponde e non è nel codice QR' : `${missed} fonti non rispondono e non sono nel codice QR`);
      slot.replaceChildren(qr, ...(missed ? [miss] : []), codeGrid(code), h('div', { class: 'code-copy-row' }, copy));
      show.remove();
    } catch (err) {
      show.disabled = false;
      toast(localWords(err));
    }
  });
  el.append(
    topBar('Collega un altro dispositivo'),
    h(
      'div',
      { class: 'link-body' },
      h('span', { class: 'link-icon' }, icon('devices', 40)),
      h('p', { class: 'link-line' }, 'Sul nuovo dispositivo scegli "Ho già un profilo".'),
      h('p', { class: 'warn' }, icon('lock', 18), h('span', {}, 'Solo per i tuoi dispositivi')),
      show,
      slot
    )
  );
  return { el, tab: 'settings' };
}

/** "Imposta una password": twice, at least 8 characters. changing: the button says "Salva". */
function passwordDialog(changing) {
  const mk = (label) => {
    const id = `pw-${Math.random().toString(36).slice(2, 7)}`;
    const input = h('input', { id, class: 'text-input', type: 'password', autocomplete: 'new-password', enterkeyhint: 'next' });
    return { input, el: h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), input) };
  };
  const a = mk('Password');
  const b = mk('Ripeti la password');
  b.input.setAttribute('enterkeyhint', 'done');
  // Enter (the keyboard's "next") in the first field goes on to the second; only the second sends.
  a.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    b.input.focus();
  });
  const body = h('div', { class: 'dialog-fields' }, a.el, b.el, h('p', { class: 'field-hint' }, 'Almeno 8 caratteri. Meglio una frase breve.'));
  return actionDialog({
    title: 'Imposta una password',
    body,
    okLabel: changing ? 'Salva' : 'Attiva',
    busyLabel: changing ? null : 'Attivazione...',
    initialFocus: a.input,
    onSubmit: async () => {
      const pw = a.input.value;
      if (charCount(pw.normalize('NFC')) < 8) return 'Almeno 8 caratteri';
      if (pw !== b.input.value) return 'Le password non coincidono';
      try {
        await profile.enableRecovery(pw);
        return null;
      } catch (err) {
        return localWords(err);
      }
    },
  });
}

export function recoveryView() {
  const el = h('div', { class: 'view view-settings view-recovery' });
  const build = () => {
    const on = profile.recovery;
    let body;
    if (on) {
      body = h(
        'div',
        { class: 'set-list' },
        row({
          ic: 'key',
          title: 'Cambia password',
          chevron: false,
          onClick: async () => {
            if (await passwordDialog(true)) toast('Password cambiata');
          },
        }),
        row({
          ic: 'close',
          title: 'Disattiva',
          danger: true,
          chevron: false,
          onClick: async () => {
            const ok = await confirmDialog({ title: 'Disattivare il recupero?', message: 'La password non servirà più.', okLabel: 'Disattiva', danger: true });
            if (!ok) return;
            try {
              await profile.disableRecovery();
              toast('Recupero disattivato');
            } catch (err) {
              toast(localWords(err));
            }
          },
        })
      );
    } else {
      const start = h('button', { type: 'button', class: 'btn btn-primary' }, 'Attiva');
      start.addEventListener('click', async () => {
        if (await passwordDialog(false)) toast('Recupero attivo');
      });
      body = h('div', { class: 'recovery-off' }, start);
    }
    el.replaceChildren(topBar('Recupero con password'), h('div', { class: 'recovery-head' }, h('span', { class: 'link-icon' }, icon('lock', 40)), h('p', { class: 'link-line' }, 'Usa una password che non usi altrove.')), body);
  };
  const off = profile.subscribe(build);
  build();
  return { el, tab: 'settings', destroy: off };
}
