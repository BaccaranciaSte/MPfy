// Connection banner: "Nessuna fonte raggiungibile" while no source can be reached (or the
// local core itself does not answer), "Sei offline" without any network. With some sources up
// there is no banner: only the tracks that no connected source has are dimmed.

import { h } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { onConn, connState } from '../js/conn.js';

export function mountBanner(root) {
  const text = h('span');
  root.replaceChildren(icon('wifiOff', 18), text);
  const apply = () => {
    const s = connState();
    root.hidden = s === 'ok';
    document.body.classList.toggle('offline', s !== 'ok');
    // One source offline shows nothing here: only none at all, or no network.
    text.textContent = s === 'offline' ? 'Sei offline' : 'Nessuna fonte raggiungibile';
  };
  onConn(apply);
  apply();
}
