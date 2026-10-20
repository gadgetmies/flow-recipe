// Adapter between the server and @flow-recipe/scheduler (ESM workspace package, loaded once with a dynamic
// import). Every scheduler call goes through here. When a function is missing (placeholder module while the
// scheduler is being implemented) the adapter logs once and the session keeps working with `plan: null`.

const { DOMParser } = require('@xmldom/xmldom');
const sessions = require('./sessions');
const recipes = require('./recipes');

const ROSTER_EVENTS = new Set(['participantJoined', 'participantLeft', 'resourceChanged', 'deadlineChanged']);
const BUSY_KINDS = new Set(['work', 'cleaning', 'setup', 'resume', 'check']);

const REQUIRED = [
  'createState',
  'plan',
  'replan',
  'applyEvent',
  'chooseInterruptTarget',
  'parseRecipe',
  'loadCatalogue',
  'defaultInventory',
  'mergeInventory',
  'validateRecipe',
];

let schedulerPromise = null;
let scheduler = null;
const warned = new Set();
let catalogueCache; // undefined = not loaded yet, null = unavailable
const recipeCache = new Map(); // recipeId -> { xml, model }
const states = new Map(); // sessionId -> { state, plan, lastRun, timer, pendingReason, interruptsSent }
let onPlan = () => {};

function configure({ onPlan: handler } = {}) {
  if (typeof handler === 'function') onPlan = handler;
}

async function init() {
  if (!schedulerPromise) {
    schedulerPromise = import('@flow-recipe/scheduler')
      .then((mod) => {
        scheduler = mod;
        const present = REQUIRED.filter((name) => typeof mod[name] === 'function');
        const missing = REQUIRED.filter((name) => typeof mod[name] !== 'function');
        console.log(`[planning] @flow-recipe/scheduler loaded (${present.length}/${REQUIRED.length} planning functions available)`);
        if (missing.length) console.warn(`[planning] scheduler placeholders, planning disabled for: ${missing.join(', ')}`);
        return mod;
      })
      .catch((error) => {
        console.warn('[planning] cannot load @flow-recipe/scheduler, running without plans:', error.message);
        scheduler = {};
        return scheduler;
      });
  }
  return schedulerPromise;
}

function fn(name) {
  const f = scheduler && scheduler[name];
  if (typeof f === 'function') return f;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[planning] ${name} is not available in @flow-recipe/scheduler; degrading gracefully`);
  }
  return null;
}

function timed(sessionId, label, work) {
  const started = process.hrtime.bigint();
  try {
    return work();
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[planning] ${sessionId} ${label} in ${ms.toFixed(1)} ms`);
  }
}

// ---- inventory helpers ----------------------------------------------------------------------------------------

function fallbackInventory() {
  return {
    tools: [],
    appliances: [],
    stations: [],
    holding: [],
    cleaning: { rinseSeconds: 20, washSeconds: 90, dishwasher: null },
  };
}

function fallbackMerge(base, overrides) {
  const out = JSON.parse(JSON.stringify(base || fallbackInventory()));
  if (!overrides || typeof overrides !== 'object') return out;
  for (const list of ['tools', 'appliances', 'stations', 'holding']) {
    if (!Array.isArray(overrides[list])) continue;
    if (!Array.isArray(out[list])) out[list] = [];
    for (const o of overrides[list]) {
      const i = out[list].findIndex((x) => x.type === o.type);
      if (i >= 0) out[list][i] = { ...out[list][i], ...o };
      else out[list].push({ ...o });
    }
  }
  if (overrides.cleaning) out.cleaning = { ...(out.cleaning || {}), ...overrides.cleaning };
  return out;
}

function defaultInventory() {
  const f = fn('defaultInventory');
  return f ? f() : fallbackInventory();
}

function mergeInventory(base, overrides) {
  const f = fn('mergeInventory');
  return f ? f(base || defaultInventory(), overrides || {}) : fallbackMerge(base, overrides);
}

// ---- catalogue and recipes ------------------------------------------------------------------------------------

function catalogue() {
  if (catalogueCache !== undefined) return catalogueCache;
  const load = fn('loadCatalogue');
  if (!load) {
    catalogueCache = null;
    return null;
  }
  try {
    catalogueCache = load(recipes.readOperations(), { DOMParser });
  } catch (error) {
    console.error('[planning] cannot load the operation catalogue:', error);
    catalogueCache = null;
  }
  return catalogueCache;
}

function recipeModel(recipeId) {
  const parse = fn('parseRecipe');
  const xml = recipes.readRecipe(recipeId);
  if (!parse || xml === null) return null;
  const cached = recipeCache.get(recipeId);
  if (cached && cached.xml === xml) return cached.model;
  const model = parse(xml, { DOMParser, id: recipeId });
  recipeCache.set(recipeId, { xml, model });
  return model;
}

