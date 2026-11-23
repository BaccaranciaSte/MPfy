// Running ffmpeg (MPFY_FFMPEG, default "ffmpeg" on PATH).
//
// - On Linux every job runs as `nice -n 19 <ffmpeg> ...`: the lowest priority, so
//   the phone (and the fleet node next to it) never notices it.
// - A command ending in .js, .mjs or .cjs is a Node script run with this Node (the
//   tests use a fake ffmpeg written in JavaScript).
// - A failure rejects with the exit code and the tail of stderr, and the full
//   command line is logged.
// - probe() tells whether ffmpeg runs at all and whether it has libopus.
//
// The runner is injectable: createMPfy({ ffmpeg }) takes either a command string
// or an object { run(args, opts) -> Promise, probe() -> Promise<{ ok, opus }> }.

import { ToolRunner, ToolError } from './tools.mjs'

const DEFAULT_TIMEOUT = 30 * 60 * 1000 // a 600 MB FLAC on the phone takes a while
const PROBE_TIMEOUT = 15000

export { ToolError as FfmpegError }

export class FfmpegRunner extends ToolRunner {
  /**
   * @param {object} [opts]
   * @param {string} [opts.command='ffmpeg']
   * @param {boolean} [opts.nice]  run under `nice -n 19` (default: on Linux)
   * @param {number} [opts.timeoutMs]
   */
  constructor ({ command = 'ffmpeg', nice = process.platform === 'linux', timeoutMs = DEFAULT_TIMEOUT } = {}) {
    super({ command, label: 'ffmpeg', nice, timeoutMs })
  }

  /**
   * Run ffmpeg with `args`. Resolves with { stdout, stderr } (each only collected
   * when asked).
   * @param {string[]} args
   * @param {object} [opts]
   * @param {boolean} [opts.lowPriority=true]
   * @param {boolean} [opts.stdout=false]  collect stdout (probe)
   * @param {boolean} [opts.stderr=false]  collect stderr (band levels)
   * @param {number} [opts.timeoutMs]
   * @param {boolean} [opts.quiet=false]  do not log a failure (probe)
   */
  run (args, opts = {}) {
    return super.run(args, { maxStdout: 1024 * 1024, ...opts })
  }

  /** Does ffmpeg run, and can it encode Opus? Never throws. */
  async probe () {
    try {
      const { stdout } = await this.run(['-hide_banner', '-encoders'], { lowPriority: false, stdout: true, timeoutMs: PROBE_TIMEOUT, quiet: true })
      return { ok: true, opus: /\blibopus\b/.test(stdout) }
    } catch {
      return { ok: false, opus: false }
    }
  }
}

/** Arguments of a transcode, exactly. */
export function transcodeArgs (input, kbps, output) {
  return [
    '-nostdin', '-v', 'error', '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', kbps + 'k',
    '-vbr', 'on', '-compression_level', '5', '-f', 'ogg', output
  ]
}

/**
 * Arguments of a cover resize: at most `px` on each side, aspect ratio kept,
 * never enlarged, one baseline JPEG frame.
 */
export function coverArgs (input, px, output) {
  return [
    '-nostdin', '-v', 'error', '-i', input,
    '-vf', "scale=w='min(" + px + ",iw)':h='min(" + px + ",ih)':force_original_aspect_ratio=decrease",
    '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-c:v', 'mjpeg', '-f', 'image2', '-update', '1', output
  ]
}

/**
 * The last 120 s of a file as mono WAV (the tail check before a replacement).
 * `-t` caps the output too: a header that lies about the length makes -sseof
 * start far from the end.
 */
export function tailArgs (input, output) {
  return ['-nostdin', '-v', 'error', '-sseof', '-120', '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-t', '120', '-f', 'wav', output]
}
