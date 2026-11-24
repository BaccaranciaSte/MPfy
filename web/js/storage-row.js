// The line under "Scheda di memoria" in the owner's source settings: what the memory card
// is doing, from GET /api/admin/storage. Pure, so the words are checked in Node (web/dev/card-row.mjs).

import { fmtInt, fmtSize } from './util.js';

/**
 * { sub, tap, found, danger } for the view, or null when there is no card to show. tap: 'use' (the
 * found card can be chosen), 'inUse' (stop using it), 'away' (forget it), or null (no tap).
 */
export function storageState(view) {
  const c = view.card;
  const f = view.found.find((x) => x.usable) || view.found[0] || null;
  if (!c) {
    if (!f) return null;
    if (f.why === 'other_source') return { sub: "Di un'altra fonte MPfy, non si può usare", tap: null };
    if (!f.usable) return { sub: f.why === 'read_only' ? 'In sola lettura' : 'La fonte non può scrivere sulla scheda', tap: null };
    return { sub: `${fmtSize(f.freeBytes)} liberi. Tocca per usarla per la musica`, tap: 'use', found: f };
  }
  const moving = c.moving ? `${fmtInt(c.moving.done)} di ${fmtInt(c.moving.total)} brani` : null;
  if (c.state === 'unconfigured') return { sub: 'Scheda non configurata', tap: f && f.usable ? 'use' : 'away', found: f, danger: true };
  if (c.state === 'away' || c.state === 'pending') return { sub: `Non trovata: ${fmtInt(c.awayTracks)} brani non disponibili`, tap: 'away', danger: true };
  if (c.leaving) return { sub: moving ? `Riporto la musica nella memoria interna: ${moving}` : 'Riporto la musica nella memoria interna', tap: null };
  if (c.bad) return { sub: 'La scheda non conserva bene i dati, la musica resta nella memoria interna', tap: 'inUse' };
  if (c.state === 'readonly') return { sub: 'In sola lettura, la musica nuova va nella memoria interna', tap: 'inUse' };
  if (c.full) return { sub: 'Piena, la musica nuova va nella memoria interna', tap: 'inUse' };
  if (moving) return { sub: `In uso, sposto la musica: ${moving}`, tap: 'inUse' };
  return { sub: `In uso, ${fmtSize(c.freeBytes)} liberi`, tap: 'inUse' };
}
