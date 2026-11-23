// The links the app's QR codes carry (the Android app opens the page with them too, #aggiungi=):
//   mpfy://collega?p=<profile code>&s=<source code>&s=...   a profile and the sources it uses
//   mpfy://fonte?s=<source code>                            one source
// The codes go in without their dashes: fewer modules to scan. A typed code is never a link and
// is read as before. The app's CodeLinks.kt reads them by the same rules.

/** More sources than this in one link: not a link of ours (the QR of a profile carries the first ones). */
export const MAX_LINK_SOURCES = 20;

const CODE_CHARS = /^[0-9A-TV-Z]+$/;
const squeeze = (c) => String(c ?? '').toUpperCase().replace(/[\s\-_]/g, '');

/** The squeezed profile code (56 characters, 61 with MPFYP), or null. */
function profileCode(c) {
  const s = squeeze(c);
  return (s.length === 56 || (s.length === 61 && s.startsWith('MPFYP'))) && CODE_CHARS.test(s) ? s : null;
}

/** The squeezed source code (32 characters, 36 with MPFY), or null. */
function sourceCode(c) {
  const s = squeeze(c);
  return (s.length === 32 || (s.length === 36 && s.startsWith('MPFY'))) && CODE_CHARS.test(s) ? s : null;
}

/** The link of "Collega un altro dispositivo": the profile and every source of this person. */
export const profileLink = (profile, sources = []) =>
  `mpfy://collega?p=${squeeze(profile)}${sources
    .slice(0, MAX_LINK_SOURCES)
    .map((c) => `&s=${squeeze(c)}`)
    .join('')}`;

/** The link of a source's "Mostra codice". */
export const sourceLink = (code) => `mpfy://fonte?s=${squeeze(code)}`;

/**
 * A link of ours: { profile, sources } (profile null for a source link, which has exactly one
 * source), or null for anything else, a typed code included. A p or s that is not a code of its
 * kind makes the whole link null; the same source twice counts once.
 */
export function parseLink(raw) {
  const m = /^mpfy:\/\/(collega|fonte)\/?\?([^#\s]*)$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  const collega = m[1].toLowerCase() === 'collega';
  let profile = null;
  const sources = [];
  for (const part of m[2].split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = part.slice(eq + 1);
    if (key === 'p') {
      if (!collega || profile) return null;
      profile = profileCode(value);
      if (!profile) return null;
    } else if (key === 's') {
      const s = sourceCode(value);
      if (!s) return null;
      if (!sources.includes(s)) sources.push(s);
    }
  }
  if (sources.length > MAX_LINK_SOURCES) return null;
  if (collega) return profile ? { profile, sources } : null;
  return sources.length === 1 ? { profile: null, sources } : null;
}
