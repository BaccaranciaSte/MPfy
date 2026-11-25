// Our fixes to dependencies, applied at every install (npm ci on the phone too): patches/<name>@<version>.patch,
// a unified diff against that exact version. A hunk is applied where its text is found once; a file
// that already has it is left (a second install changes nothing); a version that differs, or a hunk
// that is neither there nor applied, stops the install, so a dependency bump never loses a fix in silence.
//
// hyperdht@6.36.0: with the phone and the source behind the same public address (home Wi-Fi), the LAN
// shortcut's stream was destroyed by a holepunch giving up about 1 ms before its first packet came:
// half of the first connections failed. Ported from Marvento's patch for 6.33.0.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The hunks of a unified diff by file: [{ file, from, to }], from and to as text. */
export function hunksOf (patch) {
  const out = []
  let file = null
  let cur = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).trim().replace(/^b\//, '')
      continue
    }
    if (line.startsWith('--- ')) continue
    if (line.startsWith('@@')) {
      cur = { file, from: [], to: [] }
      out.push(cur)
      continue
    }
    if (cur === null) continue
    const c = line[0]
    const text = line.slice(1)
    if (c === ' ') {
      cur.from.push(text)
      cur.to.push(text)
    } else if (c === '-') cur.from.push(text)
    else if (c === '+') cur.to.push(text)
  }
  return out.map((h) => ({ file: h.file, from: h.from.join('\n'), to: h.to.join('\n') }))
}

/** Applies a patch to a package folder; returns how many hunks it wrote (0: all there already). */
export function applyPatch (patch, pkgDir, version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.version !== version) throw new Error(pkg.name + ' is ' + pkg.version + ', the patch is for ' + version + ': port it')
  let wrote = 0
  for (const h of hunksOf(patch)) {
    const file = path.join(pkgDir, h.file)
    const s = fs.readFileSync(file, 'utf8')
    if (s.includes(h.to)) continue
    if (s.split(h.from).length !== 2) throw new Error(pkg.name + ' ' + h.file + ': a hunk is neither there nor applicable')
    fs.writeFileSync(file, s.replace(h.from, () => h.to))
    wrote++
  }
  return wrote
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, 'patches')
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.patch')) : []) {
    const m = /^(.+)@(\d+\.\d+\.\d+)\.patch$/.exec(name)
    if (!m) throw new Error('patches/' + name + ': name it <package>@<version>.patch')
    const wrote = applyPatch(fs.readFileSync(path.join(dir, name), 'utf8'), path.join(root, 'node_modules', m[1]), m[2])
    console.log('patch ' + name + (wrote ? ': applied' : ': already there'))
  }
}
