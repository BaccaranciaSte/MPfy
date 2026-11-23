// Running the source's external tools (ffmpeg, fpcalc, 7-Zip).
//
// - Always spawn, never a shell; stdin ignored; killed at the timeout.
// - On Linux under `nice -n 19` (the phone and the fleet node next to it never
//   notice), and, when asked, under `prlimit --as=... --fsize=... --` (7-Zip: a
//   huge dictionary fails inside 7-Zip instead of waking the low-memory killer).
//   Without prlimit (Windows tests) the tool runs plainly.
// - A command ending in .js, .mjs or .cjs is a Node script run with this Node,
//   without nice or prlimit (the tests use fake tools written in JavaScript).
// - spawnTool() hands the child out (streamed output, a watchdog); run() collects
//   the output and rejects on a non-zero exit.

import { spawn, spawnSync } from 'node:child_process'
import { logError } from './util.mjs'

const KEEP_TAIL = 64 * 1024

export class ToolError extends Error {
  constructor (message, { code = null, signal = null, stdout = '', stderr = '', command = '' } = {}) {
    super(message)
    this.code = code
    this.signal = signal
    this.stdout = stdout
    this.stderr = stderr
    this.command = command
  }
}

function quote (arg) {
  return /^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg) ? arg : "'" + String(arg).replace(/'/g, "'\\''") + "'"
}

