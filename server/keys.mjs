// keys.json: the server's HyperDHT seed (32 bytes hex), created on first start.
// A damaged keys.json stops the server instead of silently creating a new identity
// (that would orphan every paired client).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomicSync } from './util.mjs'

export function loadOrCreateSeed (dataDir) {
  const file = path.join(dataDir, 'keys.json')
  let raw = null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (raw === null) {
    const seed = crypto.randomBytes(32).toString('hex')
    writeAtomicSync(file, JSON.stringify({ seed }, null, 2) + '\n')
    return Buffer.from(seed, 'hex')
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('keys.json is not valid JSON: fix or restore it (deleting it changes the server identity and every client must pair again)')
  }
  if (!data || typeof data.seed !== 'string' || !/^[0-9a-fA-F]{64}$/.test(data.seed)) {
    throw new Error('keys.json has no valid "seed" (64 hex chars)')
  }
  return Buffer.from(data.seed, 'hex')
}
