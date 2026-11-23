// PUT /api/upload/:filename: the body is streamed to data/tmp/ (never held in
// memory) while it is hashed and counted. Over the size limit the transfer is cut
// with 413. The disk rule is applied with Content-Length before reading, the
// declared bytes still to come are reserved while they stream (so uploads at
// once never pass the floor together), and the room is checked again every
// 8 MB. The finished file then goes through the upload pipeline (pipeline.mjs).
// Every failure path removes the temp file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { HttpError, apiError } from './errors.mjs'
import { HEAD_BYTES } from './media.mjs'
import { unlinkQuietAsync } from './util.mjs'

export const MAX_UPLOAD_BYTES = 600 * 1024 * 1024
export const MAX_ARCHIVE_BYTES = 4294967296
const DISK_CHECK_EVERY = 8 * 1024 * 1024

export function tooLargeError (maxBytes) {
  const text = maxBytes >= MAX_ARCHIVE_BYTES ? '4 GB' : Math.round(maxBytes / (1024 * 1024)) + ' MB'
  return new HttpError(413, 'File troppo grande (massimo ' + text + ')', 'too_large')
}

/**
 * Receive a request body into tmp/. Resolves { tmp, hash, size, head }.
 * @param {import('node:http').IncomingMessage} req
 * @param {object} opts
 * @param {string} opts.tmpDir
 * @param {number} opts.maxBytes
 * @param {import('./disk.mjs').Disk} [opts.disk]
 */
export async function receiveUpload (req, { tmpDir, maxBytes, disk = null }) {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBytes) throw tooLargeError(maxBytes)
  const length = declared === undefined ? null : Number(declared) || 0
  const hold = disk !== null && length !== null ? disk.hold(length) : null
  try {
    return await receive(req, { tmpDir, maxBytes, disk, length, hold })
  } finally {
    if (hold !== null) hold.release()
  }
}

async function receive (req, { tmpDir, maxBytes, disk, length, hold }) {
  if (hold !== null) await disk.check(length, hold)

  const tmp = path.join(tmpDir, 'up-' + crypto.randomBytes(8).toString('hex') + '.part')
  const hash = crypto.createHash('sha256')
  const headChunks = []
  let headLength = 0
  let size = 0
  let nextDiskCheck = DISK_CHECK_EVERY

  const meter = new Transform({
    transform (chunk, encoding, callback) {
      size += chunk.length
      if (size > maxBytes) {
        callback(tooLargeError(maxBytes))
        return
      }
      hash.update(chunk)
      if (hold !== null) hold.bytes = Math.max(0, length - size)
      if (headLength < HEAD_BYTES) {
        const part = chunk.subarray(0, HEAD_BYTES - headLength)
        headChunks.push(part)
        headLength += part.length
      }
      if (disk !== null && size >= nextDiskCheck) {
        nextDiskCheck = size + DISK_CHECK_EVERY
        // What arrived is on the disk already: is there still room above the floor
        // for what is still to come?
        disk.check(hold !== null ? hold.bytes : 0, hold).then(() => callback(null, chunk), (err) => callback(err))
        return
      }
      callback(null, chunk)
    }
  })

  // flush: fsync before close, so a track in db.json never points at a file whose
  // bytes were still only in the page cache when power went away.
  const file = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: true })
  // The request is piped by hand, not put in the pipeline: a pipeline destroys
  // its source on error, and destroying the request kills the socket before the
  // 413 can be sent. A client that goes away still has to stop the pipeline.
  const onclose = () => {
    if (!req.complete) meter.destroy(new HttpError(400, 'Caricamento interrotto'))
  }
  req.on('close', onclose)
  req.pipe(meter)
  try {
    await pipeline(meter, file)
    if (!file.closed) await once(file, 'close') // Windows cannot rename an open file
  } catch (err) {
    req.unpipe(meter)
    if (!file.closed) await once(file, 'close').catch(() => {})
    await unlinkQuietAsync(tmp)
    if (err instanceof HttpError) throw err
    if (err && err.code === 'ENOSPC') throw apiError('disk_full')
    throw new HttpError(400, 'Caricamento interrotto')
  } finally {
    req.off('close', onclose)
  }

  if (size === 0) {
    await unlinkQuietAsync(tmp)
    throw new HttpError(400, 'File vuoto')
  }
  return { tmp, hash: hash.digest('hex').slice(0, 24), size, head: Buffer.concat(headChunks) }
}
