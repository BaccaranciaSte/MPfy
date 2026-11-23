// A tiny event emitter, so transport/ does not depend on Node's 'events' module
// (the same files must load on Bare, inside the Android worklet).

export class Emitter {
  constructor () {
    this._listeners = new Map()
  }

  on (name, fn) {
    let list = this._listeners.get(name)
    if (!list) {
      list = []
      this._listeners.set(name, list)
    }
    list.push(fn)
    return this
  }

  off (name, fn) {
    const list = this._listeners.get(name)
    if (!list) return this
    const i = list.indexOf(fn)
    if (i !== -1) list.splice(i, 1)
    if (list.length === 0) this._listeners.delete(name)
    return this
  }

  once (name, fn) {
    const wrapper = (...args) => {
      this.off(name, wrapper)
      fn(...args)
    }
    return this.on(name, wrapper)
  }

  emit (name, ...args) {
    const list = this._listeners.get(name)
    if (!list) return false
    // Copy: a listener may remove itself while we iterate.
    for (const fn of list.slice()) fn(...args)
    return true
  }
}
