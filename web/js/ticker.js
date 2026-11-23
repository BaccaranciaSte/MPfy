// Drives progress bars and time labels. While playing and visible it ticks 4 times a second
// (enough: one pixel of a progress bar is about half a second of a song), interpolating between
// the backend's position reports; otherwise it only runs when the player reports something.

import { player } from './player.js';

const fns = new Set();
let timer = 0;

function run() {
  const pos = player.positionNow();
  const dur = player.durationNow();
  for (const fn of fns) fn(pos, dur);
}

function schedule() {
  const active = player.state.playing && !document.hidden && fns.size > 0;
  if (active && !timer) timer = setInterval(run, 250);
  else if (!active && timer) {
    clearInterval(timer);
    timer = 0;
  }
}

export function addTicker(fn) {
  fns.add(fn);
  fn(player.positionNow(), player.durationNow());
  schedule();
  return () => {
    fns.delete(fn);
    schedule();
  };
}

player.onChange(() => {
  run();
  schedule();
});
player.onTime(() => {
  if (!timer) run();
});
document.addEventListener('visibilitychange', () => {
  schedule();
  if (!document.hidden) run();
});
