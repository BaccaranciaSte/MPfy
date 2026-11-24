import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitGenres, genreOf, genreKey, MACROS, macroName, MAX_GENRES } from '../web/js/genres.js'

const of = (s) => { const g = genreOf(s); return g && [g.name, g.macro] }

test('the spellings of one genre share a key and a name', () => {
  for (const s of ['J-Pop', 'jpop', 'J Pop', 'J-POP', 'j‑pop ']) assert.deepEqual(of(s), ['J-pop', 'pop'], s)
  assert.equal(genreKey('R&B'), genreKey('r and b'))
  assert.deepEqual(of('Rhythm & Blues'), ['R&B', 'rnb'])
  assert.deepEqual(of('Hip-Hop'), ['Hip hop', 'hiphop'])
  assert.deepEqual(of('Reggaetón'), ['Reggaeton', 'latino'])
})

test('a tag value with several genres is cut, cleaned, one of each', () => {
  assert.deepEqual(splitGenres('Hip-Hop/Rap'), ['Hip-Hop', 'Rap'])
  assert.deepEqual(splitGenres('Pop\u0000Rock\u0000pop'), ['Pop', 'Rock'])
  assert.deepEqual(splitGenres(['Soundtrack; Musical', '  anime  ', 'Anime']), ['Soundtrack', 'Musical', 'anime'])
  assert.deepEqual(splitGenres('Rhythm & Blues'), ['Rhythm & Blues'])
  assert.deepEqual(splitGenres(['', '   ', null, 7, '(17)', '42']), [])
  assert.equal(splitGenres('a;b;c;d;e;f;g').length, MAX_GENRES)
  assert.ok(splitGenres('x'.repeat(100))[0].length <= 40)
})

test('each genre has its family: the table, then the words in order, else Altro', () => {
  const want = {
    Soundtrack: 'colonne', 'Show Tunes': 'colonne', 'Video Game Music': 'colonne', Anime: 'colonne',
    'K-Pop': 'pop', 'City Pop': 'pop', Synthpop: 'pop', 'Dance-Pop': 'pop', 'Musica leggera': 'pop',
    'Pop Rock': 'rock', 'Pop Punk': 'rock', Britpop: 'rock', 'Post-Rock': 'rock', 'Classic Rock': 'rock', 'Symphonic Rock': 'rock',
    'Symphonic Metal': 'metal', 'Trap Metal': 'metal', Trap: 'hiphop', 'Rap italiano': 'hiphop',
    Techno: 'elettronica', 'Deep House': 'elettronica', 'Lo-Fi': 'elettronica', 'Trip Hop': 'elettronica', 'Italo Disco': 'elettronica',
    'Neo-Soul': 'rnb', Funk: 'rnb', 'Country Pop': 'folk', 'Musica popolare': 'folk', Cantautorale: 'folk',
    'Smooth Jazz': 'jazz', 'Delta Blues': 'jazz', Baroque: 'classica', Opera: 'classica', 'Latin Pop': 'latino', Dancehall: 'latino',
    Afrobeat: 'mondo', Celtic: 'mondo', Zzzxq: 'altro',
  }
  for (const [g, m] of Object.entries(want)) assert.equal(genreOf(g).macro, m, g)
})

test('a genre the table does not hold is shown as written', () => {
  assert.deepEqual(of('Vaporwave'), ['Vaporwave', 'elettronica'])
  assert.deepEqual(of('shoegaze'), ['Shoegaze', 'rock'])
  assert.equal(genreOf('   '), null)
  assert.equal(genreOf(null), null)
})

test('the families: every id named once, Altro last', () => {
  assert.equal(new Set(MACROS.map((m) => m.id)).size, MACROS.length)
  assert.equal(MACROS.at(-1).id, 'altro')
  assert.equal(macroName('colonne'), 'Colonne sonore e musical')
  assert.equal(macroName('nope'), null)
})
