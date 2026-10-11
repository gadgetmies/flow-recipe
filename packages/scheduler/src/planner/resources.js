// Resource pools for the dispatcher (spec §3.4, §3.5, §3.9): tool instances with a clean/dirty state and bindings,
// appliances with slots and a mode, stations, holding slots. Times are seconds relative to the plan origin.

const SOIL_RANK = { none: 0, clean: 0, rinse: 1, wash: 2 }

export class ToolPool {
  /**
   * @param {object} inventory Inventory (README §4)
   * @param {Iterable<string>} neededTypes tool types referenced by the graph
   * @param {Array} diagnostics pushed to when a type is missing from the inventory
   */
  constructor(inventory, neededTypes, diagnostics = []) {
    this.instances = new Map() // type → [instance]
    const counts = new Map((inventory.tools || []).map((t) => [t.type, Math.max(0, Number(t.count) || 0)]))
    const types = new Set([...counts.keys(), ...neededTypes])
    for (const type of types) {
      let n = counts.has(type) ? counts.get(type) : 1
      if (!counts.has(type)) diagnostics.push({ code: 'TOOL_NOT_IN_INVENTORY', message: `Tool type '${type}' is not in the inventory; assuming one instance.`, tool: type })
      if (n === 0 && [...neededTypes].includes(type)) {
        diagnostics.push({ code: 'TOOL_COUNT_ZERO', message: `Inventory has zero '${type}'; assuming one instance so the plan can be built.`, tool: type })
        n = 1
      }
      const list = []
      for (let i = 1; i <= n; i++) list.push({ id: `${type}#${i}`, type, state: 'clean', dirtySince: 0, busyUntil: 0, binding: null, cleaningScheduled: false })
      this.instances.set(type, list)
    }
  }

  all(type) { return this.instances.get(type) || [] }

  /** The instance bound to `key` (an output id or carrier batch key), if any. */
  bound(type, key) {
    if (!key) return null
    return this.all(type).find((i) => i.binding === key) || null
  }

  /** A clean, unbound instance free at t. */
  freeClean(type, t) {
    return this.all(type).find((i) => i.binding === null && i.busyUntil <= t && i.state === 'clean') || null
  }

  /** A free dirty instance that nobody is cleaning yet, dirtiest-longest first. */
  dirtyCandidate(type, t) {
    const list = this.all(type).filter((i) => i.binding === null && i.busyUntil <= t && i.state !== 'clean' && !i.cleaningScheduled)
    list.sort((a, b) => a.dirtySince - b.dirtySince || a.id.localeCompare(b.id))
    return list[0] || null
  }

  /** Earliest time any instance of the type could become available (for event scheduling). */
  nextFreeTime(type, t) {
    let best = Number.POSITIVE_INFINITY
    for (const i of this.all(type)) if (i.binding === null && i.busyUntil > t) best = Math.min(best, i.busyUntil)
    return best
  }

  acquire(instance, { until, binding = null }) {
    instance.busyUntil = Math.max(instance.busyUntil, until)
    if (binding) instance.binding = binding
  }

  /** Release after use at time t; soil is the level the task leaves ('none' keeps the state). */
  release(instance, t, soil = 'rinse', { unbind = true } = {}) {
    instance.busyUntil = Math.max(instance.busyUntil, t)
    if (unbind) instance.binding = null
    if (soil && soil !== 'none' && SOIL_RANK[soil] > SOIL_RANK[instance.state]) {
      instance.state = soil
      instance.dirtySince = t
    } else if (soil && soil !== 'none' && instance.state === 'clean') {
      instance.state = soil
      instance.dirtySince = t
    }
  }

  markCleaned(instance, t) {
    instance.state = 'clean'
    instance.cleaningScheduled = false
    instance.busyUntil = Math.max(instance.busyUntil, t)
  }

  dirtyInstances() {
    const out = []
    for (const list of this.instances.values()) for (const i of list) if (i.state !== 'clean') out.push(i)
    return out
  }
}

export class AppliancePool {
  constructor(inventory) {
    this.appliances = new Map()
    for (const a of inventory.appliances || []) {
      const slots = []
      for (let i = 0; i < Math.max(1, Number(a.slots) || 1); i++) slots.push({ busyUntil: 0, holder: null })
      this.appliances.set(a.type, { type: a.type, slots, mode: null, modes: !!a.modes, modeSwitchSeconds: a.modeSwitchSeconds || 0 })
    }
  }

  has(type) { return this.appliances.has(type) }

  get(type) { return this.appliances.get(type) }

  /** A free slot at t for the given mode, or null. A mode change is only possible while every slot is idle. */
  freeSlot(type, t, mode = null) {
    const a = this.appliances.get(type)
    if (!a) return null
    if (a.modes && mode && a.mode !== mode) {
      if (a.slots.some((s) => s.busyUntil > t)) return null
      return a.slots[0]
    }
    return a.slots.find((s) => s.busyUntil <= t) || null
  }

  nextFreeTime(type, t) {
    const a = this.appliances.get(type)
    if (!a) return Number.POSITIVE_INFINITY
    let best = Number.POSITIVE_INFINITY
    for (const s of a.slots) if (s.busyUntil > t) best = Math.min(best, s.busyUntil)
    return best
  }

  acquire(type, slot, { until, holder, mode = null }) {
    const a = this.appliances.get(type)
    slot.busyUntil = Math.max(slot.busyUntil, until)
    slot.holder = holder
    if (a.modes && mode) a.mode = mode
  }

  setMode(type, mode) {
    const a = this.appliances.get(type)
    if (a) a.mode = mode
  }
}

export class StationPool {
  constructor(inventory) {
    this.stations = new Map()
    for (const s of inventory.stations || []) {
      const slots = []
      for (let i = 0; i < Math.max(1, Number(s.count) || 1); i++) slots.push({ busyUntil: 0 })
      this.stations.set(s.type, { type: s.type, slots })
    }
    for (const h of inventory.holding || []) {
      const slots = []
      for (let i = 0; i < Math.max(1, Number(h.slots) || 1); i++) slots.push({ busyUntil: 0 })
      this.stations.set(h.type, { type: h.type, slots, holding: true, keeps: h.keeps })
    }
  }

  has(type) { return this.stations.has(type) }

  freeSlot(type, t) {
    const s = this.stations.get(type)
    if (!s) return { busyUntil: 0, virtual: true }
    return s.slots.find((x) => x.busyUntil <= t) || null
  }

  nextFreeTime(type, t) {
    const s = this.stations.get(type)
    if (!s) return Number.POSITIVE_INFINITY
    let best = Number.POSITIVE_INFINITY
    for (const x of s.slots) if (x.busyUntil > t) best = Math.min(best, x.busyUntil)
    return best
  }

  acquire(slot, until) {
    if (slot.virtual) return
    slot.busyUntil = Math.max(slot.busyUntil, until)
  }
}
