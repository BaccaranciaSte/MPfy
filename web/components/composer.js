// The composer of the chats and of the comments: our smiley ("Emoji"), the field (1 to 5 lines,
// "Messaggio") and send ("Invia": a grey disc while there is nothing to send, the silver button
// otherwise). Text beyond 2000 characters (300 for a comment) is cut as it comes in, with no
// counter. Enter sends where there is no touch (Shift+Enter a new line); on a touch screen Enter is
// a new line. In a sheet (the comments) it sits at the foot of the sheet instead of the screen's.
//
// Sending empties the field at once, so a double tap on "Invia" or a burst of Enter sends one
// message: the later presses find nothing to send. A reply shows above the field (the quoted
// message and "Annulla risposta") until the message leaves.
//
// The emoji panel (emoji-picker.js) takes the keyboard's place on a phone: opening it lets the
// keyboard go, a tap in the field brings the keyboard back and closes it.

import { h, iconBtn, repeatTap } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { cleanText, cutPoints, TEXT_MAX } from '../js/chat-data.js';
import { charCount } from '../js/util.js';
import { openEmojiPicker } from './emoji-picker.js';

const LINE_PX = 20;
const MAX_LINES = 5;
const touchScreen = () => typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;

/**
 * onSend(text, reply): reply is what setReply was given (null without one). quoteOf(reply) draws
 * the quote of the reply bar. max: the code points it takes; clean: what is left of a text once
 * cleaned (nothing: send stays grey); cls: 'in-sheet' in a sheet. Returns { el, input,
 * setReply(m|null), setText(text), closeEmoji(), destroy() }.
 */
export function composer({ onSend, quoteOf = null, placeholder = 'Messaggio', max = TEXT_MAX, clean = cleanText, cls = '' }) {
  const input = h('textarea', { class: 'composer-input', rows: '1', placeholder, 'aria-label': placeholder, enterkeyhint: 'send', autocomplete: 'off', spellcheck: 'true' });
  const send = h('button', { type: 'button', class: 'play-ctx composer-send', 'aria-label': 'Invia', title: 'Invia', disabled: true }, icon('send', 22));
  const emojiBtn = iconBtn('smiley', 'Emoji', null, { cls: 'composer-emoji' });
  const field = h('label', { class: 'composer-field' }, input);
  const row = h('div', { class: 'composer' }, emojiBtn, field, send);
  const replyBar = h('div', { class: 'reply-bar', hidden: true });
  const panelHost = h('div', { class: 'emoji-host' });
  const el = h('div', { class: `composer-dock${cls ? ` ${cls}` : ''}` }, replyBar, row, panelHost);
  let reply = null;
  let picker = null;

  // The field grows with its lines (20 px each, 2 px above and below), up to 5, then scrolls.
  function fit() {
    input.style.height = 'auto';
    const lines = Math.min(MAX_LINES, Math.max(1, Math.round((input.scrollHeight - 4) / LINE_PX)));
    const px = lines * LINE_PX + 4;
    input.style.height = `${px}px`;
    input.style.overflowY = input.scrollHeight > px + 1 ? 'auto' : 'hidden';
  }
  function paint() {
    send.disabled = !clean(input.value);
  }
  function cut() {
    if (charCount(input.value) <= max) return;
    input.value = cutPoints(input.value, max);
    input.setSelectionRange(input.value.length, input.value.length);
  }
  input.addEventListener('input', () => {
    cut();
    fit();
    paint();
  });

  function setReply(m) {
    reply = m || null;
    replyBar.hidden = !reply;
    if (!reply) {
      replyBar.replaceChildren();
      return;
    }
    const close = iconBtn('close', 'Annulla risposta', () => setReply(null), { cls: 'reply-close', size: 20 });
    replyBar.replaceChildren(quoteOf ? quoteOf(reply) : h('span'), close);
    input.focus({ preventScroll: true });
  }

  function doSend() {
    const text = input.value;
    if (!clean(text)) return;
    const r = reply;
    input.value = '';
    fit();
    paint();
    setReply(null);
    onSend(text, r);
  }
  send.addEventListener('click', () => doSend());
  // The send button never takes the focus: the phone keyboard stays up between messages.
  send.addEventListener('mousedown', (e) => e.preventDefault());
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || touchScreen()) return;
    e.preventDefault();
    doSend();
  });

  function insert(e) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (charCount(input.value) - charCount(input.value.slice(start, end)) + charCount(e) > max) return;
    input.setRangeText(e, start, end, 'end');
    fit();
    paint();
  }
  function closeEmoji() {
    if (picker) picker.close();
  }
  function toggleEmoji() {
    if (repeatTap('composer-emoji')) return;
    if (picker && !picker.closed) {
      picker.close();
      input.focus({ preventScroll: true });
      return;
    }
    // On a phone the panel takes the keyboard's place.
    if (!matchMedia('(min-width: 900px)').matches) input.blur();
    picker = openEmojiPicker({
      host: panelHost,
      button: emojiBtn,
      // On a phone a tap in the field brings the keyboard (the focus closes the panel then).
      keep: matchMedia('(min-width: 900px)').matches ? [send] : [send, field],
      onPick: insert,
      onClose: () => {
        el.classList.remove('emoji-on');
        picker = null;
      },
    });
    el.classList.add('emoji-on');
  }
  emojiBtn.addEventListener('click', toggleEmoji);
  emojiBtn.addEventListener('mousedown', (e) => e.preventDefault());
  // The keyboard comes back with a tap in the field: the panel gives it its place.
  input.addEventListener('focus', () => {
    if (picker && !matchMedia('(min-width: 900px)').matches) picker.close();
  });

  /** Puts a text in the field (yours to edit, or one that did not leave), the caret at its end. */
  function setText(text) {
    input.value = cutPoints(String(text || ''), max);
    fit();
    paint();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  fit();
  return {
    el,
    input,
    setReply,
    setText,
    closeEmoji,
    get reply() {
      return reply;
    },
    destroy() {
      closeEmoji();
    },
  };
}
