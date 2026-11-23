// MPfy icon set: every icon is drawn here as inline SVG (no fonts, no emoji, no external files).
// Icons live on a 24x24 grid and paint with currentColor, so CSS decides their color.

const s = (w = 2) =>
  `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const f = 'fill="currentColor"';
// A dark mark drawn on top of a filled accent circle (downloaded, check, minus).
const ink = (w = 2.2) =>
  `fill="none" stroke="#141414" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

const HEART = 'M12 20.3s-7.4-4.5-9.2-9C1.6 8.1 3.6 4.6 7 4.6c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.4 0 5.4 3.5 4.2 6.7-1.8 4.5-9.2 9-9.2 9z';
const BELL = 'M6.2 16.6V11a5.8 5.8 0 0 1 11.6 0v5.6l1.6 1.9H4.6z';
const REPEAT = 'M17 3.5 20 6.5l-3 3M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20M7 20.5l-3-3 3-3M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4';

const PATHS = {
  home: `<path ${s()} d="M4 10.2 12 3.8l8 6.4V20h-5.2v-5.6H9.2V20H4z"/>`,
  homeFill: `<path ${f} d="M12 2.6 3 9.8V21h7v-6.2h4V21h7V9.8z"/>`,
  search: `<circle ${s()} cx="10.5" cy="10.5" r="6.5"/><path ${s()} d="m15.6 15.6 4.9 4.9"/>`,
  searchBold: `<circle ${s(3)} cx="10.5" cy="10.5" r="6.2"/><path ${s(3)} d="m15.5 15.5 4.8 4.8"/>`,
  library: `<path ${s()} d="M5 3.5v17M10 3.5v17M14.2 4.2l5.3 15.8"/>`,
  libraryBold: `<path ${s(3)} d="M5 3.5v17M10 3.5v17M14.2 4.2l5.3 15.8"/>`,
  plus: `<path ${s()} d="M12 5v14M5 12h14"/>`,
  qr: `<path ${s(1.8)} d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path ${f} d="M6.2 6.2h1.6v1.6H6.2zM16.2 6.2h1.6v1.6h-1.6zM6.2 16.2h1.6v1.6H6.2zM14 14h2.6v2.6H14zM17.4 17.4H20V20h-2.6zM14 18h2v2h-2zM18 14h2v2h-2z"/>`,
  upload: `<path ${s()} d="M7 18H6.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.6 8.1 4.5 4.5 0 0 1 17.5 18H17"/><path ${s()} d="M12 12.5V21M8.8 15.6 12 12.4l3.2 3.2"/>`,
  heart: `<path ${s()} d="${HEART}"/>`,
  heartFill: `<path ${f} stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="${HEART}"/>`,
  play: `<path ${f} d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z"/>`,
  pause: `<rect ${f} x="6" y="4.5" width="4" height="15" rx="1"/><rect ${f} x="14" y="4.5" width="4" height="15" rx="1"/>`,
  next: `<path ${f} d="M5 5.2v13.6a.7.7 0 0 0 1.1.6l9.4-6.8a.7.7 0 0 0 0-1.2L6.1 4.6A.7.7 0 0 0 5 5.2z"/><rect ${f} x="17" y="4.5" width="2.5" height="15" rx="1"/>`,
  previous: `<path ${f} d="M19 5.2v13.6a.7.7 0 0 1-1.1.6l-9.4-6.8a.7.7 0 0 1 0-1.2l9.4-6.8a.7.7 0 0 1 1.1.6z"/><rect ${f} x="4.5" y="4.5" width="2.5" height="15" rx="1"/>`,
  shuffle: `<path ${s()} d="M3 7h3.2c2 0 3.3 1 4.3 2.7l3 5.1c1 1.7 2.3 2.7 4.3 2.7H21M3 17.5h3.2c1.5 0 2.6-.6 3.5-1.6M14 8.6c.9-1 2-1.6 3.5-1.6H21M18.2 4.2 21 7l-2.8 2.8M18.2 14.7l2.8 2.8-2.8 2.8"/>`,
  repeat: `<path ${s()} d="${REPEAT}"/>`,
  repeatOne: `<path ${s()} d="${REPEAT}"/><path ${s(1.8)} d="M10.8 10.6 12.4 9.6v5.2"/>`,
  queue: `<path ${s()} d="M4 6h16M4 12h9M4 18h9"/><path ${f} d="M16 13.2v8.6l6-4.3z"/>`,
  more: `<circle ${f} cx="5" cy="12" r="1.9"/><circle ${f} cx="12" cy="12" r="1.9"/><circle ${f} cx="19" cy="12" r="1.9"/>`,
  moreV: `<circle ${f} cx="12" cy="5" r="1.9"/><circle ${f} cx="12" cy="12" r="1.9"/><circle ${f} cx="12" cy="19" r="1.9"/>`,
  chevronDown: `<path ${s(2.2)} d="m5.5 9 6.5 6.5L18.5 9"/>`,
  chevronLeft: `<path ${s(2.2)} d="M15 5.5 8.5 12l6.5 6.5"/>`,
  chevronRight: `<path ${s(2.2)} d="M9 5.5 15.5 12 9 18.5"/>`,
  download: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><path ${s(1.8)} d="M12 7.2v8.6M8.4 12.6 12 16.2l3.6-3.6"/>`,
  downloaded: `<circle ${f} cx="12" cy="12" r="10"/><path ${ink()} d="M12 6.8v9.4M8.2 12.6 12 16.4l3.8-3.8"/>`,
  check: `<path ${s(2.4)} d="m5 12.5 4.5 4.5L19 7.5"/>`,
  checkCircle: `<circle ${f} cx="12" cy="12" r="10"/><path ${ink(2.4)} d="m7.5 12.2 3 3 6-6.2"/>`,
  close: `<path ${s()} d="M6 6l12 12M18 6 6 18"/>`,
  trash: `<path ${s(1.8)} d="M4 6.5h16M9.5 6.5V4h5v2.5M6.3 6.5l1 13.5h9.4l1-13.5M10 10.5v6M14 10.5v6"/>`,
  edit: `<path ${s(1.8)} d="M4 20h4.2L19.3 8.9a2.6 2.6 0 0 0-3.7-3.7L4.5 16.3z"/><path ${s(1.8)} d="m14.2 6.6 3.7 3.7"/>`,
  drag: `<path ${s()} d="M4 8h16M4 12h16M4 16h16"/>`,
  note: `<path ${s()} d="M9 17.5V5.5l10-2v12"/><circle ${f} cx="6.5" cy="17.5" r="2.8"/><circle ${f} cx="16.5" cy="15.5" r="2.8"/>`,
  eq: `<rect ${f} x="4" y="9" width="3.4" height="11" rx="1"/><rect ${f} x="10.3" y="4" width="3.4" height="16" rx="1"/><rect ${f} x="16.6" y="12" width="3.4" height="8" rx="1"/>`,
  wifiOff: `<path ${s()} d="M2.5 8.6a15 15 0 0 1 4-2.5M10 5.1a15 15 0 0 1 11.5 3.5M5.5 12.2a10.5 10.5 0 0 1 3.6-2.1M14 10.2a10.5 10.5 0 0 1 4.5 2M8.7 15.6a5.2 5.2 0 0 1 5.6-.9"/><circle ${f} cx="12" cy="19.2" r="1.4"/><path ${s()} d="M3.5 3.5l17 17"/>`,
  plusCircle: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><path ${s(1.8)} d="M12 7.8v8.4M7.8 12h8.4"/>`,
  minusCircle: `<circle ${f} cx="12" cy="12" r="10"/><path ${ink(2.4)} d="M7.5 12h9"/>`,
  album: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><circle ${s(1.8)} cx="12" cy="12" r="2.6"/>`,
  artist: `<circle ${s(1.8)} cx="12" cy="8" r="4"/><path ${s(1.8)} d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>`,
  queueAdd: `<path ${s()} d="M4 6h13M4 11h13M4 16h7M17.5 14v7M14 17.5h7"/>`,
  addPlaylist: `<path ${s()} d="M8 17V6l8-1.6"/><circle ${f} cx="5.8" cy="17" r="2.4"/><path ${s()} d="M18 13v7M14.5 16.5h7"/>`,
  sort: `<path ${s()} d="M4 7h10M4 12h7M4 17h4M17.5 5v14M14.5 16l3 3 3-3"/>`,
  pin: `<path ${f} d="M9.2 3h5.6l-.9 5.4 3.1 3.1V13H7v-1.5l3.1-3.1z"/><path ${s(1.8)} d="M12 13v7.5"/>`,
  volume: `<path ${f} d="M4 9.2h3.6L12 5.4v13.2l-4.4-3.8H4z"/><path ${s(1.8)} d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
  volumeOff: `<path ${f} d="M4 9.2h3.6L12 5.4v13.2l-4.4-3.8H4z"/><path ${s(1.8)} d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>`,
  expand: `<path ${s()} d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>`,
  settings: `<circle ${s(2.2)} cx="12" cy="12" r="6.4"/><circle ${s(2)} cx="12" cy="12" r="2.5"/><path fill="none" stroke="currentColor" stroke-width="3.4" d="M19.4 12h2.5M17.2 17.2 19 19M12 19.4v2.5M6.8 17.2 5 19M4.6 12H2.1M6.8 6.8 5 5M12 4.6V2.1M17.2 6.8 19 5"/>`,
  copy: `<rect ${s(1.8)} x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path ${s(1.8)} d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>`,
  phone: `<rect ${s(1.8)} x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path ${s(1.8)} d="M10.5 18.3h3"/>`,
  sdcard: `<path ${s(1.8)} d="M8.6 2.8h8.2a2 2 0 0 1 2 2v14.4a2 2 0 0 1-2 2H7.2a2 2 0 0 1-2-2V7.2z"/><path ${s(1.8)} d="M10 6.2v3M12.8 6.2v3M15.6 6.2v3"/>`,
  server: `<rect ${s(1.8)} x="3.5" y="4" width="17" height="6.6" rx="1.6"/><rect ${s(1.8)} x="3.5" y="13.4" width="17" height="6.6" rx="1.6"/><circle ${f} cx="7.3" cy="7.3" r="1.15"/><circle ${f} cx="7.3" cy="16.7" r="1.15"/><path ${s(1.8)} d="M11 7.3h5.5M11 16.7h5.5"/>`,
  image: `<rect ${s(1.8)} x="3.5" y="4.5" width="17" height="15" rx="2"/><circle ${s(1.8)} cx="9" cy="10" r="1.8"/><path ${s(1.8)} d="m4 17.6 4.9-4.7 3.6 3.4 2.9-2.7 4.6 4.3"/>`,
  reset: `<path ${s(1.8)} d="M4.8 9.4h9.4a5.6 5.6 0 0 1 0 11.2H8.5"/><path ${s(1.8)} d="M8.4 5.6 4.6 9.4l3.8 3.8"/>`,
  key: `<circle ${s(1.8)} cx="8" cy="15.5" r="4.3"/><path ${s(1.8)} d="m11.1 12.4 8.4-8.4M16.4 7.1l2.6 2.6M14.1 9.4l2 2"/>`,
  rotate: `<path ${s(1.8)} d="M19.6 10.6A7.8 7.8 0 0 0 6 7.2L4.2 9M4 4.6v4.6h4.6M4.4 13.4A7.8 7.8 0 0 0 18 16.8l1.8-1.8M20 19.4v-4.6h-4.6"/>`,
  retry: `<path ${s(1.8)} d="M19.6 12A7.6 7.6 0 1 1 17.37 6.63"/><path ${s(1.8)} d="M17.37 2.6v4.03h-4.03"/>`,
  info: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><path ${s(2)} d="M12 10.8v5.8"/><circle ${f} cx="12" cy="7.7" r="1.25"/>`,
  star: `<path ${f} d="m12 3.4 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.8l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>`,
  quality: `<path ${s()} d="M4 7h9M17.5 7H20M4 17h3.5M11.5 17H20"/><circle ${s()} cx="15.3" cy="7" r="2.2"/><circle ${s()} cx="9.5" cy="17" r="2.2"/>`,
  sourcesIcon: `<path ${s(1.8)} d="M12 3.5c4.4 0 8 1.4 8 3.2v10.6c0 1.8-3.6 3.2-8 3.2s-8-1.4-8-3.2V6.7c0-1.8 3.6-3.2 8-3.2z"/><path ${s(1.8)} d="M4 6.7c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>`,
  folder: `<path ${s(1.8)} d="M3.5 7.2V17.8a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7V9.4a1.7 1.7 0 0 0-1.7-1.7h-6.6L10.3 5.5H5.2a1.7 1.7 0 0 0-1.7 1.7z"/>`,
  folderUp: `<path ${s(1.8)} d="M3.5 7.2V17.8a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7V9.4a1.7 1.7 0 0 0-1.7-1.7h-6.6L10.3 5.5H5.2a1.7 1.7 0 0 0-1.7 1.7z"/><path ${s(1.8)} d="M12 16.6v-5.4M9.6 13.4 12 11l2.4 2.4"/>`,
  archive: `<rect ${s(1.8)} x="3.5" y="4" width="17" height="4.4" rx="1.2"/><path ${s(1.8)} d="M5 8.4v10.1a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.4M10 12h4"/>`,
  lock: `<rect ${s(1.8)} x="5" y="10.5" width="14" height="10" rx="2"/><path ${s(1.8)} d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/><circle ${f} cx="12" cy="15.5" r="1.4"/>`,
  link: `<path ${s(1.8)} d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path ${s(1.8)} d="M13.8 10.2a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>`,
  file: `<path ${s(1.8)} d="M6.5 3.5h7.3l4.7 4.7v11a1.3 1.3 0 0 1-1.3 1.3H6.5a1.3 1.3 0 0 1-1.3-1.3V4.8a1.3 1.3 0 0 1 1.3-1.3z"/><path ${s(1.8)} d="M13.5 3.8v4.7h4.7"/>`,
  cache: `<path ${s(1.8)} d="M4.5 7.5h15M9.8 4h4.4M6.4 7.5l.9 11.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3l.9-11.2"/><path ${s(1.8)} d="M10 11.5l1.2 4.5M14 11.5l-1.2 4.5"/>`,
  profile: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><circle ${s(1.8)} cx="12" cy="10" r="3.2"/><path ${s(1.8)} d="M6.4 18.6a6.6 6.6 0 0 1 11.2 0"/>`,
  devices: `<rect ${s(1.8)} x="2.4" y="5.5" width="10.3" height="8" rx="1.4"/><path ${s(1.8)} d="M5 17h5.1"/><rect ${s(1.8)} x="16.1" y="8.5" width="5.6" height="11" rx="1.3"/>`,
  // The people part: a playlist (the lines of queueAdd and the note of addPlaylist), your own
  // listening history (the retry arrow turned back, with clock hands), a source's mark (a
  // loudspeaker), a chat bubble (heavier for the 56 px button of a person's page), send (an arrow
  // going up, never a triangle like play), the emoji button, message notifications (a bell, and
  // the same bell crossed), "Invisibile" (an eye, crossed, the eye cut around the line) and
  // blocked people (the ring, crossed).
  playlist: `<path ${s()} d="M3.5 6h8M3.5 11h8M3.5 16h5"/><path ${s()} d="M16 17V6l5.5-1.1"/><circle ${f} cx="13.8" cy="17" r="2.4"/>`,
  history: `<path ${s(1.8)} d="M4.4 12A7.6 7.6 0 1 0 6.63 6.63"/><path ${s(1.8)} d="M6.63 2.6v4.03h4.03"/><path ${s(1.8)} d="M12 8.2v4.2l2.8 1.8"/>`,
  speaker: `<rect ${s(1.8)} x="5.5" y="2.8" width="13" height="18.4" rx="2.4"/><circle ${f} cx="12" cy="7.3" r="1.45"/><circle ${s(1.8)} cx="12" cy="14.6" r="3.5"/>`,
  chat: `<path ${s(1.8)} d="M12 3.6a8 8 0 1 1-3.7 15.1L4 19.8l1.2-4A8 8 0 0 1 12 3.6z"/>`,
  chatBold: `<path ${s(2.2)} d="M12 3.6a8 8 0 1 1-3.7 15.1L4 19.8l1.2-4A8 8 0 0 1 12 3.6z"/>`,
  send: `<path ${s(2.2)} d="M12 19.2V5.4M6 11.4l6-6 6 6"/>`,
  smiley: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><circle ${f} cx="9" cy="10" r="1.3"/><circle ${f} cx="15" cy="10" r="1.3"/><path ${s(1.8)} d="M8.2 14.1a4.6 4.6 0 0 0 7.6 0"/>`,
  bell: `<path ${s(1.8)} d="${BELL}"/><path ${s(1.8)} d="M12 3v2.2M10 21.2h4"/>`,
  bellOff: `<mask id="m-bo"><rect width="24" height="24" fill="#fff"/><path d="M3.6 3.6l16.8 16.8" stroke="#000" stroke-width="5" stroke-linecap="round"/></mask><g mask="url(#m-bo)"><path ${s(2.2)} d="${BELL}"/><path ${s(2.2)} d="M12 3v2.2M10 21.2h4"/></g><path ${s(2.2)} d="M3.6 3.6l16.8 16.8"/>`,
  invisible: `<mask id="m-inv"><rect width="24" height="24" fill="#fff"/><path d="M3.6 3.6l16.8 16.8" stroke="#000" stroke-width="4.6" stroke-linecap="round"/></mask><g mask="url(#m-inv)"><path ${s(1.8)} d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z"/><circle ${s(1.8)} cx="12" cy="12" r="3"/></g><path ${s(1.8)} d="M3.6 3.6l16.8 16.8"/>`,
  block: `<circle ${s(1.8)} cx="12" cy="12" r="9.2"/><path ${s(1.8)} d="M5.5 5.5l13 13"/>`,
};