// Drops the cached model of a recipe (called when a user recipe is saved or deleted).
function forgetRecipe(recipeId) {
  recipeCache.delete(recipeId);
}

function validateRecipe(xml, id) {
  const parse = fn('parseRecipe');
  const validate = fn('validateRecipe');
  if (!parse || !validate) return null;
  const model = parse(xml, { DOMParser, id });
  return validate(model, catalogue());
}

// ---- session → scheduler Session ------------------------------------------------------------------------------

function participantName(p) {
  if (p.name && p.name.trim()) return p.name.trim();
  return p.id === sessions.HOST_ID ? 'Host' : `Cook ${p.id}`;
}

function buildSession(view, { now, startTime } = {}) {
  const policy = view.policy || sessions.DEFAULT_POLICY;
  const start = startTime === undefined ? view.startTime : startTime;
  return {
    id: view.id,
    startTime: start,
    now: now === undefined ? (start === null || start === undefined ? Date.now() : start) : now,
    dishes: view.dishes.map((d) => ({
      id: d.id,
      recipeId: d.recipeId,
      recipe: recipeModel(d.recipeId),
      scale: d.scale,
      serveTime: d.serveTime,
      earlyTolerance: d.earlyTolerance,
      lateTolerance: d.lateTolerance,
    })),
    participants: view.participants
      .filter((p) => !p.isSpectator)
      .map((p) => ({
        id: p.id,
        name: participantName(p),
        availability: null,
        speed: p.profile.speed,
        capabilities: p.profile.capabilities,
        role: p.profile.role,
        targetShare: p.profile.targetShare,
        maxConcurrentTimers: p.profile.maxConcurrentTimers,
        placeholder: !!p.placeholder,
      })),
    inventory: view.inventory || defaultInventory(),
    policy,
  };
}

function finalisePlan(plan, view, mode) {
  if (!plan || typeof plan !== 'object') return null;
  const out = { ...plan };
  if (!out.mode) out.mode = mode;
  if (!(out.status === 'done' && view.status === 'running')) out.status = view.status;
  if (out.computedAt === undefined || out.computedAt === null) out.computedAt = Date.now();
  if (out.diff === undefined) out.diff = null;
  if (!Array.isArray(out.lanes)) out.lanes = [];
  if (!Array.isArray(out.dishes)) out.dishes = [];
  if (!Array.isArray(out.diagnostics)) out.diagnostics = [];
  return out;
}

function entryFor(sessionId) {
  let entry = states.get(sessionId);
  if (!entry) {
    entry = { state: null, plan: null, lastRun: 0, timer: null, pendingReason: null, interruptsSent: new Set() };
    states.set(sessionId, entry);
  }
  return entry;
}

function persist(sessionId, entry, plan) {
  entry.plan = plan;
  try {
    sessions.setPlan(sessionId, plan);
  } catch (error) {
    console.error(`[planning] cannot persist plan for ${sessionId}:`, error);
  }
  return plan;
}

function clearTimer(entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

// ---- public API -----------------------------------------------------------------------------------------------

function getPlan(sessionId) {
  const entry = states.get(sessionId);
  if (entry && entry.plan) return entry.plan;
  return sessions.getStoredPlan(sessionId);
}

// Offline plan from scratch (draft mode, or the base for a running session recovered after a restart).
function rebuild(sessionId) {
  const view = sessions.getSession(sessionId);
  if (!view) return null;
  const entry = entryFor(sessionId);
  clearTimer(entry);
  entry.state = null;
  const createState = fn('createState');
  const cat = catalogue();
  if (!createState || !cat) return persist(sessionId, entry, null);
  try {
    const session = buildSession(view);
    const state = timed(sessionId, 'offline plan', () => createState(session, cat));
    let plan = state && state.plan ? state.plan : null;
    const planFn = fn('plan');
    if (!plan && planFn && state && state.graph) {
      plan = timed(sessionId, 'offline plan (plan)', () =>
        planFn(state.graph, session, { previousPlan: null, frozen: null, budgetMs: session.policy.searchBudgetMs })
      );
      state.plan = plan;
    }
    entry.state = state;
    entry.lastRun = Date.now();
    entry.interruptsSent = new Set();
    return persist(sessionId, entry, finalisePlan(plan, view, 'offline'));
  } catch (error) {
    console.error(`[planning] offline plan failed for ${sessionId}:`, error);
    return persist(sessionId, entry, null);
  }
}

function runReplan(sessionId, entry, now, reason) {
  const replan = fn('replan');
  const view = sessions.getSession(sessionId);
  if (!replan || !entry.state || !view) return null;
  entry.lastRun = now;
  entry.pendingReason = null;
  try {
    const result = timed(sessionId, `replan (${reason || 'scheduled'})`, () => replan(entry.state, now));
    if (result && result.state) entry.state = result.state;
    const plan = finalisePlan(result && result.plan ? result.plan : entry.state.plan, view, 'online');
    if (plan && result && result.diff !== undefined && plan.diff === null) plan.diff = result.diff;
    if (plan) entry.interruptsSent = new Set([...entry.interruptsSent].filter((uuid) => planHasAppointment(plan, uuid)));
    return persist(sessionId, entry, plan);
  } catch (error) {
    console.error(`[planning] replan failed for ${sessionId}:`, error);
    return null;
  }
}

function planHasAppointment(plan, uuid) {
  return plan.lanes.some((lane) => (lane.items || []).some((item) => item.uuid === uuid));
}

function scheduleReplan(sessionId, entry, now, reason) {
  const policy = (entry.state && entry.state.session && entry.state.session.policy) || sessions.DEFAULT_POLICY;
  const debounceMs = Math.max(0, (policy.replanDebounceSeconds || 0) * 1000);
  const elapsed = now - entry.lastRun;
  if (elapsed >= debounceMs) {
    clearTimer(entry);
    return runReplan(sessionId, entry, now, reason);
  }
  entry.pendingReason = reason;
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const plan = runReplan(sessionId, entry, Date.now(), entry.pendingReason || reason);
      if (plan) onPlan(sessionId, plan);
    }, debounceMs - elapsed);
    if (entry.timer.unref) entry.timer.unref();
  }
  return null;
}

