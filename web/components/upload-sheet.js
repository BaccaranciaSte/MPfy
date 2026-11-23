// "Carica brani": "Carica su" (which source gets the files, default the principal), "Scegli i
// file" and "Carica cartella", a hint of what that source takes, one row per file with its
// progress and state (an archive's extraction and summary, the "maybe" choice inline), then an
// optional "Aggiungi a playlist" for the whole batch, and the offer of a picked image as the cover
// of albums without one. On desktop files and folders can also be dropped on the window.
//
// Progress comes up to once a frame: rows change in place, the footer and the offers are drawn
// again only when their buttons change (a mouse click needs the same button under its press and
// its release).

import { h, iconBtn, sep, markFresh, repeatTap } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { openPanel, openSheet } from './sheet.js';
import { uploads, ACCEPT, hintFor, stateText, barOf } from '../js/upload.js';
import { sources } from '../js/sources.js';
import { bridgeVersion, native } from '../js/native.js';
import { fmtSize } from '../js/util.js';
import { openAddToPlaylist } from './menus.js';
import { changeCover } from './cover-edit.js';

/** The song a "maybe" is about: the title of the track already there. */
const matchTitle = (job) => (job.archive ? job.archive.pending[0]?.match?.title : job.pending?.match?.title) || 'un altro brano';

/** The "Carica su" choice: a sheet with every source, the current one checked. */
function openTargetPicker() {
  const cur = uploads.target;
  openSheet({
    header: h('div', { class: 'sheet-title' }, 'Carica su'),
    label: 'Carica su',
    items: sources.ordered().map((s) => ({
      icon: s.id === cur ? 'check' : 'server',
      label: s.name,
      sub: s.principal ? 'Principale' : '',
      active: s.id === cur,
      onSelect: () => uploads.setTarget(s.id),
    })),
  });
}

let openNow = null;

