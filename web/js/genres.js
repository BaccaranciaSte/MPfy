// Genres: what the tags and MusicBrainz call them, cleaned, and the family each one belongs to.
//
// A song's genre field may hold several (ID3 separates them with a NUL, others with ; / | or ,):
// splitGenres() cuts them, cleans them and keeps one of each. genreKey() is what tells two
// spellings of the same genre apart from two genres ("J-Pop", "jpop", "J Pop" share "jpop").
// genreOf() names a genre the same way everywhere (the table below, else the tag as written) and
// puts it in one of the families of Cerca (MACROS): the table first, then the first family whose
// words the key holds, in an order that settles the mixed ones ("Symphonic metal" is Metal,
// "Pop rock" is Rock, "Synthpop" is Pop), else Altro.

/** The families, in the order Cerca shows them. */
export const MACROS = [
  { id: 'pop', name: 'Pop' },
  { id: 'rock', name: 'Rock' },
  { id: 'hiphop', name: 'Hip hop e rap' },
  { id: 'elettronica', name: 'Elettronica e dance' },
  { id: 'rnb', name: 'R&B e soul' },
  { id: 'metal', name: 'Metal' },
  { id: 'colonne', name: 'Colonne sonore e musical' },
  { id: 'folk', name: 'Cantautori e folk' },
  { id: 'jazz', name: 'Jazz e blues' },
  { id: 'classica', name: 'Classica' },
  { id: 'latino', name: 'Latino e reggae' },
  { id: 'mondo', name: 'Musica dal mondo' },
  { id: 'altro', name: 'Altro' },
];
const MACRO_NAME = new Map(MACROS.map((m) => [m.id, m.name]));
export const macroName = (id) => MACRO_NAME.get(id) || null;

export const MAX_GENRES = 5; // per song
const MAX_LEN = 40;

/** The key of a genre: no accents, no case, & as "and", letters and digits only. '' for none. */
export function genreKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

// The genres named the same way everywhere: [name, family, other spellings...]. The keys of the
// other spellings are enough ("hip-hop" and "Hip Hop" are both "hiphop").
const TABLE = [
  ['Pop', 'pop', 'musica leggera', 'leggera', 'pop music'],
  ['J-pop', 'pop'],
  ['K-pop', 'pop'],
  ['C-pop', 'pop', 'mandopop', 'cantopop'],
  ['City pop', 'pop'],
  ['Synth pop', 'pop', 'synthpop', 'synth-pop', 'electropop', 'electro pop'],
  ['Dance pop', 'pop', 'dance-pop'],
  ['Indie pop', 'pop'],
  ['Dream pop', 'pop'],
  ['Italo pop', 'pop', 'pop italiano', 'italian pop'],
  ['Rock', 'rock'],
  ['J-rock', 'rock'],
  ['Pop rock', 'rock', 'pop/rock'],
  ['Pop punk', 'rock'],
  ['Britpop', 'rock'],
  ['Indie', 'rock', 'indie rock', 'indie italiano'],
  ['Alternative', 'rock', 'alternative rock', 'alt rock', 'alt-rock'],
  ['Post-rock', 'rock', 'postrock'],
  ['Punk', 'rock', 'punk rock'],
  ['Hip hop', 'hiphop', 'hip-hop', 'hip hop/rap', 'rap/hip hop'],
  ['Rap', 'hiphop', 'rap italiano', 'italian rap'],
  ['Trap', 'hiphop'],
  ['Lo-fi', 'elettronica', 'lofi', 'lo-fi hip hop', 'lofi hip hop', 'chillhop'],
  ['Trip hop', 'elettronica', 'trip-hop'],
  ['Elettronica', 'elettronica', 'electronic', 'electronica', 'electronic music', 'musica elettronica'],
  ['Dance', 'elettronica', 'dance music', 'dance/electronic', 'electronic/dance'],
  ['EDM', 'elettronica'],
  ['Drum and bass', 'elettronica', 'dnb', 'd&b', "drum'n'bass", 'drum n bass'],
  ['Synthwave', 'elettronica', 'retrowave', 'outrun'],
  ['Disco', 'elettronica'],
  ['R&B', 'rnb', 'rnb', 'rhythm and blues', 'r and b', 'contemporary r&b'],
  ['Soul', 'rnb', 'neo soul', 'neo-soul'],
  ['Funk', 'rnb'],
  ['Metal', 'metal', 'heavy metal'],
  ['Colonna sonora', 'colonne', 'soundtrack', 'soundtracks', 'ost', 'score', 'film score', 'film soundtrack', 'colonne sonore', 'original soundtrack'],
  ['Musical', 'colonne', 'musicals', 'musical theatre', 'musical theater', 'show tunes', 'showtunes', 'broadway', 'cast recording'],
  ['Anime', 'colonne', 'anime soundtrack', 'anisong'],
  ['Musica da videogiochi', 'colonne', 'video game music', 'videogame music', 'game music', 'vgm', 'video game soundtrack', 'game soundtrack'],
  ['Cantautori', 'folk', 'singer-songwriter', 'singer/songwriter', 'cantautorale', 'cantautore', 'canzone d\'autore'],
  ['Folk', 'folk', 'indie folk', 'folk music'],
  ['Country', 'folk'],
  ['Musica popolare', 'folk', 'popolare', 'canzone napoletana', 'liscio'],
  ['Jazz', 'jazz'],
  ['Blues', 'jazz'],
  ['Classica', 'classica', 'classical', 'musica classica', 'classical music'],
  ['Opera', 'classica', 'lirica'],
  ['Latino', 'latino', 'latin', 'latin pop', 'musica latina'],
  ['Reggaeton', 'latino', 'reggaetón'],
  ['Reggae', 'latino'],
  ['Bossa nova', 'latino'],
  ['Afrobeats', 'mondo', 'afrobeat', 'afropop'],
  ['World', 'mondo', 'world music', 'musica dal mondo'],
];
const BY_KEY = new Map();
for (const [name, macro, ...others] of TABLE) {
  for (const n of [name, ...others]) {
    const k = genreKey(n);
    if (k && !BY_KEY.has(k)) BY_KEY.set(k, { name, macro });
  }
}

