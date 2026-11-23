// The version a title names: an instrumental, a live take, a remix... Two files
// of one song whose titles name different versions are kept apart (pipeline.mjs),
// and the details from the network never mix them up (details.mjs).

// A katakana word counts whole: ショートケーキ is a cake, not a short version.
const kana = (word) => new RegExp('(?<![\\u30a1-\\u30fa\\u30fc])' + word + '(?![\\u30a1-\\u30fa\\u30fc])')

// Words in a title that name another version of a song.
const VERSION_WORDS = [
  ['instrumental', [/\binst(?:rumental)?\b/, /\bbacking tracks?\b/, kana('インスト(?:ゥルメンタル)?'), /歌なし/]],
  ['offvocal', [/\boff[\s-]?vocals?\b/, /\bwithout vocals?\b/, /\bno vocals?\b/, kana('オフ[\\s・]?ボ(?:ーカル)?')]],
  ['karaoke', [/\bkaraoke\b/, kana('カラオケ')]],
  ['acapella', [/\ba[\s-]?cap+ell?a\b/, kana('アカペラ')]],
  ['tvsize', [/\btv[\s-]?(?:size|ver(?:sion)?|edit)\b/, /tvサイズ/]],
  ['short', [/\bshort\b/, kana('ショート')]],
  ['live', [/\blive\b/, kana('ライブ'), kana('ライヴ')]],
  ['acoustic', [/\bacoustic\b/, kana('アコースティック')]],
  ['remix', [/\bre-?mix(?:ed)?\b/, kana('リミックス')]],
  ['mix', [/\bmix\b/]],
  ['dub', [/\bdub\b/]],
  ['demo', [/\bdemo\b/, kana('デモ')]],
  ['edit', [/\bedit\b/]],
  ['extended', [/\bextended\b/]],
  ['remaster', [/\bremaster(?:ed)?\b/, kana('リマスター')]],
  ['clean', [/\bclean\b/]],
  ['explicit', [/\bexplicit\b/]]
]
// What stands in brackets (closed or not), between two tildes, between two
// dashes ("Song -off vocal-"), or after a spaced dash ("Song - Live").
const BRACKETS = /[(\[{（［【「『〈《]([^)\]}）］】」』〉》]*)|[~〜]([^~〜]+)[~〜]|\s-([^-]+)-(?=\s|$)/g
const AFTER_DASH = /\s[-\u2013\u2014]\s(.*)$/
// "Original mix" and "album version" are the plain song.
const PLAIN = /\boriginal (?:mix|version|edit)\b|\balbum (?:version|edit|mix)\b/g

/**
 * The version words of a title (sorted, empty for a plain title). `fileName`:
 * the title is a file's name, where "X - Y" is mostly "artist - title", so
 * only brackets, tildes and dash pairs count there.
 */
export function versionWords (title, { fileName = false } = {}) {
  if (typeof title !== 'string' || title === '') return []
  const text = title.normalize('NFKC').toLowerCase()
  const parts = []
  for (const m of text.matchAll(BRACKETS)) parts.push(m[1] ?? m[2] ?? m[3] ?? '')
  if (!fileName) {
    const m = AFTER_DASH.exec(text.replace(BRACKETS, ' '))
    if (m !== null) parts.push(m[1])
  }
  const found = new Set()
  for (const raw of parts) {
    const part = raw.replace(PLAIN, '')
    for (const [word, res] of VERSION_WORDS) if (res.some((re) => re.test(part))) found.add(word)
  }
  return [...found].sort()
}

/** Do two titles name different versions? (`aName`, `bName`: titles that are file names.) */
export function differentVersions (a, b, { aName = false, bName = false } = {}) {
  return versionWords(a, { fileName: aName }).join() !== versionWords(b, { fileName: bName }).join()
}
