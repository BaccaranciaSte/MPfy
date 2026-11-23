// The way in, before the app itself:
//   - no profile and no source: "Benvenuto in MPfy" with "Inizia" (name, then the first
//     source), "Ho già un profilo" (the profile code from another device, then the first source)
//     and "Recupera profilo" (the profile file, the password, or the profile code);
//   - a profile and no source: the first source at once;
//   - sources and no profile (an install from before profiles): the name, full screen, with
//     "Ho già un profilo" under it; the app works behind it as it did.
// The steps live inside this one view. Each step forward is a history layer, so the back arrow
// (in the top corner), Escape and the Android back button all go to the step before. Every
// failure is shown in our words from the core's code. The link of a profile's QR code (scanned,
// or opened by the app) fills "Ho già un profilo"; once the profile is in, its sources are added
// by themselves.

import { h, iconBtn, put, repeatTap } from '../js/dom.js';
import { icon, logoEl } from '../icons/icons.js';
import { BRAND, charCount, cleanName } from '../js/util.js';
import { profile } from '../js/profile.js';
import { sources } from '../js/sources.js';
import { store } from '../js/store.js';
import { native, nativeCall, onNative } from '../js/native.js';
import { codeKind, localWords } from '../js/words.js';
import { sourceCodeForm, codeField, afterSourceAdded, scanButton, sourcesOf, addLinkedSources } from '../components/add-source.js';
import { parseLink } from '../js/links.js';
import { actionDialog } from '../components/sheet.js';
import { toast } from '../components/toast.js';
import { openLayer } from '../js/router.js';

/** The person's name: 1 to 40 characters once cleaned. Resolves an error line or null. */
async function saveName(raw) {
  const name = cleanName(raw);
  if (!name || charCount(name) > 40) return 'Nome non valido';
  try {
    if (profile.data) await profile.rename(name);
    else await profile.create(name);
    return null;
  } catch (err) {
    return localWords(err);
  }
}

/** "Come ti chiami?" as a dialog (a profile brought by its code whose name nobody knew). */
export function askNameDialog() {
  const input = h('input', { class: 'text-input text-input-big', type: 'text', placeholder: 'Nome', 'aria-label': 'Nome', autocomplete: 'off', enterkeyhint: 'done' });
  return actionDialog({ title: 'Come ti chiami?', body: input, okLabel: 'Continua', cancelLabel: null, onSubmit: () => saveName(input.value) });
}

/**
 * The person has no name yet (a profile brought by its code that no source knew, or the question
 * left with the back button): once the sources were asked again (one may know it now), "Come ti
 * chiami?". One question at a time.
 */
let askingName = null;
export function askNameIfMissing() {
  if (!askingName) {
    askingName = (async () => {
      if (!profile.data || profile.name || !sources.list.length) return;
      await sources.sync();
      await profile.refresh();
      if (profile.data && !profile.name) await askNameDialog();
    })().finally(() => {
      askingName = null;
    });
  }
  return askingName;
}

/** After an identity arrived (file, password, code): everything is read again. */
async function identityChanged() {
  await Promise.all([profile.refresh(), sources.refresh()]);
  store.refresh();
}

