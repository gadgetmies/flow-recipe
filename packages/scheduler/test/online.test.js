import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createState, applyEvent, replan, chooseInterruptTarget, dueInterrupts, diffPlans } from '../src/online/index.js'
import { defaultInventory } from '../src/inventory.js'
import { cakeGraph } from './fixtures/cake.graph.js'

const here = dirname(fileURLToPath(import.meta.url))
const SERVE = Date.UTC(2026, 9, 11, 18, 0, 0)

function cakeSession(participants = [{ id: '0', name: 'Host' }, { id: 'p2', name: 'Bea' }]) {
  return {
    id: 's', startTime: null, now: null,
    dishes: [{ id: 'cake', recipeId: 'cake', recipe: null, scale: 1, serveTime: SERVE }],
    participants, inventory: defaultInventory(), policy: {},
  }
}
const items = (plan) => plan.lanes.flatMap((l) => l.items)
const find = (state, uuid) => items(state.plan).find((it) => it.uuid === uuid)
const laneOf = (state, pid) => state.plan.lanes.find((l) => l.participantId === pid)

/** A state that is running: draft → sessionStarted at the draft's start → first online re-plan. */
function runningCakeState() {
  const s0 = createState(cakeSession(), null, { graph: cakeGraph(SERVE) })
  const t0 = s0.plan.startTime
  const started = applyEvent(s0, { type: 'sessionStarted', at: t0 })
  return { state: replan(started.state, t0).state, t0 }
}

/** Test helper: patch an item in place on a deep copy of the plan (crafting scenarios the events would produce). */
function withItem(state, uuid, patch) {
  const plan = JSON.parse(JSON.stringify(state.plan))
  for (const lane of plan.lanes) lane.items = lane.items.map((it) => (it.uuid === uuid ? { ...it, ...patch } : it))
  return { ...state, plan }
}

test('createState yields an offline draft plan with a graph and an empty event log', () => {
  const state = createState(cakeSession(), null, { graph: cakeGraph(SERVE) })
  assert.equal(state.plan.mode, 'offline')
  assert.equal(state.plan.status, 'draft')
  assert.equal(state.plan.lanes.length, 2)
  assert.deepEqual(state.events, [])
  assert.ok(state.graph.tasks['cake:bake'])
  assert.ok(items(state.plan).every((it) => it.status === 'planned'))
  assert.throws(() => createState(cakeSession(), null), /catalogue|buildGraph/)
})