// Makes sure an in-memory State exists for a running session (replaying the event log after a server restart).
function ensureOnlineState(sessionId) {
  const existing = states.get(sessionId);
  if (existing && existing.state) return existing;
  const view = sessions.getSession(sessionId);
  if (!view) return null;
  if (view.status !== 'running') {
    rebuild(sessionId);
    return states.get(sessionId);
  }
  const createState = fn('createState');
  const applyFn = fn('applyEvent');
  const cat = catalogue();
  const entry = entryFor(sessionId);
  if (!createState || !cat) {
    persist(sessionId, entry, null);
    return entry;
  }
  try {
    const now = Date.now();
    const session = buildSession(view, { now, startTime: view.startTime });
    entry.state = timed(sessionId, 'recover state', () => createState(session, cat));
    if (applyFn) {
      for (const event of sessions.getEvents(sessionId)) {
        const result = applyFn(entry.state, event);
        if (result && result.state) entry.state = result.state;
      }
    }
    entry.lastRun = 0;
    const plan = runReplan(sessionId, entry, now, 'recovered');
    if (!plan) persist(sessionId, entry, finalisePlan(entry.state.plan, view, 'online'));
  } catch (error) {
    console.error(`[planning] cannot recover state for ${sessionId}:`, error);
    entry.state = null;
    persist(sessionId, entry, null);
  }
  return entry;
}

// Host pressed Start: the session is already 'running' in the DB with startTime = now and placeholders removed.
function start(sessionId, now) {
  const view = sessions.getSession(sessionId);
  if (!view) return null;
  let entry = states.get(sessionId);
  if (!entry || !entry.state) {
    rebuild(sessionId);
    entry = states.get(sessionId);
  }
  if (!entry || !entry.state) return entry ? entry.plan : null;
  try {
    entry.state.session = buildSession(view, { now, startTime: now });
    const applyFn = fn('applyEvent');
    if (applyFn) {
      const result = applyFn(entry.state, { type: 'sessionStarted', at: now });
      if (result && result.state) entry.state = result.state;
    }
    entry.lastRun = 0;
    const plan = runReplan(sessionId, entry, now, 'sessionStarted');
    if (plan) return plan;
    return persist(sessionId, entry, finalisePlan(entry.state.plan, view, 'online'));
  } catch (error) {
    console.error(`[planning] start failed for ${sessionId}:`, error);
    return persist(sessionId, entry, null);
  }
}

// Applies one event; returns the new plan when a re-plan ran immediately, else null (a debounced re-plan is
// delivered through the `onPlan` callback).
function applyEvent(sessionId, event) {
  const entry = ensureOnlineState(sessionId);
  if (!entry || !entry.state) return null;
  const applyFn = fn('applyEvent');
  if (!applyFn) return null;
  try {
    if (ROSTER_EVENTS.has(event.type)) {
      const view = sessions.getSession(sessionId);
      if (view) entry.state.session = buildSession(view, { now: event.at, startTime: view.startTime });
    }
    const result = timed(sessionId, `applyEvent ${event.type}`, () => applyFn(entry.state, event));
    if (result && result.state) entry.state = result.state;
    const needed = result ? result.replanNeeded : false;
    if (!needed) return null;
    return scheduleReplan(sessionId, entry, event.at || Date.now(), result.reason || event.type);
  } catch (error) {
    console.error(`[planning] applyEvent failed for ${sessionId}:`, error);
    return null;
  }
}

