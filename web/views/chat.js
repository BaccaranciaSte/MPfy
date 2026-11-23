// A conversation (/chat/<cid>): the whole screen, as the app's panels are. While it shows,
// body.in-chat gives the bottom stack's place (mini player and nav) to the composer; leaving the
// route takes the class away. Everything else is the chat panel (components/chat-panel.js).

import { chatPanel } from '../components/chat-panel.js';

export function chatView(cid) {
  const panel = chatPanel(cid);
  return {
    el: panel.el,
    tab: 'home',
    mounted() {
      document.body.classList.add('in-chat');
      panel.mounted();
    },
    destroy() {
      document.body.classList.remove('in-chat');
      panel.destroy();
    },
  };
}
