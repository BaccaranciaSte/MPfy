// An error that carries the HTTP status and the Italian message for the client.
// `code` is a stable id the UI maps to its own words; `extra` adds fields to the
// JSON answer (triesLeft, retryAt, a session's state).
export class HttpError extends Error {
  constructor (status, message, code = null, extra = null) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const CODES = {
  forbidden: [403, 'Non consentito'],
  no_profile: [403, 'Profilo mancante'],
  bad_profile: [403, 'Profilo non valido'],
  bad_name: [400, 'Nome non valido'],
  bad_photo: [400, 'Foto non valida'],
  bad_request: [400, 'Richiesta non valida'],
  playlist_exists: [409, "Playlist gia' presente"],
  unsupported_archive: [415, 'Formato non supportato'],
  disk_full: [507, 'Spazio su disco esaurito sulla fonte'],
  too_many_uploads: [429, 'Troppi caricamenti in corso'],
  offset_mismatch: [409, 'Posizione non valida'],
  session_gone: [404, 'Caricamento non trovato'],
  pending_gone: [404, 'Scelta scaduta'],
  version_gone: [404, 'Brano non trovato'],
  no_recovery: [404, 'Recupero non attivo'],
  wrong_password: [403, 'Password errata'],
  locked: [429, 'Troppi tentativi'],
  bad_card: [400, 'Profilo social non valido'],
  bad_time: [400, 'Momento non valido'],
  no_person: [404, 'Persona non trovata'],
  bad_message: [400, 'Messaggio non valido'],
  message_gone: [404, 'Messaggio non trovato'],
  bad_comment: [400, 'Commento non valido'],
  comment_gone: [404, 'Commento non trovato'],
  no_lyrics: [404, 'Testo non trovato'],
  bad_lyrics: [400, 'Testo non valido'],
  slow_down: [429, 'Troppe richieste, riprova tra poco'],
  track_away: [404, 'Brano non disponibile ora'],
  card_in_use: [409, "C'e' gia' una scheda in uso"],
  card_gone: [404, 'Scheda non trovata'],
  card_taken: [409, "Scheda di un'altra fonte"],
  card_read_only: [409, 'Scheda in sola lettura'],
  card_no_access: [403, "La fonte non puo' scrivere sulla scheda"]
}

/** An HttpError with the status and text that go with `code`. */
export function apiError (code, extra = null) {
  const [status, message] = CODES[code]
  return new HttpError(status, message, code, extra)
}

/**
 * An error whose answer is a state as it is (an upload session's GET shape):
 * its own `error` (absent, or the failure object) is never covered by the text.
 */
export function stateError (code, state) {
  const err = apiError(code, state)
  err.state = true
  return err
}

// Archive failures travel in the archive status, not as HTTP statuses.
export const ARCHIVE_ERRORS = {
  archive_encrypted: 'Archivio protetto da password',
  archive_too_big: 'Archivio troppo grande',
  archive_invalid: 'Archivio non valido',
  archive_interrupted: 'Caricamento interrotto',
  unsupported_archive: 'Formato non supportato',
  disk_full: 'Spazio su disco esaurito sulla fonte'
}

export class ArchiveError extends Error {
  constructor (code) {
    super(ARCHIVE_ERRORS[code] || 'Archivio non valido')
    this.code = code in ARCHIVE_ERRORS ? code : 'archive_invalid'
  }
}