/** kind: 'welcome' | 'first' | 'name' (the gate app.js decided). */
export function welcomeView(kind = 'welcome') {
  const el = h('div', { class: 'view view-welcome' });
  const top = h('div', { class: 'welcome-top' });
  const card = h('div', { class: 'welcome' });
  el.append(top, card);
  const trail = []; // the steps behind the current one: { step, layer }
  let step = null;
  let recovery = null; // { sessionId, source, entries, entry }
  let offs = [];
  let dead = false;
  let quiet = false; // layers this view closes itself: no step comes back from them
  let moved = false; // a step was left: the next one takes the focus

  function go(next, { back = false, replace = false } = {}) {
    if (step && !back && !replace) {
      const layer = openLayer(() => {
        if (!quiet) stepBack();
      });
      trail.push({ step, layer });
    }
    moved = !!step;
    step = next;
    render();
  }
  /** The layer of the last step closed (the arrow, Escape, the back button): that step again. */
  function stepBack() {
    const prev = trail.pop();
    if (!prev || dead) return;
    // Leaving the password way altogether: its session on the source goes too.
    if (!['pwCode', 'pwWho', 'pwPassword'].includes(prev.step)) cancelRecovery();
    go(prev.step, { back: true });
  }
  const back = () => trail[trail.length - 1]?.layer.close();
  /** Forgets the steps behind from index i on, with their history entries, showing none of them. */
  function dropTrail(i = 0) {
    if (i >= trail.length) return;
    const gone = trail.splice(i);
    quiet = true;
    try {
      gone[0].layer.close();
    } finally {
      quiet = false;
    }
  }
  function cancelRecovery() {
    if (recovery?.sessionId) profile.recoveryCancel(recovery.sessionId);
    recovery = null;
  }

  const title = (t) => h('h1', { class: 'welcome-title', tabindex: '-1' }, t);
  const line = (t) => h('p', { class: 'welcome-sub' }, t);
  const errLine = () => h('p', { class: 'as-error welcome-error', role: 'alert' });

  /**
   * A one-field step with its button: onSubmit resolves an error line or null. value prefills the
   * field; scan(text) gives what a scanned QR code puts in it (then it is sent at once); onEdit
   * runs when the person types.
   */
  function fieldStep({ heading, sub, label, placeholder, type = 'text', okLabel, busyLabel = null, extra = null, onSubmit, check = null, value = '', scan = null, onEdit = null }) {
    const id = `w-${Math.random().toString(36).slice(2, 7)}`;
    const input = h('input', { id, class: 'text-input', type, placeholder: placeholder || '', autocomplete: type === 'password' ? 'current-password' : 'off', autocapitalize: type === 'password' ? 'off' : 'sentences', enterkeyhint: 'done', spellcheck: 'false' });
    input.value = value;
    const error = errLine();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-wide welcome-btn' }, okLabel);
    const scanBtn = scan
      ? scanButton((text) => {
          input.value = scan(text);
          error.textContent = '';
          paint();
          if (form.requestSubmit) form.requestSubmit();
          else submit.click();
        })
      : null;
    const form = h(
      'form',
      { class: 'welcome-form', novalidate: true },
      label ? h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), input) : input,
      scanBtn,
      error,
      submit,
      extra
    );
    if (!label) input.setAttribute('aria-label', placeholder || heading);
    let busy = false;
    const paint = () => {
      submit.disabled = busy || !input.value.trim();
    };
    input.addEventListener('input', () => {
      error.textContent = '';
      onEdit?.();
      paint();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || !input.value.trim()) return;
      const bad = check ? check(input.value) : null;
      if (bad) {
        error.textContent = bad;
        return;
      }
      busy = true;
      paint();
      if (busyLabel) submit.textContent = busyLabel;
      error.textContent = '';
      let msg = null;
      try {
        msg = await onSubmit(input.value);
      } catch {
        msg = 'Qualcosa non ha funzionato';
      }
      busy = false;
      submit.textContent = okLabel;
      paint();
      if (msg && !dead) {
        error.textContent = msg;
        input.focus();
      }
    });
    paint();
    put(card, title(heading), sub ? line(sub) : null, form);
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  const steps = {
    welcome() {
      const start = h('button', { type: 'button', class: 'btn btn-primary btn-wide welcome-btn' }, 'Inizia');
      start.addEventListener('click', () => go('name'));
      const have = h('button', { type: 'button', class: 'btn btn-ghost btn-wide welcome-btn2' }, 'Ho già un profilo');
      have.addEventListener('click', () => go('profileCode'));
      const recover = h('button', { type: 'button', class: 'link-btn welcome-link' }, 'Recupera profilo');
      recover.addEventListener('click', () => go('recover'));
      put(card, h('div', { class: 'welcome-logo' }, logoEl(112)), title(`Benvenuto in ${BRAND}`), line('La tua musica, ovunque.'), h('div', { class: 'welcome-actions' }, start, have, recover));
    },

    name() {
      const upgraded = kind === 'name';
      let extra = null;
      if (upgraded) {
        extra = h('button', { type: 'button', class: 'link-btn welcome-link' }, 'Ho già un profilo');
        extra.addEventListener('click', () => go('profileCode'));
      }
      fieldStep({
        heading: 'Come ti chiami?',
        placeholder: 'Nome',
        okLabel: 'Continua',
        extra,
        onSubmit: async (v) => {
          const msg = await saveName(v);
          if (msg) return msg;
          // With no source yet, the first one (the gate may have switched to it already, as the
          // profile appeared); otherwise, or on a phone with music of its own, the gate opens by itself.
          if (!sources.list.length && !sources.phone && step !== 'first') go('first', { replace: true });
          return null;
        },
      });
    },

    first() {
      const form = sourceCodeForm({
        heading: false,
        onAdded: async (s) => {
          // The gate opens now that a source is here; the naming step (and the name, when it is
          // still empty) follows over the library.
          await afterSourceAdded(s, { askName: askNameIfMissing });
        },
      });
      put(card, title('Aggiungi la prima fonte'), line('Ti serve il codice della fonte.'), form.el);
      if (pendingCode) {
        form.fill(pendingCode, pendingMore);
        pendingCode = '';
        pendingMore = [];
      }
      requestAnimationFrame(() => form.focus());
    },

    profileCode() {
      // The sources of the link the field holds (a QR code, or the link the app was opened with).
      let linkSources = [];
      let value = '';
      const opened = parseLink(pendingLink);
      pendingLink = '';
      if (opened?.profile) {
        value = opened.profile;
        linkSources = opened.sources;
      }
      fieldStep({
        heading: 'Ho già un profilo',
        sub: "Lo trovi sull'altro dispositivo, in Impostazioni.",
        label: 'Codice del profilo',
        placeholder: 'MPFY-P-...',
        okLabel: 'Continua',
        value,
        check: (v) => (codeKind(v) === 'source' ? 'Questo è il codice di una fonte' : null),
        scan: (text) => {
          const link = parseLink(text);
          linkSources = link?.profile ? link.sources : [];
          return link ? link.profile || link.sources[0] : text;
        },
        onEdit: () => {
          linkSources = [];
        },
        onSubmit: async (v) => {
          // A whole link pasted by hand (the other device's "Copia") brings its sources too.
          const pasted = parseLink(v.trim());
          if (pasted && pasted.profile) {
            linkSources = pasted.sources;
            v = pasted.profile;
          }
          try {
            await profile.importCode(v.trim());
          } catch (err) {
            return localWords(err);
          }
          await identityChanged();
          const more = linkSources;
          linkSources = [];
          // No source yet: the first one. Sources already here (an install from before
          // profiles): the gate opens, and the name follows when none of them knows it.
          if (!sources.list.length && !sources.phone) {
            if (step !== 'first') go('first', { replace: true });
          } else if (!more.length) askNameIfMissing();
          // The sources of the link: added at once, by the first source step or "Aggiungi fonte".
          if (more.length) addLinkedSources(more, { askName: askNameIfMissing });
          return null;
        },
      });
    },

    recover() {
      const opt = (ic, label, fn) => {
        const b = h('button', { type: 'button', class: 'welcome-option' }, h('span', { class: 'welcome-option-icon' }, icon(ic, 24)), h('span', { class: 'welcome-option-label' }, label), icon('chevronRight', 20));
        b.addEventListener('click', fn);
        return b;
      };
      const error = errLine();
      const fileInput = h('input', { type: 'file', accept: '.mpfy', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
      const importText = async (text, requestId = null) => {
        error.textContent = '';
        let identity;
        try {
          identity = JSON.parse(text);
        } catch {
          error.textContent = 'File non valido';
          return;
        }
        try {
          await profile.importIdentity(identity);
        } catch (err) {
          error.textContent = localWords(err);
          return;
        }
        if (requestId) nativeCall('adoptProfileFile', requestId);
        toast('Profilo recuperato');
        await identityChanged();
      };
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f) return;
        if (f.size > 256 * 1024) {
          error.textContent = 'File non valido';
          return;
        }
        importText(await f.text());
      });
      // One picker per tap: the second tap of a double tap opens no second one.
      const fromFile = () => {
        if (repeatTap('profile-file')) return;
        if (!native) {
          fileInput.click();
          return;
        }
        const rid = nativeCall('pickProfileFile');
        if (typeof rid !== 'string' || !rid) return;
        const off = onNative('profileFile', (m) => {
          if (m.requestId !== rid) return;
          off();
          if (m.state === 'ok' && typeof m.text === 'string') importText(m.text, rid);
          else if (m.state === 'error') error.textContent = 'File non valido';
        });
        offs.push(off);
      };
      put(
        card,
        title('Recupera profilo'),
        h(
          'div',
          { class: 'welcome-options' },
          opt('file', native ? 'Dal file del telefono' : 'Dal file del profilo', fromFile),
          opt('lock', 'Con la password', () => go('pwCode')),
          opt('key', 'Con il codice del profilo', () => go('profileCode'))
        ),
        error,
        fileInput
      );
    },

    pwCode() {
      const error = errLine();
      const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-wide welcome-btn' }, 'Continua');
      let busy = false;
      const field = codeField({
        onChange: (st) => {
          error.textContent = st.profileCode ? 'Questo è il codice del profilo' : '';
          submit.disabled = !st.complete || busy;
        },
        onEnter: () => (form.requestSubmit ? form.requestSubmit() : submit.click()),
      });
      // A source's QR code, or a profile's (its first source), is sent at once.
      const scan = scanButton((text) => {
        field.fill(sourcesOf(text).code);
        if (!field.state().complete) return;
        if (form.requestSubmit) form.requestSubmit();
        else submit.click();
      });
      const form = h('form', { class: 'as-form welcome-form', novalidate: true }, field.el, scan, error, submit);
      submit.disabled = true;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy || !field.state().complete) return;
        busy = true;
        submit.disabled = true;
        submit.textContent = 'Collegamento...';
        error.textContent = '';
        try {
          cancelRecovery();
          const r = await profile.recoveryStart(field.code());
          if (dead) return;
          const entries = Array.isArray(r?.entries) ? r.entries : [];
          if (!entries.length) {
            if (r?.sessionId) profile.recoveryCancel(r.sessionId);
            error.textContent = 'Nessun profilo da recuperare qui';
          } else {
            recovery = { sessionId: r.sessionId, source: r.source, entries, entry: null };
            go('pwWho');
          }
        } catch (err) {
          error.textContent = localWords(err);
        } finally {
          busy = false;
          submit.textContent = 'Continua';
          submit.disabled = !field.state().complete;
        }
      });
      put(card, title('Con la password'), line('Il codice di una tua fonte.'), form);
      requestAnimationFrame(() => field.focus());
    },

    pwWho() {
      const list = h('div', { class: 'welcome-options' });
      // When one person has blobs of several devices, the device says which one is which.
      const per = new Map();
      for (const e of recovery.entries) per.set(e.profileId, (per.get(e.profileId) || 0) + 1);
      for (const e of recovery.entries) {
        const b = h(
          'button',
          { type: 'button', class: 'welcome-option' },
          h('span', { class: 'welcome-option-icon' }, icon('profile', 24)),
          h('span', { class: 'welcome-option-text' }, h('span', { class: 'welcome-option-label' }, e.name || 'Senza nome'), per.get(e.profileId) > 1 && e.deviceName ? h('span', { class: 'welcome-option-sub' }, e.deviceName) : null),
          icon('chevronRight', 20)
        );
        b.addEventListener('click', () => {
          recovery.entry = e;
          go('pwPassword');
        });
        list.append(b);
      }
      put(card, title('Chi sei?'), list);
    },

    pwPassword() {
      fieldStep({
        heading: 'Password',
        type: 'password',
        placeholder: 'Password',
        okLabel: 'Recupera',
        busyLabel: 'Recupero...',
        onSubmit: async (v) => {
          try {
            await profile.recoveryTry(recovery.sessionId, recovery.entry, v);
          } catch (err) {
            if (err?.code === 'session_gone') {
              recovery = null;
              toast('Tempo scaduto');
              const at = trail.map((t) => t.step).lastIndexOf('pwCode');
              dropTrail(at < 0 ? trail.length : at);
              go('pwCode', { back: true });
              return null;
            }
            return localWords(err);
          }
          recovery = null;
          toast('Profilo recuperato');
          await identityChanged();
          return null;
        },
      });
    },
  };

  let pendingCode = '';
  let pendingMore = [];
  let pendingLink = '';
  // Steps with no field of their own: the focus goes to their title, so the new step is read out
  // and Tab starts from it (the button that led here is gone).
  const NO_FIELD = new Set(['welcome', 'recover', 'pwWho']);
  function render() {
    card.classList.remove('step-in');
    void card.offsetWidth; // restart the fade of a new step
    card.classList.add('step-in');
    top.replaceChildren(trail.length ? iconBtn('chevronLeft', 'Indietro', back, { cls: 'welcome-back', size: 26 }) : '');
    steps[step]();
    if (moved && NO_FIELD.has(step)) card.querySelector('.welcome-title')?.focus({ preventScroll: true });
  }

  go(kind === 'first' ? 'first' : kind === 'name' ? 'name' : 'welcome');
  return {
    el,
    tab: null,
    welcome: true,
    /**
     * #aggiungi=<code>: the first source step with the code in it (after the name when needed).
     * more: the other sources of a link, added with it.
     */
    fillCode(code, more = []) {
      pendingCode = code;
      pendingMore = more;
      if (step === 'first') steps.first();
      else if (profile.data) go('first');
      else if (step === 'welcome') go('name');
    },
    /** #aggiungi=<link of a profile>: "Ho già un profilo" with its code in it, its sources after it. */
    fillLink(link) {
      pendingLink = link;
      if (step === 'profileCode') render();
      else go('profileCode');
    },
    /** That code while it waits for its step (app.js keeps it across a reload). */
    waitingCode: () => pendingCode || pendingLink,
    /** The gate kind changed while this view was up (a profile appeared, a source came). */
    setKind(k) {
      if (k === kind) return;
      kind = k;
      if (k === 'first' && step !== 'first') {
        dropTrail(0);
        go('first', { replace: true });
      }
    },
    destroy() {
      dead = true;
      dropTrail(0); // the steps' history entries go with the view
      offs.forEach((f) => f());
      offs = [];
      cancelRecovery();
    },
  };
}