let prlimitChecked = null
/** Is util-linux prlimit there? (Linux only; checked once.) */
export function hasPrlimit () {
  if (prlimitChecked === null) {
    prlimitChecked = false
    if (process.platform === 'linux') {
      try {
        prlimitChecked = spawnSync('prlimit', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0
      } catch {}
    }
  }
  return prlimitChecked
}

export class ToolRunner {
  /**
   * @param {object} opts
   * @param {string} opts.command
   * @param {string} [opts.label]  name in the logs
   * @param {boolean} [opts.nice]  under `nice -n 19` (default: on Linux)
   * @param {string[]|null} [opts.limits]  prlimit options, e.g. ['--as=536870912']
   * @param {object|null} [opts.env]  extra environment variables
   * @param {number} [opts.timeoutMs]
   */
  constructor ({ command, label = 'tool', nice = process.platform === 'linux', limits = null, env = null, timeoutMs = 120000 } = {}) {
    this.command = command
    this.label = label
    this.nice = nice
    this.limits = limits
    this.env = env
    this.timeoutMs = timeoutMs
    this._children = new Set()
    this._closed = false
  }

  _spawnArgs (args, { lowPriority = true } = {}) {
    // A test fake: run with this Node, plainly.
    if (/\.(c|m)?js$/i.test(this.command)) return { file: process.execPath, argv: [this.command, ...args] }
    let file = this.command
    let argv = args
    if (lowPriority && this.limits && hasPrlimit()) {
      argv = [...this.limits, '--', file, ...argv]
      file = 'prlimit'
    }
    if (lowPriority && this.nice) {
      argv = ['-n', '19', file, ...argv]
      file = 'nice'
    }
    return { file, argv }
  }

  /** The command line a job runs (for logs and tests). */
  commandLine (args, opts) {
    const { file, argv } = this._spawnArgs(args, opts)
    return [file, ...argv].map(quote).join(' ')
  }

  /**
   * Start the tool. Returns { child, done, command, kill }: `done` resolves with
   * { code, signal } when it exits (never rejects; a spawn error gives code null
   * and `error`). `kill()` kills it (its whole process group when detached).
   */
  spawnTool (args, { lowPriority = true, detached = false, stdout = 'pipe', stderr = 'pipe' } = {}) {
    const { file, argv } = this._spawnArgs(args, { lowPriority })
    const command = this.commandLine(args, { lowPriority })
    const env = this.env ? { ...process.env, ...this.env } : process.env
    let child
    try {
      child = spawn(file, argv, { stdio: ['ignore', stdout, stderr], windowsHide: true, detached, env })
    } catch (err) {
      return { child: null, command, kill () {}, done: Promise.resolve({ code: null, signal: null, error: err }) }
    }
    this._children.add(child)
    const done = new Promise((resolve) => {
      let settled = false
      child.on('error', (err) => {
        if (settled) return
        settled = true
        this._children.delete(child)
        resolve({ code: null, signal: null, error: err })
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        this._children.delete(child)
        resolve({ code, signal, error: null })
      })
    })
    const kill = () => killChild(child, detached)
    return { child, done, command, kill }
  }

  /**
   * Run to the end. Resolves { stdout, stderr, code } on exit 0 (or an exit
   * `okExit` accepts); rejects with a ToolError otherwise.
   * @param {string[]} args
   * @param {object} [opts]
   * @param {boolean} [opts.stdout=false]  collect stdout (up to maxStdout)
   * @param {boolean} [opts.stderr=false]  collect stderr (its tail)
   * @param {number} [opts.maxStdout]
   * @param {(code: number) => boolean} [opts.okExit]
   */
  run (args, { lowPriority = true, stdout = false, stderr = false, maxStdout = 8 * 1024 * 1024, timeoutMs = this.timeoutMs, quiet = false, okExit = (c) => c === 0, detached = false, signal = null } = {}) {
    if (this._closed) return Promise.reject(new ToolError('runner closed'))
    if (signal !== null && signal.aborted) return Promise.reject(new ToolError('stopped'))
    const t = this.spawnTool(args, { lowPriority, detached, stdout: stdout ? 'pipe' : 'ignore' })
    const { child, command } = t
    const stop = stopOn(signal, t)
    let out = ''
    let err = ''
    let outBytes = 0
    if (child !== null) {
      child.stderr.on('data', (d) => {
        err += d.toString('utf8')
        if (err.length > KEEP_TAIL * 2) err = err.slice(-KEEP_TAIL)
      })
      if (stdout) {
        child.stdout.on('data', (d) => {
          outBytes += d.length
          if (outBytes <= maxStdout) out += d.toString('utf8')
          else t.kill()
        })
      }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      t.kill()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    return t.done.then(({ code, signal, error }) => {
      clearTimeout(timer)
      stop.off()
      if (err.length > KEEP_TAIL) err = err.slice(-KEEP_TAIL)
      let failure = null
      if (stop.done) failure = new ToolError('stopped', { code, signal, command })
      else if (error) failure = new ToolError('could not start: ' + error.message, { command, stderr: err })
      else if (timedOut) failure = new ToolError('timeout after ' + Math.round(timeoutMs / 1000) + ' s', { code, signal, stdout: out, stderr: err, command })
      else if (outBytes > maxStdout) failure = new ToolError('too much output', { code, signal, stdout: out, stderr: err, command })
      else if (code === null || !okExit(code)) failure = new ToolError('exit ' + (code === null ? 'signal ' + signal : 'code ' + code), { code, signal, stdout: out, stderr: err, command })
      if (failure) {
        if (!quiet && !this._closed && !stop.done) logError(this.label + ' failed: ' + failure.message + '\n  command: ' + command + (err ? '\n  stderr: ' + err.trim().slice(-2000) : ''))
        throw failure
      }
      return { stdout: out, stderr: stderr ? err : '', code }
    })
  }

  /**
   * Run to the end, handing stdout to `onChunk` as it arrives (never buffered
   * whole). Resolves { stderr, code } on exit 0; rejects with a ToolError on a
   * failure, a timeout, more than `maxBytes` of stdout or an onChunk that throws
   * (the tool is killed in those cases).
   */
  stream (args, onChunk, { lowPriority = true, timeoutMs = this.timeoutMs, maxBytes = Infinity, quiet = false, okExit = (c) => c === 0, signal = null } = {}) {
    if (this._closed) return Promise.reject(new ToolError('runner closed'))
    if (signal !== null && signal.aborted) return Promise.reject(new ToolError('stopped'))
    const t = this.spawnTool(args, { lowPriority })
    const { child, command } = t
    const stop = stopOn(signal, t)
    let err = ''
    let outBytes = 0
    let broken = null
    if (child !== null) {
      child.stderr.on('data', (d) => {
        err += d.toString('utf8')
        if (err.length > KEEP_TAIL * 2) err = err.slice(-KEEP_TAIL)
      })
      child.stdout.on('data', (d) => {
        if (broken !== null) return
        outBytes += d.length
        if (outBytes > maxBytes) {
          broken = 'too much output'
          t.kill()
          return
        }
        try {
          onChunk(d)
        } catch (e) {
          broken = 'output not usable: ' + e.message
          t.kill()
        }
      })
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      t.kill()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    return t.done.then(({ code, signal, error }) => {
      clearTimeout(timer)
      stop.off()
      if (err.length > KEEP_TAIL) err = err.slice(-KEEP_TAIL)
      let failure = null
      if (stop.done) failure = new ToolError('stopped', { code, signal, command })
      else if (error) failure = new ToolError('could not start: ' + error.message, { command, stderr: err })
      else if (timedOut) failure = new ToolError('timeout after ' + Math.round(timeoutMs / 1000) + ' s', { code, signal, stderr: err, command })
      else if (broken !== null) failure = new ToolError(broken, { code, signal, stderr: err, command })
      else if (code === null || !okExit(code)) failure = new ToolError('exit ' + (code === null ? 'signal ' + signal : 'code ' + code), { code, signal, stderr: err, command })
      if (failure) {
        if (!quiet && !this._closed && !stop.done) logError(this.label + ' failed: ' + failure.message + '\n  command: ' + command + (err ? '\n  stderr: ' + err.trim().slice(-2000) : ''))
        throw failure
      }
      return { stderr: err, code }
    })
  }

  /** Kill whatever runs (server shutdown). */
  close () {
    this._closed = true
    for (const child of this._children) killChild(child, false)
    this._children.clear()
  }
}

// An AbortSignal that kills the tool: `done` once it did, `off()` when the tool ended.
function stopOn (signal, t) {
  const state = { done: false, off () {} }
  if (signal === null) return state
  const onAbort = () => {
    state.done = true
    t.kill()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  state.off = () => signal.removeEventListener('abort', onAbort)
  return state
}

export function killChild (child, group) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (group && process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {}
  }
  try { child.kill('SIGKILL') } catch {}
}
