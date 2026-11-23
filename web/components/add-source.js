// Adding a source: one field for its permanent code, formatted in groups of 4 while typing. The
// code is MPFY- plus 32 Crockford base32 characters: case, spaces and dashes do not matter, I and
// L read as 1, O as 0. A profile code (MPFY-P-..., much longer) in this field is named as such.
// The same form serves every add flow: the first source of the welcome screens, "Aggiungi fonte"
// in Impostazioni, and the #aggiungi=<code> fragment the Android app opens with. In the app,
// "Scansiona il codice QR" fills the field from a QR code and adds at once; the link of a
// profile's QR (links.js) brings every source in it: the first in the field, the others added
// right after it (one this device already has is passed over), the first failure shown as usual.
//
// After every add: when this device is the source's owner and the source has no name of its own
// yet, "Dai un nome a questa fonte" (the name everyone paired with it will see). When the core
// could not tell the role in time, it is asked every second for up to 20 s first; a source the
// core already knows has no profiles is not waited for.

import { h, repeatTap } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { openPanel, actionDialog } from './sheet.js';
import { toast } from './toast.js';
import { sources } from '../js/sources.js';
import { store } from '../js/store.js';
import { profile } from '../js/profile.js';
import { codeKind, wordsFor } from '../js/words.js';
import { charCount, cleanName } from '../js/util.js';
import { parseLink } from '../js/links.js';
import { canScan, scanCode } from '../js/native.js';

const BODY_LEN = 32;

/** Crockford base32 characters only, uppercase, with the usual misreadings mapped. */
function clean(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
}

/**
 * Whether the cleaned text carries the "MPFY" prefix: only when it is longer than a body. M, P,
 * F and Y are code characters too, so a body may itself start with MPFY (about 1 in a million
 * codes): a text of 32 characters or fewer is always a body, or that code could never be typed
 * after the "MPFY-" shown before the field. A full code pasted with its prefix is 36.
 */
const hasPrefix = (s) => s.length > BODY_LEN && s.startsWith('MPFY');

/** The 32 characters after "MPFY-" (the prefix of a pasted or typed full code is dropped). */
export function codeBody(raw) {
  const s = clean(raw);
  return (hasPrefix(s) ? s.slice(4) : s).slice(0, BODY_LEN);
}

const groups = (body) => (body.match(/.{1,4}/g) || []).join('-');

/** The full code as the sources show it: MPFY-XXXX-XXXX-... */
export const formatCode = (body) => `MPFY-${groups(body)}`;

/** The words for a failed add: the core's code, else its status. */
function addError(err) {
  const w = wordsFor(err?.code, err?.src ? sources.name(err.src) : null);
  if (w) return w;
  const st = err?.status;
  if (st === 400) return 'Codice non valido';
  if (st === 409) return 'Fonte già collegata';
  if (st === 0 || (st >= 502 && st <= 504)) return 'Fonte non raggiungibile';
  return 'Qualcosa non ha funzionato';
}

/**
 * The code field: "MPFY-" before a two-line textarea that formats the code in groups of 4 while
 * typing (the 39 characters wrap at a dash instead of scrolling out of sight on a phone), and a
 * count under it. A profile code is left as typed, with its own words. onChange(state) after
 * every change, state { complete, profileCode }. Enter calls onEnter.
 */
export function codeField({ onChange, onEnter } = {}) {
  const id = `as-code-${Math.random().toString(36).slice(2, 7)}`;
  const input = h('textarea', {
    id,
    class: 'text-input code-input',
    rows: '2',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
    'aria-describedby': `${id}-count`,
  });
  const count = h('span', { id: `${id}-count`, class: 'as-count' });
  const el = h(
    'label',
    { class: 'field', for: id },
    h('span', { class: 'field-label' }, 'Codice'),
    h('span', { class: 'code-box' }, h('span', { class: 'code-prefix', 'aria-hidden': 'true' }, 'MPFY-'), input),
    count
  );
  let profileCode = false;
  const state = () => ({ complete: codeBody(input.value).length === BODY_LEN && !profileCode, profileCode });
  function paint() {
    const n = codeBody(input.value).length;
    count.textContent = profileCode ? '' : n === BODY_LEN ? 'Codice completo' : `${n} di ${BODY_LEN} caratteri`;
    count.classList.toggle('ok', n === BODY_LEN && !profileCode);
    onChange?.(state());
  }
  // Reformat in groups of 4 while typing, keeping the caret after the same character. The prefix
  // is decided on the whole text (codeBody), and the characters before the caret lose it too.
  function reformat() {
    const raw = input.value;
    profileCode = codeKind(raw) === 'profile';
    if (!profileCode) {
      const caret = input.selectionStart ?? raw.length;
      const cut = hasPrefix(clean(raw)) ? 4 : 0;
      const before = Math.min(BODY_LEN, Math.max(0, clean(raw.slice(0, caret)).length - cut));
      const out = groups(codeBody(raw));
      if (out !== raw) {
        input.value = out;
        const pos = before ? Math.min(out.length, before + Math.floor((before - 1) / 4)) : 0;
        try {
          input.setSelectionRange(pos, pos);
        } catch {
          /* not focused */
        }
      }
    }
    paint();
  }
  input.addEventListener('input', reformat);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onEnter?.();
  });
  paint();
  return {
    el,
    input,
    state,
    /** The full code, MPFY-XXXX-... */
    code: () => formatCode(codeBody(input.value)),
    fill(c) {
      input.value = c;
      reformat();
    },
    focus: () => input.focus({ preventScroll: true }),
  };
}

