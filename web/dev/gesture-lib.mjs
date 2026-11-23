// Gestures as people make them, for the checks of web/dev: the mock source
// (mock-server.mjs) and a headless Edge with a phone screen and touch, driven
// through the DevTools protocol. Fast flings released while the finger still
// moves, taps of a given length, double and triple taps, two fingers.
//
//   const { mock, base } = await startMock();
//   const b = await startBrowser('name');   // b.S(method, params), b.evaluate(js), b.phone(), b.go(url)
//   await b.phone(); await b.go(base + '/');
//   const c = await b.center('.shelf-row');  // { x, y } of an element, or null
//   await touchFling(b, { x: c.x, y: c.y, dx: -300, speed: 5000 });
//   await doubleTap(b, c.x, c.y, { gap: 120 });
//
// A check takes what it needs of these functions from this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.resolve(HERE, '..');
const BROWSER = process.env.MPFY_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The mock source of web/dev/mock-server.mjs on a free port: { mock, base }. */
export async function startMock(env = {}) {
  const mock = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '20', MOCK_OFFLINE_WAIT: '400', MOCK_PAIR_DELAY: '300', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('mock did not start')), 15000);
    mock.stdout.on('data', (d) => {
      buf += d;
      const m = /MOCK_PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });
  return { mock, base: `http://127.0.0.1:${port}` };
}

/** A headless Edge with its own profile in the temp folder, one page attached. */
export async function startBrowser(name) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `mpfy-gesture-${name}-`));
  const browser = spawn(
    BROWSER,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' }
  );
  let wsUrl = null;
  let version = '';
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    try {
      const [p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      const v = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
      wsUrl = v.webSocketDebuggerUrl;
      version = v.Browser;
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) throw new Error('browser did not start');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const consoleLines = [];
  const handlers = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
      return;
    }
    if (m.method && handlers.has(m.method)) for (const fn of handlers.get(m.method)) fn(m.params);
    if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  // The browser process itself: the one started here may hand over to another and exit, and
  // killing it then leaves the browser (and its renderers) running after the check.
  let browserPid = null;
  try {
    const info = await cdp('SystemInfo.getProcessInfo');
    const main = (info.processInfo || []).find((x) => x.type === 'browser');
    if (main && Number.isInteger(main.id)) browserPid = main.id;
  } catch {
    /* an engine without it: Browser.close alone */
  }
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => cdp(method, params, sessionId);
  await S('Runtime.enable');
  await S('Page.enable');
  /** Runs `expr` as the body of an async function in the page; returns its value. */
  async function evaluate(expr) {
    const r = await S('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  /** A phone: 360x780 at 3x, touch with up to 5 fingers. */
  async function phone() {
    await S('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  /** Opens a page of the app and waits until a view is in. */
  async function go(url, wait = 1500) {
    await S('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      try {
        const r = await S('Runtime.evaluate', { expression: "!!document.querySelector('#main > .view')", returnByValue: true });
        if (r.result?.value) break;
      } catch {
        /* loading */
      }
    }
    await sleep(wait);
  }
  /** The center of the first element matching `selector` (in CSS pixels), or null. */
  async function center(selector) {
    return evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  }
  async function shot(file) {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  /** Closes the browser and every process of it, at once (a script may exit right after). */
  const close = () => {
    try {
      ws.send(JSON.stringify({ id: ++seq, method: 'Browser.close' }));
    } catch {}
    for (const pid of [browserPid, browser.pid].filter(Boolean)) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000 });
        else process.kill(pid, 'SIGKILL');
      } catch {}
    }
    try {
      ws.close();
    } catch {}
    try {
      browser.kill();
    } catch {}
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  return { S, evaluate, phone, go, center, shot, close, errors, consoleLines, version, on };
}

/**
 * A touch drag of (dx, dy) px at `speed` px/s, released while still moving so
 * the browser starts a fling. Returns the release time (ms, performance.now()).
 */
export async function touchFling(b, { x, y, dx = 0, dy = 0, speed = 4000, step = 8, hold = 0 }) {
  const dist = Math.hypot(dx, dy);
  const ux = dist ? dx / dist : 0;
  const uy = dist ? dy / dist : 0;
  await b.S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  if (hold) await sleep(hold);
  const t0 = performance.now();
  for (;;) {
    await sleep(step);
    const d = Math.min(dist, ((performance.now() - t0) / 1000) * speed);
    await b.S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + ux * d, y: y + uy * d, id: 1 }] });
    if (d >= dist) break;
  }
  await b.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return performance.now();
}

/** One tap held `hold` ms (a normal press is 60-150 ms). */
export async function tap(b, x, y, { hold = 80 } = {}) {
  await b.S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(hold);
  await b.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Two (or `count`) taps at the same place, each held `hold` ms, `gap` ms from a lift to the next
 * press. The presses go out `hold + gap` ms apart by the clock, as a finger makes them, however long
 * the page takes to handle a lift: a page busy with what the first tap opened must not stretch a
 * double tap into two taps of their own.
 */
export async function doubleTap(b, x, y, { gap = 120, hold = 60, count = 2 } = {}) {
  let next = 0;
  for (let i = 0; i < count; i++) {
    if (i) {
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
    next = performance.now() + hold + gap;
    await tap(b, x, y, { hold });
  }
}

/** Two fingers down at once, then up. */
export async function twoFingers(b, a, c, { hold = 120 } = {}) {
  await b.S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }, { x: c.x, y: c.y, id: 2 }] });
  await sleep(hold);
  await b.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Collects lines and writes them to `file` in one go. */
export function logger(file) {
  const out = [];
  const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const flush = () => fs.writeFileSync(file, out.join('\n') + '\n');
  return { log, flush, out };
}
