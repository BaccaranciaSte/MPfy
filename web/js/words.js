// Our words for the codes a source or the local core answers with. Their own text never reaches
// the screen: a known code gets these words, anything else the caller's short fallback.

const WORDS = {
  wrong_password: 'Password errata',
  locked: 'Troppi tentativi, riprova più tardi',
  no_recovery: 'Nessun profilo da recuperare qui',
  session_gone: 'Tempo scaduto',
  bad_code: 'Codice non valido',
  source_code: 'Questo è il codice di una fonte',
  profile_code: 'Questo è il codice del profilo',
  bad_file: 'File non valido',
  bad_name: 'Nome non valido',
  short_password: 'Almeno 8 caratteri',
  unreachable: 'Fonte non raggiungibile',
  too_large: 'File troppo grande',
  not_audio: 'Formato non supportato',
  unsupported_archive: 'Formato non supportato',
  too_many_uploads: 'Troppi caricamenti in corso',
  archive_encrypted: 'Archivio protetto da password',
  archive_too_big: 'Archivio troppo grande',
  archive_invalid: 'Archivio non valido',
  archive_interrupted: 'Caricamento interrotto',
  // the people part
  bad_card: 'Profilo social non valido',
  bad_time: 'Momento non valido',
  no_person: 'Persona non trovata',
  bad_message: 'Messaggio non valido',
  message_gone: 'Messaggio non trovato',
  bad_comment: 'Commento non valido',
  comment_gone: 'Commento non trovato',
  no_lyrics: 'Testo non trovato',
  bad_lyrics: 'Testo non valido',
  slow_down: 'Troppe richieste, riprova tra poco',
};

export const GENERIC = 'Qualcosa non ha funzionato';

/** The words for a code, or null when the code is not one of ours. name: the source involved. */
export function wordsFor(code, name = null) {
  if (code === 'disk_full') return name ? `Spazio esaurito su ${name}` : 'Spazio esaurito';
  return (typeof code === 'string' && Object.prototype.hasOwnProperty.call(WORDS, code) && WORDS[code]) || null;
}

/** The words for a failed /local request: its code, else the generic line. */
export const localWords = (err) => wordsFor(err?.code) || (err?.status === 0 ? 'Fonte non raggiungibile' : GENERIC);

/**
 * Tells codes apart by their normalized length: a source code is 32 characters (36 with MPFY),
 * a profile code 56 (61 with MPFYP).
 */
export function codeKind(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/[\s\-_\u2010-\u2015\u2212]/g, '');
  if (s.length === 61 || s.length === 56) return 'profile';
  if (s.length === 36 || s.length === 32) return 'source';
  return null;
}
