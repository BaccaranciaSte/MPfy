// Times in words, the same everywhere they show:
//   clock         "14:32" (24 h)
//   list times    today the clock, yesterday "ieri", the last 6 days "lun" ... "dom", older
//                 "12/11", another year "12/11/25"
//   relative      under a minute "adesso", "4 min fa", "1 ora fa", "3 ore fa" (under 24 h), then as
//                 list times (last played, comments)
//   chat days     "Oggi", "Ieri", the last 6 days "Lunedì" ... "Domenica", older "12 novembre",
//                 another year "12 novembre 2025"
//   Recenti days  "Oggi", "Ieri", then "12 novembre", another year "12 novembre 2025"
// Days are the device's own calendar days (a play at 23:59 and one at 00:01 are two days).

const SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const LONG = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MIN = 60000;
const HOUR = 3600000;

const pad = (n) => String(n).padStart(2, '0');

/** "14:32". */
export function clockTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Calendar days from the day of ms to the day of now: 0 today, 1 yesterday (negative ahead). */
export function daysAgo(ms, now = Date.now()) {
  const a = new Date(ms);
  const b = new Date(now);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

const sameYear = (ms, now) => new Date(ms).getFullYear() === new Date(now).getFullYear();

/** "12 novembre", with the year when it is another one. */
function dateWords(ms, now) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear(ms, now) ? '' : ` ${d.getFullYear()}`}`;
}

/** The time of a row in a list. */
export function listTime(ms, now = Date.now()) {
  const n = daysAgo(ms, now);
  if (n <= 0) return clockTime(ms);
  if (n === 1) return 'ieri';
  if (n <= 6) return SHORT[new Date(ms).getDay()];
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}${sameYear(ms, now) ? '' : `/${pad(d.getFullYear() % 100)}`}`;
}

/** How long ago: "adesso", "N min fa", "1 ora fa", "N ore fa", then the list time. */
export function relTime(ms, now = Date.now()) {
  const d = now - ms;
  if (d < MIN) return 'adesso';
  if (d < HOUR) return `${Math.floor(d / MIN)} min fa`;
  if (d < 2 * HOUR) return '1 ora fa';
  if (d < 24 * HOUR) return `${Math.floor(d / HOUR)} ore fa`;
  return listTime(ms, now);
}

/** The label over a day of a chat. */
export function chatDay(ms, now = Date.now()) {
  const n = daysAgo(ms, now);
  if (n <= 0) return 'Oggi';
  if (n === 1) return 'Ieri';
  if (n <= 6) return LONG[new Date(ms).getDay()];
  return dateWords(ms, now);
}

/** The label over a day of "Recenti". */
export function recentsDay(ms, now = Date.now()) {
  const n = daysAgo(ms, now);
  if (n <= 0) return 'Oggi';
  if (n === 1) return 'Ieri';
  return dateWords(ms, now);
}
