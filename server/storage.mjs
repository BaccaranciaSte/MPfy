// The owner's memory card: what GET /api/admin/storage and the `card` command
// show, and the three choices (use a found card, stop using it, forget it).
// The places (places.mjs) do the work on the card, the library keeps its
// tracks, the move job carries the music (moves.mjs).

import { apiError } from './errors.mjs'

/**
 * { card: {...} | null, found: [...] }: the card in use (or the one the log
 * says holds music when source.json lost it), and the cards found.
 */
export async function storageView ({ places, library, moves }) {
  places.maybeRecheck()
  const found = (await places.discover()).map((c) => ({
    volume: c.volume, freeBytes: c.freeBytes, totalBytes: c.totalBytes, usable: c.usable, why: c.why, appFolder: c.appFolder
  }))
  const card = places.card
  const counts = library.cardCounts()
  if (card === null) {
    if (library.cardInUse === null) return { card: null, found }
    // The log says a card holds music and source.json names none.
    return { card: { volume: null, state: 'unconfigured', freeBytes: null, totalBytes: null, floorBytes: null, tracks: counts.tracks, awayTracks: counts.away, moving: null, leaving: false, appFolder: false, full: false, bad: false, needBytes: null }, found }
  }
  const view = {
    volume: card.volume,
    state: card.invalid ? 'away' : card.state,
    freeBytes: null,
    totalBytes: null,
    floorBytes: null,
    tracks: counts.tracks,
    awayTracks: counts.away,
    moving: moves !== null ? moves.progress : null,
    leaving: card.leaving === true,
    appFolder: card.folder !== null && card.folder !== 'MPfy',
    full: card.full === true,
    bad: card.bad === true,
    needBytes: places.blocked !== null ? places.blocked.needBytes : null
  }
  if (card.readable) {
    const s = await card.disk.state()
    view.freeBytes = Number.isFinite(s.free) ? s.free : null
    view.totalBytes = s.total
    view.floorBytes = s.floor
  }
  // The room `off` needs in internal memory (the originals on the card; spilled
  // transcodes are a cache and never count).
  if (!view.leaving && card.readable) {
    const room = await leaveRoom({ places, library })
    if (room.short) view.needBytes = room.needFree
    view.internalFreeBytes = room.free
  }
  return { card: view, found: found.filter((c) => c.volume !== card.volume) }
}

// Is there room in internal memory for the originals on the card?
async function leaveRoom ({ places, library }) {
  let need = 0
  for (const t of library.tracks.values()) {
    const p = library.placeOfTrack(t)
    if (p !== null && p.kind === 'card') need += t.size
  }
  const s = await places.internal.disk.state()
  const reserved = places.internal.disk.reserved()
  const needFree = need + s.floor + reserved
  return { need, needFree, free: Number.isFinite(s.free) ? s.free : null, short: s.free - reserved - need < s.floor }
}

/**
 * One choice of the owner: { use: <volume> }, { leave: true } or { forget: true }.
 * Resolves the view after it. Throws the card errors, or disk_full with
 * extra.needBytes when internal memory lacks room for the music to come back.
 */
export async function storageAction (ctx, body) {
  const { places, library, moves, jobs } = ctx
  if (!body || typeof body !== 'object') throw apiError('bad_request')
  if (typeof body.use === 'string') {
    if (places.card !== null) throw apiError('card_in_use')
    const card = await places.choose(body.use)
    library.setCardInUse(card.id)
    // A card this source used before: its files come back with their ids.
    await library.cardChosen()
    if (moves !== null) moves.kick()
    return storageView(ctx)
  }
  if (body.leave === true) {
    const card = places.card
    if (card === null || card.invalid) throw apiError('card_gone')
    if (!card.ready) throw apiError('card_gone')
    const room = await leaveRoom({ places, library })
    if (room.short) throw apiError('disk_full', { needBytes: room.needFree })
    places.leave()
    if (moves !== null) moves.kick()
    return storageView(ctx)
  }
  if (body.forget === true) {
    if (places.card === null && library.cardInUse === null) throw apiError('card_gone')
    if (jobs) jobs.dropCardLevels()
    library.forgetCard()
    if (places.card !== null) places.forget()
    return storageView(ctx)
  }
  throw apiError('bad_request')
}

// ------------------------------------------------------------------ texts

/** 31,9 GB: sizes as the page's fmtSize writes them. */
export function sizeText (bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

/** 1.240: counts with the thousands point. */
export function countText (n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function foundLine (c) {
  if (c.usable) return 'Scheda ' + c.volume + ': ' + sizeText(c.freeBytes) + ' liberi su ' + sizeText(c.totalBytes) + '. Per usarla: node server/index.mjs card use ' + c.volume
  if (c.why === 'other_source') return 'Scheda ' + c.volume + ": contiene la musica di un'altra fonte MPfy."
  if (c.why === 'read_only') return 'Scheda ' + c.volume + ': in sola lettura.'
  return 'Scheda ' + c.volume + ': la fonte non ha accesso (manca il gruppo media_rw).'
}

/** The lines of `card`. */
export function viewLines (view) {
  const lines = []
  const c = view.card
  if (c !== null) {
    if (c.state === 'unconfigured') {
      lines.push('Scheda non configurata: ' + countText(c.awayTracks) + ' brani non disponibili. Per riprenderla: node server/index.mjs card use <scheda>')
    } else if (c.state === 'away' || c.state === 'pending') {
      lines.push('Scheda ' + c.volume + ' non trovata: ' + countText(c.awayTracks) + " brani non disponibili finche' non torna.")
    } else {
      let line = 'In uso: scheda ' + c.volume + ', ' + sizeText(c.freeBytes) + ' liberi, ' + countText(c.tracks) + ' brani.'
      if (c.moving !== null) line += ' Sposto la musica: ' + countText(c.moving.done) + ' di ' + countText(c.moving.total) + ' brani.'
      lines.push(line)
    }
  }
  for (const f of view.found) lines.push(foundLine(f))
  if (lines.length === 0) lines.push('Nessuna scheda di memoria trovata.')
  return lines
}

export const CARD_USAGE = 'uso: node server/index.mjs card [use <scheda> | off | forget --yes]'