export function svgString(name, size = 24, cls = '') {
  const inner = PATHS[name];
  if (!inner) throw new Error(`unknown icon ${name}`);
  return `<svg class="ic ic-${name}${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
}

const cache = new Map();
function parse(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild;
}

// An icon cut by a mask names it by id, and an id belongs to one element of the page: two copies
// sharing one would both follow the first, and a first one in a hidden part of the page (a page
// leaving, a closed layer) would draw them empty. Each copy gets ids of its own.
let maskSeq = 0;
const MASKED = /id="([^"]+)"/g;

/** A fresh SVG element for the named icon. Parsed once, then cloned. */
export function icon(name, size = 24, cls = '') {
  if (PATHS[name] && PATHS[name].includes('<mask')) {
    const n = ++maskSeq;
    return parse(svgString(name, size, cls).replace(MASKED, `id="$1-${n}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-${n})`));
  }
  const key = `${name}|${size}|${cls}`;
  let node = cache.get(key);
  if (!node) {
    node = parse(svgString(name, size, cls));
    cache.set(key, node);
  }
  return node.cloneNode(true);
}

/**
 * The MPfy logo, from the brand PNG: at 48 px and below the simplified variant with fewer,
 * thicker bars (mpfy-64.png, also the 2x favicon), above it the full logo (192 or 512 px, about
 * twice the displayed size so it stays sharp on phone screens).
 */
export function logoEl(size = 28) {
  const file = size <= 48 ? 64 : size <= 96 ? 192 : 512;
  const img = document.createElement('img');
  img.className = 'logo';
  img.src = `/icons/mpfy-${file}.png`;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/** Small animated equalizer shown next to the title of the track that is playing. */
export function eqEl() {
  return parse(
    '<svg class="eq" width="14" height="14" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
      '<rect fill="currentColor" x="1" y="2" width="2.4" height="10" rx=".6"/>' +
      '<rect fill="currentColor" x="4.8" y="2" width="2.4" height="10" rx=".6"/>' +
      '<rect fill="currentColor" x="8.6" y="2" width="2.4" height="10" rx=".6"/>' +
      '</svg>'
  );
}

export const ICON_NAMES = Object.keys(PATHS);