export function openUploadSheet(files) {
  if (files?.length) uploads.add(files);
  if (openNow) return; // already open: the new files simply appear in the list

  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    uploads.add(input.files);
    input.value = '';
  });
  const dirInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'visually-hidden up-dir-input', tabindex: '-1', 'aria-hidden': 'true' });
  dirInput.addEventListener('change', () => {
    uploads.add(dirInput.files);
    dirInput.value = '';
  });
  // A picker per tap: the second tap of a double tap does not queue another picker behind the
  // first (the app's WebView opens it again once the first answers).
  const pick = h('button', { type: 'button', class: 'btn btn-primary up-pick' }, icon('upload', 22), 'Scegli i file');
  pick.addEventListener('click', () => {
    if (!repeatTap('pick-files')) input.click();
  });
  // A folder: the app's own picker, or the browser's; an older app without one has no button.
  const canFolder = native ? bridgeVersion() >= 3 : true;
  const folder = canFolder ? h('button', { type: 'button', class: 'btn btn-ghost up-pick' }, icon('folderUp', 22), 'Carica cartella') : null;
  folder?.addEventListener('click', () => {
    if (native) uploads.pickFolder();
    else if (!repeatTap('pick-folder')) dirInput.click();
  });

  const targetName = h('span', { class: 'up-target-name' });
  const targetState = h('span', { class: 'up-target-state' });
  const target = h(
    'button',
    { type: 'button', class: 'up-target', 'aria-haspopup': 'dialog' },
    icon('server', 22),
    h('span', { class: 'up-target-text' }, h('span', { class: 'up-target-label' }, 'Carica su'), targetName, targetState),
    icon('chevronRight', 20)
  );
  target.addEventListener('click', openTargetPicker);
  const hint = h('p', { class: 'up-hint' });

  const list = h('div', { class: 'up-list' });
  const offers = h('div', { class: 'up-offers' });
  const footer = h('div', { class: 'up-footer' });
  const rows = new Map();

  const { body, layer } = openPanel({
    title: 'Carica brani',
    cls: 'panel-upload',
    modal: false, // on desktop a side panel: the page stays usable while files upload
    onClose: () => {
      unsub();
      unsubSources();
      uploads.setSheetOpen(false);
      openNow = null;
    },
  });
  body.append(h('div', { class: 'up-intro' }, target, hint, h('div', { class: 'up-picks' }, pick, folder), input, dirInput), list, offers, footer);
  openNow = layer;
  uploads.setSheetOpen(true);

  function paintTarget() {
    const id = uploads.target;
    const s = id ? sources.get(id) : null;
    targetName.textContent = s ? s.name : 'Nessuna fonte';
    // The name only: the state of a source lives in Impostazioni.
    targetState.textContent = s?.principal ? 'Principale' : '';
    target.setAttribute('aria-label', `Carica su ${s ? s.name : 'nessuna fonte'}, cambia`);
    hint.textContent = hintFor(id);
  }

  function rowFor(job) {
    let r = rows.get(job.id);
    if (r) return r;
    const name = h('div', { class: 'up-name' }, job.relPath || job.name);
    const size = h('span', {}, fmtSize(job.size));
    const dest = h('span', { class: 'up-dest' }, sources.name(job.target));
    const state = h('span', { class: 'up-state' });
    const stateSep = sep();
    const meta = h('div', { class: 'up-meta' }, size, sep(), dest, stateSep, state);
    const bar = h('div', { class: 'up-bar' }, h('i'));
    const choice = h('div', { class: 'up-choice' });
    const cancel = iconBtn('close', `Annulla ${job.name}`, () => uploads.cancel(job), { cls: 'up-cancel', size: 20 });
    const retry = iconBtn('retry', `Riprova ${job.name}`, () => uploads.retry(job), { cls: 'up-cancel', size: 20 });
    const archive = /\.(zip|7z|rar)$/i.test(job.name);
    const el = h('div', { class: 'up-row' }, h('div', { class: 'up-icon' }, icon(archive ? 'archive' : 'note', 22)), h('div', { class: 'up-text' }, name, bar, meta, choice), cancel, retry);
    r = { el, state, stateSep, bar, cancel, retry, choice, choiceKey: '', asked: '' };
    rows.set(job.id, r);
    return r;
  }

  /** The inline "maybe": which one to keep. Drawn again only when the question changes. */
  function paintChoice(job, r) {
    const asking = job.state === 'maybe' || job.state === 'choosing';
    const key = asking ? `${job.state}|${job.archive ? job.archive.pending[0]?.id : job.pending?.id}` : '';
    if (key === r.choiceKey) return;
    r.choiceKey = key;
    r.el.classList.toggle('asking', asking);
    if (!asking) {
      r.choice.replaceChildren();
      return;
    }
    const asked = String((job.archive ? job.archive.pending[0]?.id : job.pending?.id) || '');
    const next = !!r.asked && asked !== r.asked;
    r.asked = asked;
    const best = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Tieni la versione migliore');
    const both = h('button', { type: 'button', class: 'btn btn-light btn-small' }, 'Tienili entrambi');
    best.disabled = both.disabled = job.state === 'choosing';
    best.addEventListener('click', () => uploads.choose(job, 'best'));
    both.addEventListener('click', () => uploads.choose(job, 'both'));
    r.choice.replaceChildren(h('p', { class: 'up-choice-title' }, `Sembra lo stesso brano di ${matchTitle(job)}`), h('div', { class: 'up-choice-actions' }, best, both));
    // The question that takes the place of one just answered (an archive's next "maybe", with a
    // source that answers quickly): the rest of the tap gesture that answered the one before does
    // not answer it unread (markFresh, dom.js).
    if (next) markFresh(r.choice);
  }

  let offersKey = null;
  function renderOffers() {
    const offered = uploads.coverOffers();
    const k = JSON.stringify(offered.map((o) => [o.albumId, o.name, o.image.name, o.image.url]));
    if (k === offersKey) return;
    offersKey = k;
    offers.replaceChildren();
    for (const o of offered) {
      const use = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Usa come copertina');
      const no = h('button', { type: 'button', class: 'link-btn' }, 'No, grazie');
      use.addEventListener('click', async () => {
        use.disabled = true;
        no.disabled = true;
        if (await changeCover('album', o.albumId, o.image.file)) uploads.dismissOffer(o.albumId);
        else {
          use.disabled = false;
          no.disabled = false;
        }
      });
      no.addEventListener('click', () => uploads.dismissOffer(o.albumId));
      offers.append(
        h(
          'div',
          { class: 'up-offer' },
          h('img', { class: 'up-offer-img', src: o.image.url, alt: '', width: '64', height: '64' }),
          h(
            'div',
            { class: 'up-offer-text' },
            h('p', { class: 'up-offer-title' }, `Usare ${o.image.name} come copertina?`),
            h('p', { class: 'up-offer-sub' }, `Per "${o.name}", che non ne ha una.`),
            h('div', { class: 'up-offer-actions' }, use, no)
          )
        )
      );
    }
  }

  let footerKey = null;
  function renderFooter(jobs) {
    const open = jobs.some((j) => ['waiting', 'uploading', 'paused', 'processing', 'extracting', 'choosing', 'maybe'].includes(j.state));
    const showAdd = !open && uploads.trackIds.length > 0;
    const showClear = jobs.some((j) => !['waiting', 'uploading', 'paused', 'processing', 'extracting', 'choosing', 'maybe'].includes(j.state)) || uploads.images.length > 0;
    const k = `${showAdd}|${showClear}`;
    if (k === footerKey) return;
    footerKey = k;
    footer.replaceChildren();
    if (showAdd) {
      const add = h('button', { type: 'button', class: 'btn btn-light' }, icon('plusCircle', 20), 'Aggiungi a playlist');
      add.addEventListener('click', () => openAddToPlaylist([...new Set(uploads.trackIds)]));
      footer.append(add);
    }
    if (showClear) {
      const clear = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Svuota elenco');
      clear.addEventListener('click', () => uploads.clearFinished());
      footer.append(clear);
    }
  }

  function render(jobs) {
    paintTarget();
    const seen = new Set();
    for (const job of jobs) {
      seen.add(job.id);
      const r = rowFor(job);
      if (r.el.parentElement !== list) list.append(r.el);
      const words = stateText(job);
      r.state.textContent = words;
      r.stateSep.hidden = !words;
      r.el.dataset.state = job.state;
      r.bar.firstElementChild.style.transform = `scaleX(${barOf(job)})`;
      r.cancel.hidden = !(job.state === 'waiting' || job.state === 'uploading' || job.state === 'paused');
      r.retry.hidden = !uploads.canRetry(job);
      paintChoice(job, r);
    }
    for (const [id, r] of rows) {
      if (!seen.has(id)) {
        r.el.remove();
        rows.delete(id);
      }
    }
    renderOffers();
    renderFooter(jobs);
    if (!jobs.length) {
      const imgs = uploads.images.length;
      list.replaceChildren(h('p', { class: 'empty-small' }, imgs ? 'Nessun brano scelto' : 'Nessun file scelto'));
    } else list.querySelector('.empty-small')?.remove();
  }

  const unsub = uploads.subscribe(render);
  const unsubSources = sources.subscribe(paintTarget);
  render(uploads.jobs);
  sources.loadHealth().then(paintTarget);
}