test('sessionStarted sets startTime, status running and mode online, and forces a re-plan', () => {
  const s0 = createState(cakeSession(), null, { graph: cakeGraph(SERVE) })
  const at = s0.plan.startTime + 30_000
  const r = applyEvent(s0, { type: 'sessionStarted', at })
  assert.equal(r.replanNeeded, true)
  assert.equal(r.state.session.startTime, at)
  assert.equal(r.state.plan.status, 'running')
  assert.equal(r.state.plan.mode, 'online')
  assert.equal(r.state.events.length, 1)
  assert.equal(s0.session.startTime, null, 'input state is not mutated')
  const rp = replan(r.state, at)
  assert.equal(rp.plan.mode, 'online')
  assert.equal(rp.plan.status, 'running')
  assert.equal(rp.plan.startTime, at)
  assert.ok(!rp.plan.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK'), JSON.stringify(rp.plan.diagnostics))
  for (const id of Object.keys(s0.graph.tasks)) if (s0.graph.tasks[id].kind !== 'sink') assert.ok(items(rp.plan).some((it) => it.taskId === id), `item for ${id}`)
})

test('taskStarted on time needs no re-plan and records the actual start', () => {
  const { state } = runningCakeState()
  const flour = find(state, 'cake:measure-flour')
  const r = applyEvent(state, { type: 'taskStarted', at: flour.start + 20_000, participantId: flour.participantId, uuid: 'cake:measure-flour' })
  assert.equal(r.replanNeeded, false)
  const it = find(r.state, 'cake:measure-flour')
  assert.equal(it.status, 'started')
  assert.equal(it.actualStart, flour.start + 20_000)
  assert.equal(it.participantId, flour.participantId)
  assert.equal(find(state, 'cake:measure-flour').status, 'planned', 'previous state untouched')
  // started 5 minutes late: beyond the 90 s threshold
  const late = applyEvent(state, { type: 'taskStarted', at: flour.start + 300_000, participantId: flour.participantId, uuid: 'cake:measure-flour' })
  assert.equal(late.replanNeeded, true)
  assert.match(late.reason, /late/)
})

test('taskDone 10 min late on the mix triggers a re-plan that shifts the bake and reports a diff', () => {
  let { state } = runningCakeState()
  const apply = (ev) => { const r = applyEvent(state, ev); state = r.state; return r }
  for (const uuid of ['cake:measure-flour', 'cake:measure-sugar', 'cake:preheat']) {
    const it = find(state, uuid)
    apply({ type: 'taskStarted', at: it.start, participantId: it.participantId, uuid })
    assert.equal(apply({ type: 'taskDone', at: it.end, participantId: it.participantId, uuid }).replanNeeded, false)
  }
  const mix = find(state, 'cake:mix')
  apply({ type: 'taskStarted', at: mix.start, participantId: mix.participantId, uuid: 'cake:mix' })
  const bakeBefore = find(state, 'cake:bake')
  const lateAt = mix.end + 600_000
  const done = apply({ type: 'taskDone', at: lateAt, participantId: mix.participantId, uuid: 'cake:mix' })
  assert.equal(done.replanNeeded, true)
  assert.match(done.reason, /late/)
  const rp = replan(state, lateAt)
  const bakeAfter = find(rp.state, 'cake:bake')
  assert.ok(bakeAfter.start >= lateAt, 'bake starts after the late mix')
  assert.ok(bakeAfter.start - bakeBefore.start >= 300_000, `bake shifted later by ${(bakeAfter.start - bakeBefore.start) / 1000} s`)
  assert.ok(rp.diff.length > 0, 'diff non-empty')
  const laneDiff = rp.diff.find((d) => d.participantId === bakeAfter.participantId || d.participantId === bakeBefore.participantId)
  assert.ok(laneDiff && laneDiff.changes.some((c) => c.uuid === 'cake:bake'), JSON.stringify(rp.diff))
  assert.ok(laneDiff.changes.every((c) => typeof c.reason === 'string' && c.reason.length > 0))
  assert.equal(rp.plan.diff, rp.diff)
  // done items are carried over with their actuals
  for (const uuid of ['cake:measure-flour', 'cake:measure-sugar', 'cake:preheat', 'cake:mix']) {
    const it = find(rp.state, uuid)
    assert.equal(it.status, 'done', uuid)
    assert.ok(it.actualStart > 0 && it.actualEnd > it.actualStart, `${uuid} actuals`)
  }
  assert.equal(find(rp.state, 'cake:mix').actualEnd, lateAt)
  assert.ok(!rp.plan.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK'), JSON.stringify(rp.plan.diagnostics))
  // the oven appointment still has exactly one holder after the re-plan
  const takeOut = items(rp.plan).filter((it) => it.taskId === 'cake:take-out')
  assert.equal(takeOut.length, 1)
  assert.equal(takeOut[0].kind, 'appointment')
  assert.equal(takeOut[0].start, bakeAfter.passiveUntil)
})

test('taskStarted by the other participant moves the item to their lane and asks for a re-plan', () => {
  const { state } = runningCakeState()
  const mix = find(state, 'cake:mix')
  const other = state.plan.lanes.map((l) => l.participantId).find((id) => id !== mix.participantId)
  const r = applyEvent(state, { type: 'taskStarted', at: mix.start, participantId: other, uuid: 'cake:mix' })
  assert.equal(r.replanNeeded, true)
  assert.match(r.reason, new RegExp(other))
  const moved = find(r.state, 'cake:mix')
  assert.equal(moved.participantId, other)
  assert.equal(moved.status, 'started')
  assert.ok(laneOf(r.state, other).items.some((it) => it.uuid === 'cake:mix'))
  assert.ok(!laneOf(r.state, mix.participantId).items.some((it) => it.uuid === 'cake:mix'))
  const rp = replan(r.state, mix.start + 60_000)
  const after = find(rp.state, 'cake:mix')
  assert.equal(after.participantId, other, 'in-progress work is never reassigned by a re-plan')
  assert.equal(after.status, 'started')
})

test('taskDone without a start infers actualStart = at − planned active duration', () => {
  const { state } = runningCakeState()
  const sugar = find(state, 'cake:measure-sugar')
  const plannedActive = sugar.end - sugar.start
  const at = sugar.end + 10_000
  const r = applyEvent(state, { type: 'taskDone', at, participantId: sugar.participantId, uuid: 'cake:measure-sugar' })
  const it = find(r.state, 'cake:measure-sugar')
  assert.equal(it.status, 'done')
  assert.equal(it.actualEnd, at)
  assert.equal(it.actualStart, at - plannedActive)
  assert.equal(r.replanNeeded, false)
})

test('taskDone on the bake restarts its timer and shifts the take-out appointment with it', () => {
  const { state } = runningCakeState()
  const bake = find(state, 'cake:bake')
  const passive = bake.passiveUntil - bake.end
  const at = bake.end + 60_000
  const r = applyEvent(state, { type: 'taskDone', at, participantId: bake.participantId, uuid: 'cake:bake' })
  const b = find(r.state, 'cake:bake')
  assert.equal(b.passiveUntil, at + passive)
  assert.equal(b.timer.firesAt, at + passive)
  const takeOut = find(r.state, 'cake:take-out')
  assert.equal(takeOut.start, at + passive)
  assert.equal(takeOut.window.earliest, at + passive)
})

test('interrupt chooser: busy holder on a never-preemptible item → the other cook is chosen with preempts; both stuck → broadcast', () => {
  let { state } = runningCakeState()
  const takeOut = find(state, 'cake:take-out')
  const holder = takeOut.participantId
  const other = state.plan.lanes.map((l) => l.participantId).find((id) => id !== holder)
  const now = takeOut.window.earliest - 20_000
  const holderItem = laneOf(state, holder).items.find((it) => it.kind === 'work')
  const otherItem = laneOf(state, other).items.find((it) => it.kind === 'work')
  // holder free → holder handles it, nothing to preempt
  assert.deepEqual(chooseInterruptTarget(state, takeOut, now), { participantId: holder, cost: 0, preempts: null })
  assert.deepEqual(dueInterrupts(state, now), [])
  state = withItem(state, holderItem.uuid, { status: 'started', actualStart: now - 10_000, start: now - 10_000, end: now + 600_000, preemptible: 'never', urgency: null })
  state = withItem(state, otherItem.uuid, { status: 'started', actualStart: now - 10_000, start: now - 10_000, end: now + 300_000, preemptible: 'units', urgency: null })
  const choice = chooseInterruptTarget(state, takeOut, now)
  assert.equal(choice.participantId, other)
  assert.equal(choice.preempts, otherItem.uuid)
  assert.ok(Number.isFinite(choice.cost) && choice.cost > 0)
  const due = dueInterrupts(state, now)
  assert.equal(due.length, 1)
  assert.equal(due[0].uuid, takeOut.uuid)
  assert.equal(due[0].holder, holder)
  assert.deepEqual(due[0].target, choice)
  assert.deepEqual(dueInterrupts(state, now - 10 * 60_000), [], 'not due yet ten minutes before the window')
  // both on critical / never items → broadcast
  const stuck = withItem(state, otherItem.uuid, { urgency: 'critical' })
  const bc = chooseInterruptTarget(stuck, takeOut, now)
  assert.equal(bc.participantId, null)
  assert.equal(bc.broadcast, true)
  assert.equal(bc.preempts, null)
})

test('taskPaused records remaining work as a resume item that the re-plan places after the appointment', () => {
  let { state } = runningCakeState()
  const mix = find(state, 'cake:mix')
  let r = applyEvent(state, { type: 'taskStarted', at: mix.start, participantId: mix.participantId, uuid: 'cake:mix' })
  state = r.state
  const pauseAt = mix.start + 120_000
  r = applyEvent(state, { type: 'taskPaused', at: pauseAt, participantId: mix.participantId, uuid: 'cake:mix' })
  assert.equal(r.replanNeeded, true)
  const paused = find(r.state, 'cake:mix')
  assert.equal(paused.status, 'paused')
  assert.equal(paused.kind, 'resume')
  assert.equal(paused.pausedAt, pauseAt)
  assert.ok(Math.abs(paused.progress.remainingActive - 180) < 1, `remaining ${paused.progress.remainingActive}`)
  const rp = replan(r.state, pauseAt)
  const resume = find(rp.state, 'cake:mix')
  assert.equal(resume.kind, 'resume')
  assert.equal(resume.status, 'paused')
  assert.ok(resume.start >= pauseAt)
  assert.ok(resume.end - resume.start >= 180_000 && resume.end - resume.start <= 260_000, `resume duration ${(resume.end - resume.start) / 1000} s`)
  assert.ok(!rp.plan.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK'), JSON.stringify(rp.plan.diagnostics))
  const resumed = applyEvent(rp.state, { type: 'taskStarted', at: resume.start, participantId: resume.participantId, uuid: 'cake:mix' })
  assert.equal(find(resumed.state, 'cake:mix').status, 'started')
  assert.equal(find(resumed.state, 'cake:mix').actualStart, mix.start, 'original start kept')
})

test('placeholder reconciliation: a joining participant takes the closest placeholder lane', () => {
  const session = cakeSession([{ id: '0', name: 'Host' }, { id: 'placeholder-1', name: 'Cook 2', placeholder: true, speed: 1 }])
  const s0 = createState(session, null, { graph: cakeGraph(SERVE) })
  assert.ok(s0.plan.lanes.some((l) => l.participantId === 'placeholder-1'))
  const r = applyEvent(s0, { type: 'participantJoined', at: s0.plan.startTime - 60_000, participantId: 'p9', payload: { id: 'p9', name: 'Nina', speed: 1 } })
  const ids = r.state.session.participants.map((p) => p.id)
  assert.ok(ids.includes('p9'))
  assert.ok(!ids.includes('placeholder-1'))
  assert.ok(!r.state.session.participants.some((p) => p.placeholder))
  assert.ok(r.state.plan.lanes.some((l) => l.participantId === 'p9'))
  assert.ok(!r.state.plan.lanes.some((l) => l.participantId === 'placeholder-1'))
  assert.ok(items(r.state.plan).every((it) => it.participantId !== 'placeholder-1'))
  assert.equal(r.replanNeeded, false, 'same profile: the lane is simply renamed')
  // a placeholder nobody takes is dropped at Start and its work goes back to the pool
  const started = applyEvent(s0, { type: 'sessionStarted', at: s0.plan.startTime })
  assert.deepEqual(started.state.session.participants.map((p) => p.id), ['0'])
  assert.match(started.reason, /placeholder-1/)
  const rp = replan(started.state, s0.plan.startTime)
  assert.deepEqual(rp.plan.lanes.map((l) => l.participantId), ['0'])
  assert.ok(items(rp.plan).some((it) => it.taskId === 'cake:mix'))
})

test('roster, deadline and resource events ask for a re-plan and update the session', () => {
  const { state, t0 } = runningCakeState()
  const left = applyEvent(state, { type: 'participantLeft', at: t0 + 60_000, participantId: 'p2' })
  assert.equal(left.replanNeeded, true)
  const p2 = left.state.session.participants.find((p) => p.id === 'p2')
  assert.deepEqual(p2.availability, [[null, t0 + 60_000]])
  const rp = replan(left.state, t0 + 60_000)
  assert.ok(laneOf(rp.state, 'p2').items.every((it) => it.status !== 'planned'), 'nothing new planned for someone who left')
  const paused = applyEvent(state, { type: 'participantPaused', at: t0 + 60_000, participantId: 'p2', payload: { durationSeconds: 300 } })
  assert.deepEqual(paused.state.session.participants.find((p) => p.id === 'p2').availability, [[null, t0 + 60_000], [t0 + 360_000, null]])
  const dl = applyEvent(state, { type: 'deadlineChanged', at: t0, payload: { dishId: 'cake', serveTime: SERVE + 600_000 } })
  assert.equal(dl.replanNeeded, true)
  assert.equal(dl.state.session.dishes[0].serveTime, SERVE + 600_000)
  assert.equal(dl.state.graph.tasks['cake:serve'].serveWindow.earliest, SERVE + 600_000)
  assert.equal(state.graph.tasks['cake:serve'].serveWindow.earliest, SERVE, 'graph copied, not mutated')
  const res = applyEvent(state, { type: 'resourceChanged', at: t0, payload: { inventory: { tools: [{ type: 'bowl', count: 1 }] } } })
  assert.equal(res.replanNeeded, true)
  assert.equal(res.state.session.inventory.tools.find((t) => t.type === 'bowl').count, 1)
  assert.throws(() => applyEvent(state, { type: 'nope', at: t0 }), /unknown event type/)
})

test('diffPlans is pure and reports participant, start and kind changes within the horizon', () => {
  const now = 1_000_000
  const mk = (uuid, participantId, start, kind = 'work', status = 'planned') => ({ uuid, taskId: uuid, kind, status, participantId, start, end: start + 60_000, title: uuid })
  const prev = { lanes: [{ participantId: 'a', items: [mk('x', 'a', now + 60_000), mk('y', 'a', now + 120_000), mk('far', 'a', now + 3_600_000)] }, { participantId: 'b', items: [] }] }
  const next = { lanes: [{ participantId: 'a', items: [mk('y', 'a', now + 300_000, 'resume'), mk('far', 'a', now + 7_200_000)] }, { participantId: 'b', items: [mk('x', 'b', now + 60_000), mk('z', 'b', now + 90_000)] }] }
  const diff = diffPlans(prev, next, now, 900, 'because')
  const flat = diff.flatMap((d) => d.changes.map((c) => `${d.participantId}:${c.uuid}:${c.field}`))
  assert.deepEqual(flat.sort(), ['a:x:participantId', 'a:y:kind', 'a:y:start', 'b:x:participantId', 'b:z:added'].sort())
  assert.ok(diff.flatMap((d) => d.changes).every((c) => c.reason === 'because'))
})

const bunsAvailable = existsSync(join(here, '..', 'src', 'graph', 'build.js')) && existsSync(join(here, 'fixtures', 'buns.model.json')) && existsSync(join(here, 'fixtures', 'catalogue.json'))
test('buns model: build the graph from the catalogue, start, run the first items and re-plan', { skip: !bunsAvailable && 'graph builder or fixtures missing' }, async () => {
  const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))
  const catalogue = load('catalogue.json')
  const serve = Date.UTC(2026, 0, 1, 18, 0, 0)
  const session = {
    id: 'buns', startTime: null, now: null,
    dishes: [{ id: 'buns', recipeId: 'buns', recipe: load('buns.model.json'), scale: 1, serveTime: serve, earlyTolerance: 0, lateTolerance: 300_000 }],
    participants: [{ id: '0', name: 'Host' }, { id: 'p2', name: 'Bea' }], inventory: defaultInventory(), policy: {},
  }
  let state = createState(session, catalogue)
  assert.equal(state.plan.mode, 'offline')
  assert.ok(Object.keys(state.graph.tasks).length > 5)
  const t0 = state.plan.startTime
  state = applyEvent(state, { type: 'sessionStarted', at: t0 }).state
  state = replan(state, t0).state
  assert.equal(state.plan.status, 'running')
  const work = (st) => items(st.plan).filter((it) => (it.kind === 'work' || it.kind === 'resume') && it.status === 'planned').sort((a, b) => a.start - b.start)
  let now = t0
  for (let i = 0; i < 3; i++) {
    const next = work(state)[0]
    if (!next) break
    now = Math.max(now, next.start)
    state = applyEvent(state, { type: 'taskStarted', at: now, participantId: next.participantId, uuid: next.uuid }).state
    now += Math.round((next.end - next.start) * 1.5) + 120_000
    const r = applyEvent(state, { type: 'taskDone', at: now, participantId: next.participantId, uuid: next.uuid })
    state = r.state
    if (r.replanNeeded) state = replan(state, now).state
    assert.equal(find(state, next.uuid).status, 'done')
  }
  assert.ok(items(state.plan).filter((it) => it.status === 'done').length >= 3)
  assert.ok(!state.plan.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK' || d.code === 'INCOMPLETE'), JSON.stringify(state.plan.diagnostics))
  assert.equal(state.events.length, 7)
})