/** Whether a code field on screen holds this code, as it was given (not edited, not gone). */
export function codeOnScreen(code) {
  const body = codeBody(code);
  return !!body && [...document.querySelectorAll('.code-input')].some((i) => codeBody(i.value) === body);
}

/**
 * "Scansiona il codice QR", for a code field: in the app with a scanner only (null elsewhere).
 * onText(text) gets what it read (a link of ours or a code).
 */
export function scanButton(onText) {
  if (!canScan()) return null;
  const b = h('button', { type: 'button', class: 'btn btn-ghost btn-wide scan-btn' }, icon('qr', 20), 'Scansiona il codice QR');
  b.addEventListener('click', async () => {
    if (repeatTap('scan-code')) return;
    const r = await scanCode();
    if (r.state === 'ok') onText(r.text);
    else if (r.state === 'denied') toast("Serve l'accesso alla fotocamera");
    else if (r.state === 'error') toast('Qualcosa non ha funzionato');
  });
  return b;
}

/** What a scanned or opened text puts in a source field: { code, more } (more: the link's other sources). */
export function sourcesOf(text) {
  const link = parseLink(text);
  if (!link) return { code: text, more: [] };
  // A profile's link with no source: its profile code, which the field names as such.
  if (!link.sources.length) return { code: link.profile, more: [] };
  return { code: link.sources[0], more: link.sources.slice(1) };
}

let adding = 0;
const addEnded = new Set();
// The code forms made so far, the newest last: the sources of a link go to one still on screen.
const forms = new Set();

/**
 * Whether a source is being added: from the tap on "Aggiungi" to the end of what follows it (the
 * naming step, the person's name). That part runs in this page only, also after the form is gone.
 */
export const addingSource = () => adding > 0;

/** fn() each time an add ends. Returns the unsubscribe. */
export function onAddEnd(fn) {
  addEnded.add(fn);
  return () => addEnded.delete(fn);
}

/**
 * The code form of every add flow. heading: "Collega una fonte" (only where no title is above
 * it). onAdded(source) runs after the core paired it. Returns { el, fill(code, more), focus(),
 * submit(), showError(words) }: more are the other sources of a link, added after the field's.
 */
export function sourceCodeForm({ heading = true, onAdded } = {}) {
  const error = h('p', { class: 'as-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-wide' }, 'Aggiungi');
  let busy = false;
  let more = [];
  const field = codeField({
    onChange: (st) => {
      error.textContent = st.profileCode ? 'Questo è il codice del profilo' : '';
      submit.disabled = !st.complete || busy;
    },
    onEnter: () => submitNow(),
  });
  // Typing in the field is a code of its own: the link's other sources go.
  field.input.addEventListener('input', () => {
    more = [];
  });
  const fill = (code, rest = []) => {
    field.fill(code);
    more = rest.filter((c) => codeBody(c) !== codeBody(code));
  };
  const scan = scanButton((text) => {
    const got = sourcesOf(text);
    fill(got.code, got.more);
    submitNow();
  });
  const form = h(
    'form',
    { class: 'as-form', novalidate: true },
    heading ? h('div', { class: 'as-hero' }, h('span', { class: 'as-hero-icon' }, icon('server', 32)), h('h2', {}, 'Collega una fonte')) : null,
    field.el,
    scan,
    error,
    submit
  );
  submit.disabled = true;
  function submitNow() {
    if (!field.state().complete || busy) return;
    if (form.requestSubmit) form.requestSubmit();
    else submit.click();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!field.state().complete || busy) return;
    busy = true;
    submit.disabled = true;
    error.textContent = '';
    submit.textContent = 'Collegamento...';
    adding++;
    const codes = [field.code(), ...more.map((c) => formatCode(codeBody(c)))];
    more = [];
    const added = [];
    let failed = null;
    try {
      for (const code of codes) {
        try {
          added.push(await sources.add(code));
          store.refresh();
        } catch (err) {
          // A source of a link this device already has: on to the next one.
          if (codes.length > 1 && err?.status === 409) continue;
          failed = { code, err };
          break;
        }
      }
      busy = false;
      submit.textContent = 'Aggiungi';
      if (added.length) {
        await onAdded?.(added[0]);
        for (const s of added.slice(1)) await afterSourceAdded(s);
      }
      if (failed) {
        const words = addError(failed.err);
        if (form.isConnected) {
          field.fill(failed.code);
          error.textContent = words;
        } else openAddSource({ code: failed.code, error: words });
      } else if (!added.length) error.textContent = addError({ status: 409 });
    } catch (err) {
      error.textContent = addError(err);
    } finally {
      busy = false;
      submit.textContent = 'Aggiungi';
      submit.disabled = !field.state().complete;
      adding--;
      for (const fn of addEnded) fn();
    }
  });

  const api = {
    el: form,
    fill,
    focus: field.focus,
    submit: submitNow,
    showError: (words) => {
      error.textContent = words;
    },
  };
  for (const f of forms) if (!f.el.isConnected) forms.delete(f);
  forms.add(api);
  return api;
}