// The words of each family, tried in this order on the key of a genre the table does not hold.
const WORDS = [
  ['metal', ['metal', 'grindcore', 'djent', 'deathcore', 'metalcore']],
  ['hiphop', ['hiphop', 'rap', 'trap', 'drill', 'grime', 'boombap']],
  ['colonne', ['soundtrack', 'colonnasonora', 'colonnesonore', 'filmscore', 'musical', 'anime', 'videogame', 'showtune', 'broadway']],
  ['rock', ['rock', 'punk', 'grunge', 'emo', 'shoegaze', 'psychedelic', 'psichedelic', 'garage', 'surf', 'stoner', 'indie']],
  ['jazz', ['jazz', 'blues', 'swing', 'bebop', 'bigband', 'ragtime']],
  ['classica', ['classical', 'classica', 'opera', 'baroque', 'barocc', 'symphon', 'sinfon', 'orchestr', 'chamber', 'cameristic', 'choral', 'corale', 'contemporaryclassical']],
  ['latino', ['latin', 'latino', 'reggae', 'salsa', 'bachata', 'samba', 'bossa', 'cumbia', 'tango', 'dancehall', 'ska', 'merengue', 'mpb', 'flamenco']],
  ['rnb', ['rnb', 'randb', 'rhythmandblues', 'soul', 'funk', 'gospel', 'motown', 'doowop']],
  ['folk', ['folk', 'country', 'singersongwriter', 'cantautor', 'acoustic', 'acustic', 'bluegrass', 'americana', 'popolar', 'napoletan']],
  ['pop', ['pop']],
  ['elettronica', ['electro', 'elettronic', 'house', 'techno', 'trance', 'edm', 'dubstep', 'dnb', 'drumandbass', 'jungle', 'ambient', 'synth', 'wave', 'dance', 'disco', 'idm', 'breakbeat', 'hardstyle', 'chill', 'lofi', 'downtempo', 'triphop', 'garage', 'eurobeat', 'vaporwave', 'phonk']],
  ['mondo', ['world', 'afro', 'celtic', 'fado', 'klezmer', 'bollywood', 'arab', 'african', 'balkan', 'traditional', 'tradizional', 'ethnic', 'etnic', 'enka']],
];

function macroOfKey(k) {
  for (const [macro, words] of WORDS) if (words.some((w) => k.includes(w))) return macro;
  return 'altro';
}

/** A cleaned genre: no control characters, spaces collapsed, at most 40 characters. */
function clean(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN)
    .trim();
}

/**
 * The genres of a tag value (a string or a list of them): cut at NUL ; / | and ",", cleaned,
 * one of each key, at most MAX_GENRES. A bare number (an ID3v1 code left as it was) is no genre.
 */
export function splitGenres(raw) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [raw];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    for (const part of v.split(/[\u0000;|/,]/)) {
      const g = clean(part).replace(/^\((\d+)\)$/, '$1');
      const k = genreKey(g);
      if (!k || /^\d+$/.test(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(g);
      if (out.length >= MAX_GENRES) return out;
    }
  }
  return out;
}

/**
 * How a genre is shown and its family: { key, name, macro }, or null for no genre. "Hip-Hop/Rap"
 * as one string is two genres: splitGenres() first.
 */
export function genreOf(raw) {
  const g = clean(raw || '');
  const key = genreKey(g);
  if (!key) return null;
  const known = BY_KEY.get(key);
  if (known) return { key, name: known.name, macro: known.macro };
  // As written, with a capital first letter when it was all lower case.
  const name = g === g.toLowerCase() ? g.charAt(0).toUpperCase() + g.slice(1) : g;
  return { key, name, macro: macroOfKey(key) };
}
