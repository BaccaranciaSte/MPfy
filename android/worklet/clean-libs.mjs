// Removes the addon libraries bare-link wrote last time (their names carry the addon version, so
// stale ones would pile up), keeping libc++_shared.so, which comes from the NDK, not from bare-link.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const KEEP = new Set(['libc++_shared.so'])
if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    if (KEEP.has(name) || !name.endsWith('.so')) continue
    fs.rmSync(path.join(dir, name), { force: true })
    console.log('removed ' + name)
  }
}
if (!fs.existsSync(path.join(dir, 'libc++_shared.so'))) {
  console.error('libc++_shared.so is missing from ' + dir + ' (copy it from the Android NDK r30: toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so)')
  process.exit(1)
}