/**
 * The sources of a profile's link, once the profile came in: added at once by the code form on
 * screen (the first source step), or by "Aggiungi fonte" when none is (the way in already gave
 * way to the library).
 */
export function addLinkedSources(codes, { askName = null } = {}) {
  if (!codes.length) return;
  let form = null;
  for (const f of forms) if (f.el.isConnected) form = f;
  if (form) {
    form.fill(codes[0], codes.slice(1));
    form.submit();
  } else openAddSource({ code: codes[0], more: codes.slice(1), submit: true, askName });
}

/** "Dai un nome a questa fonte", prefilled with its current name. */
export function nameSourceStep(s) {
  const input = h('input', { class: 'text-input text-input-big', type: 'text', 'aria-label': 'Nome della fonte', autocomplete: 'off', enterkeyhint: 'done' });
  input.value = s.name || '';
  return actionDialog({
    title: 'Dai un nome a questa fonte',
    body: input,
    okLabel: 'Salva',
    cancelLabel: null,
    onSubmit: () => renameSource(s.id, input.value),
  });
}

/** The source's own name: 1 to 40 characters. Resolves an error line, or null when saved. */
export async function renameSource(id, raw) {
  const name = cleanName(raw);
  if (!name || charCount(name) > 40) return 'Nome non valido';
  try {
    await sources.renameSource(id, name);
    return null;
  } catch (err) {
    return err?.code === 'bad_name' ? 'Nome non valido' : wordsFor(err?.code) || (err?.status === 0 || err?.status >= 502 ? 'Fonte non raggiungibile' : 'Qualcosa non ha funzionato');
  }
}

/**
 * What follows every add: the naming step when this device owns an unnamed source (the role
 * asked every second for up to 20 s when the core did not know it yet), "<name> aggiunta" with
 * the name it ends up with, then the person's own name when it is still empty (a profile brought
 * by its code, and no source knew its name).
 */
export async function afterSourceAdded(s, { askName } = {}) {
  let src = s;
  if (src && !src.role && src.profiles !== false) src = (await sources.waitForRole(src.id)) || src;
  if (src?.role === 'owner' && src.named === false) await nameSourceStep(src);
  toast(`${(src && sources.get(src.id)?.name) || src?.name || 'Fonte'} aggiunta`);
  if (askName) {
    await profile.refresh();
    if (profile.data && !profile.name) await askName();
  }
}

let openNow = null;

/**
 * "Aggiungi fonte": the code form in a panel. code prefills it (more: the other sources of a
 * link), error shows under it, submit adds at once; onDone runs after the add flow.
 */
export function openAddSource({ code = '', more = [], error = '', submit = false, onDone, askName = null } = {}) {
  const prefill = (form) => {
    if (code) form.fill(code, more);
    if (error) form.showError(error);
    if (submit) form.submit();
  };
  if (openNow) {
    prefill(openNow);
    return;
  }
  let layer = null;
  const form = sourceCodeForm({
    heading: true,
    onAdded: async (s) => {
      await layer.close();
      await afterSourceAdded(s, { askName });
      onDone?.(s);
    },
  });
  const p = openPanel({
    title: '',
    label: 'Collega una fonte',
    cls: 'panel-add-source',
    onClose: () => {
      openNow = null;
    },
  });
  layer = p.layer;
  p.body.append(form.el);
  openNow = form;
  prefill(form);
  requestAnimationFrame(() => form.focus());
}