// ---- interrupts (spec §6.3) ----------------------------------------------------------------------------------

function appointmentOpensAt(item) {
  if (item.window && Number.isFinite(item.window.earliest)) return item.window.earliest;
  if (item.timer && Number.isFinite(item.timer.firesAt)) return item.timer.firesAt;
  return item.start;
}

function holderIsFree(lane, appointment, now) {
  const opensAt = appointmentOpensAt(appointment);
  return !(lane.items || []).some((item) => {
    if (item === appointment || item.uuid === appointment.uuid) return false;
    if (!BUSY_KINDS.has(item.kind) || item.status === 'done') return false;
    const current = item.status === 'started' || item.status === 'paused' ? false : item.start <= now;
    const active = item.status === 'started' || current;
    return active && item.end > opensAt;
  });
}

function fallbackTarget(sessionId, excluded) {
  const view = sessions.getSession(sessionId);
  if (!view) return null;
  const candidates = view.participants.filter((p) => !p.isSpectator && !p.placeholder && p.connected && !excluded.has(p.id));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.id === sessions.HOST_ID) - (b.id === sessions.HOST_ID));
  return { participantId: candidates[0].id, cost: null, preempts: null };
}

function findAppointment(entry, uuid) {
  if (!entry || !entry.plan) return null;
  for (const lane of entry.plan.lanes) {
    const item = (lane.items || []).find((i) => i.uuid === uuid);
    if (item) return { lane, item };
  }
  return null;
}

function chooseTarget(sessionId, entry, item, now, excluded) {
  const choose = fn('chooseInterruptTarget');
  if (choose && entry.state) {
    try {
      const target = choose(entry.state, item, now, { exclude: [...excluded] });
      if (target && target.participantId && !excluded.has(target.participantId)) return target;
    } catch (error) {
      console.error(`[planning] chooseInterruptTarget failed for ${sessionId}:`, error);
    }
  }
  return fallbackTarget(sessionId, excluded);
}

function toInterrupt(item, lane, target) {
  return {
    participantId: target.participantId,
    appointmentUuid: item.uuid,
    title: item.title,
    instructions: item.instructions,
    preempts: target.preempts === undefined ? null : target.preempts,
    deadline: appointmentOpensAt(item),
    holderId: lane.participantId,
  };
}

// Returns the interrupts to send now: appointments opening within lead + reaction whose holder is busy.
function checkInterrupts(sessionId, now) {
  const entry = states.get(sessionId);
  if (!entry || !entry.plan || entry.plan.mode !== 'online') return [];
  const policy = (entry.state && entry.state.session && entry.state.session.policy) || sessions.DEFAULT_POLICY;
  const lookahead = ((policy.leadSeconds || 0) + (policy.reactionSeconds || 0)) * 1000;
  const out = [];
  for (const lane of entry.plan.lanes) {
    for (const item of lane.items || []) {
      if (item.kind !== 'appointment' || item.status === 'done') continue;
      if (entry.interruptsSent.has(item.uuid)) continue;
      const opensAt = appointmentOpensAt(item);
      if (!Number.isFinite(opensAt) || opensAt - lookahead > now) continue;
      if (Number.isFinite(item.end) && now > item.end + 60000) continue;
      if (holderIsFree(lane, item, now)) continue;
      const target = chooseTarget(sessionId, entry, item, now, new Set());
      if (!target) continue;
      entry.interruptsSent.add(item.uuid);
      out.push(toInterrupt(item, lane, target));
    }
  }
  return out;
}

// Escalation after an acknowledgement timeout: next candidate excluding the ones already tried, or null.
function nextInterruptTarget(sessionId, appointmentUuid, excluded, now = Date.now()) {
  const entry = states.get(sessionId);
  const found = findAppointment(entry, appointmentUuid);
  if (!found) return null;
  const target = chooseTarget(sessionId, entry, found.item, now, excluded);
  return target ? toInterrupt(found.item, found.lane, target) : null;
}

function drop(sessionId) {
  const entry = states.get(sessionId);
  if (entry) clearTimer(entry);
  states.delete(sessionId);
}

function shutdown() {
  for (const sessionId of [...states.keys()]) drop(sessionId);
}

module.exports = {
  init,
  configure,
  defaultInventory,
  mergeInventory,
  validateRecipe,
  forgetRecipe,
  getPlan,
  rebuild,
  start,
  applyEvent,
  checkInterrupts,
  nextInterruptTarget,
  drop,
  shutdown,
};
