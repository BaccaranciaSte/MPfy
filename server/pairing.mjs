// pairing.json: the permanent pairing secret, { "secret": "<40 hex>" },
// 0600, created at first start. The code Bacca types is formatCode(secret).
//
// A damaged pairing.json is set aside as pairing.json.corrupt-<ms> and a new
// secret is made: only the code changes, every paired device keeps working.
// The file may change under a running server (the CLI's rotate-code when the
// server could not be reached): reloadIfChanged() notices it.

import fs from 'node:fs'
import path from 'node:path'
import { formatCode, generateSecret, SECRET_BYTES } from '../transport/code.js'
import { writeAtomicSync, renameSyncRetry, logError } from './util.mjs'

const HEX_RE = new RegExp('^[0-9a-f]{' + (SECRET_BYTES * 2) + '}$')

export class PairingStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'pairing.json')
    this._secret = null
    this._stamp = null
  }

  _statStamp () {
    try {
      const st = fs.statSync(this.file)
      return st.mtimeMs + ':' + st.size
    } catch {
      return 'missing'
    }
  }

  /** Read pairing.json, creating it (or replacing a damaged one) when needed. */
  load () {
    let raw = null
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (raw !== null) {
      try {
        const data = JSON.parse(raw)
        const hex = data && typeof data.secret === 'string' ? data.secret.toLowerCase() : ''
        if (!HEX_RE.test(hex)) throw new Error('no valid "secret"')
        this._secret = Buffer.from(hex, 'hex')
        this._stamp = this._statStamp()
        return this._secret
      } catch (err) {
        const aside = this.file + '.corrupt-' + Date.now()
        renameSyncRetry(this.file, aside)
        logError('pairing.json unreadable (' + err.message + '), moved to ' + path.basename(aside) + '; a new pairing code is made')
      }
    }
    return this._write(generateSecret())
  }

  _write (secret) {
    writeAtomicSync(this.file, JSON.stringify({ secret: Buffer.from(secret).toString('hex') }, null, 2) + '\n')
    this._secret = Buffer.from(secret)
    this._stamp = this._statStamp()
    return this._secret
  }

  get secret () {
    if (this._secret === null) this.load()
    return this._secret
  }

  get code () {
    return formatCode(this.secret)
  }

  /** A new secret: the old code stops being valid. Returns the new secret. */
  rotate () {
    return this._write(generateSecret())
  }

  /**
   * Did pairing.json change on disk since we last read or wrote it? If so the new
   * secret is loaded and returned; otherwise null.
   */
  reloadIfChanged () {
    const stamp = this._statStamp()
    if (stamp === this._stamp) return null
    if (stamp === 'missing' && this._secret !== null) {
      // Deleted under us: a deletion is not a rotation, the code stays the same.
      this._write(this._secret)
      return null
    }
    const before = this._secret ? Buffer.from(this._secret).toString('hex') : null
    const secret = this.load()
    return Buffer.from(secret).toString('hex') === before ? null : secret
  }
}
