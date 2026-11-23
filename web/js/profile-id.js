// The profile ID a person shows (K7Q2-MX9P): the first 40 bits of their profileId (its first 10
// hex characters, big-endian) as 8 Crockford base32 digits, most significant first. The same on
// every source and device, public and harmless, computed here from the hex alone. It never looks
// like the profile code (MPFY-P-...): 8 characters, one hyphen. Where two people of your circle
// share a name, the first 4 follow it (the tag).
//
// Search finds a person by it: a query is read upper case, without hyphens and spaces, O as 0,
// I and L as 1, and matches when it is a prefix of the ID without its hyphen.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = /^[0-9a-f]{10}/i;
const SHOWN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** "XXXX-XXXX" for a profileId (32 hex), '' for anything else. */
export function profileIdText(profileId) {
  const s = String(profileId || '');
  if (!PREFIX.test(s)) return '';
  let n = parseInt(s.slice(0, 10), 16); // 40 bits: exact in a double
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** The ID as the core gave it when it is one, else computed from the profileId. */
export const pidOf = (pid, profileId) => (typeof pid === 'string' && SHOWN.test(pid) ? pid : profileIdText(profileId));

/** What a query is searched as. */
export const searchKey = (q) =>
  String(q ?? '')
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

/** The query names this ID: at least 2 characters, a prefix of the ID without its hyphen. */
export function idMatches(pid, q) {
  const k = searchKey(q);
  return k.length >= 2 && String(pid || '').replace('-', '').startsWith(k);
}
