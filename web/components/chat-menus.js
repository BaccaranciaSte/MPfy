// The small flows around the chats: silencing a conversation, blocking and unblocking a person.
//
//   "Silenzia": "8 ore", "1 settimana", "Sempre"; on a silenced one "Riattiva notifiche" alone.
//   "Blocca <nome>": asks "Bloccare <nome>?" ("Non ti potrà scrivere né vedere cosa ascolti.",
//   "Annulla", "Blocca"), then back to Amici. "Sblocca <nome>" asks nothing.

import { openSheet, confirmDialog } from './sheet.js';
import { social } from '../js/social.js';
import { navigate } from '../js/router.js';
import { h, oneAtATime } from '../js/dom.js';

/** The silence sheet of a conversation (any of its ids). */
export function openMuteSheet(cid) {
  const c = social.conversation(cid);
  if (c && c.muted) {
    openSheet({ label: 'Riattiva notifiche', items: [{ icon: 'bell', label: 'Riattiva notifiche', onSelect: () => social.mute(cid, 'off') }] });
    return;
  }
  openSheet({
    label: 'Silenzia',
    header: h('div', { class: 'sheet-title' }, 'Silenzia'),
    items: [
      { icon: 'history', label: '8 ore', onSelect: () => social.mute(cid, '8h') },
      { icon: 'history', label: '1 settimana', onSelect: () => social.mute(cid, '1w') },
      { icon: 'bellOff', label: 'Sempre', onSelect: () => social.mute(cid, 'always') },
    ],
  });
}

/** The items "Silenzia" or "Riattiva notifiche" of a conversation's menu. */
export function muteItem(cid) {
  const c = social.conversation(cid);
  return c && c.muted
    ? { icon: 'bell', label: 'Riattiva notifiche', onSelect: () => social.mute(cid, 'off') }
    : { icon: 'bellOff', label: 'Silenzia', onSelect: () => openMuteSheet(cid) };
}

/**
 * "Blocca <nome>": one question at a time; after a yes the person is blocked and the page goes back
 * to Amici (after: what to do instead, the PC's column going back to its list).
 */
export const blockFlow = oneAtATime(async (person, { after = null } = {}) => {
  const ok = await confirmDialog({ title: `Bloccare ${person.name}?`, message: 'Non ti potrà scrivere né vedere cosa ascolti.', okLabel: 'Blocca', danger: true });
  if (!ok) return false;
  const done = await social.block(person.id);
  if (!done) return false;
  if (after) after();
  else navigate('/amici');
  return true;
});

/** The menu of a person's page: "Blocca <nome>" or "Sblocca <nome>". */
export function personMenuItems(person) {
  return person.blocked
    ? [{ icon: 'block', label: `Sblocca ${person.name}`, onSelect: () => social.unblock(person.id) }]
    : [{ icon: 'block', label: `Blocca ${person.name}`, danger: true, onSelect: () => blockFlow(person) }];
}
