// One hook owning the socket connection to the server (packages/server/API.md). With `mock: true` (the `?mock=1`
// query param) no socket is opened: the fixtures from ../mocks are served instead and the emit helpers mutate them
// locally so the whole UI can be exercised without a server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { SERVER_URL } from '../config'
import { makeSessionFixture, defaultBase, DEFAULT_PROFILE } from '../mocks/session.fixture'
import { makePlanFixture, makeDiffFixture } from '../mocks/plan.fixture'
import { laneFor, currentItem } from '../utils/plan'

// ---------- localStorage settings (v1 helpers) ----------

export const getSettings = (sessionId) => {
  try {
    return JSON.parse(window.localStorage.getItem(sessionId)) || {}
  } catch (e) {
    return {}
  }
}

export const appendSessionSettings = (sessionId, settings) => {
  try {
    window.localStorage.setItem(sessionId, JSON.stringify({ ...getSettings(sessionId), ...settings }))
  } catch (e) {
    // storage unavailable (private mode): ignore
  }
}

export const getGlobalSettings = () => {
  try {
    return JSON.parse(window.localStorage.getItem('global-settings')) || {}
  } catch (e) {
    return {}
  }
}

export const setGlobalSettings = (settings) => {
  try {
    window.localStorage.setItem('global-settings', JSON.stringify({ ...getGlobalSettings(), ...settings }))
  } catch (e) {
    // ignore
  }
}

// ---------- mock helpers ----------

const connectionsOf = (session) =>
  (session?.participants || []).map(({ id, name, isSpectator, connected, placeholder }) => ({
    id,
    name,
    isSpectator,
    connected,
    placeholder,
  }))

/** Let `participantId` join the mock session: take over the first placeholder lane or append a new participant. */
function mockJoin(session, plan, participantId, name, isSpectator) {
  if (session.participants.some((p) => p.id === participantId)) {
    return {
      session: {
        ...session,
        participants: session.participants.map((p) =>
          p.id === participantId ? { ...p, name: name || p.name, connected: true, isSpectator: !!isSpectator } : p
        ),
      },
      plan,
    }
  }
  const placeholder = session.participants.find((p) => p.placeholder)
  if (placeholder) {
    const rename = (id) => (id === placeholder.id ? participantId : id)
    return {
      session: {
        ...session,
        participants: session.participants.map((p) =>
          p.id === placeholder.id
            ? { ...p, id: participantId, name: name || p.name, placeholder: false, connected: true, isSpectator: !!isSpectator }
            : p
        ),
      },
      plan: {
        ...plan,
        lanes: plan.lanes.map((lane) => ({
          ...lane,
          participantId: rename(lane.participantId),
          items: lane.items.map((item) => ({
            ...item,
            inputsFrom: item.inputsFrom.map((h) => ({ ...h, participantId: rename(h.participantId) })),
            outputsTo: item.outputsTo.map((h) => ({ ...h, participantId: rename(h.participantId) })),
          })),
        })),
        report: {
          ...plan.report,
          loads: Object.fromEntries(Object.entries(plan.report.loads).map(([k, v]) => [rename(k), v])),
        },
      },
    }
  }
  return {
    session: {
      ...session,
      participants: [
        ...session.participants,
        { id: participantId, name: name || '', isSpectator: !!isSpectator, connected: true, placeholder: false, profile: { ...DEFAULT_PROFILE } },
      ],
    },
    plan: {
      ...plan,
      lanes: [...plan.lanes, { participantId, items: [], report: { load: 0, expectedLoad: 0, switches: 0, longestLopsidedIdle: 0, timersHeld: 0 } }],
    },
  }
}

function mockApplyEvent(plan, event, now) {
  const patch = (item) => {
    switch (event.type) {
      case 'taskStarted':
        return { ...item, status: 'started', actualStart: now }
      case 'taskDone':
        return { ...item, status: 'done', actualEnd: now, actualStart: item.actualStart || now - (item.end - item.start) }
      case 'taskPaused':
        return { ...item, status: 'paused' }
      case 'taskProgress':
        return { ...item, progress: event.units, status: item.status === 'planned' ? 'started' : item.status }
      case 'appointmentAcknowledged':
        return { ...item, status: item.status === 'planned' ? 'started' : item.status, actualStart: item.actualStart || now }
      default:
        return item
    }
  }
  return {
    ...plan,
    lanes: plan.lanes.map((lane) => ({
      ...lane,
      items: lane.items.map((item) => (item.uuid === event.uuid ? patch(item) : item)),
    })),
  }
}

// ---------- the hook ----------

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.participantId
 * @param {string} opts.name           current name (used for joinSession)
 * @param {boolean} opts.isSpectator   current participation status (used for joinSession)
 * @param {boolean} opts.enabled       false until the name is set (no join before that)
 * @param {boolean} opts.mock          serve fixtures instead of opening a socket
 * @param {object|null} opts.createIfMissing  `{ recipeId }` → POST /api/sessions before joining (host only)
 */
export default function useSession({ sessionId, participantId, name, isSpectator, enabled = true, mock = false, createIfMissing = null }) {
  const [session, setSession] = useState(null)
  const [plan, setPlan] = useState(null)
  const [connections, setConnections] = useState([])
  const [helpRequests, setHelpRequests] = useState([])
  const [interrupt, setInterrupt] = useState(null)
  const [error, setError] = useState(null)
  const [connected, setConnected] = useState(false)

  const socketRef = useRef(null)
  const nameRef = useRef(name)
  const spectatorRef = useRef(isSpectator)
  const mockBaseRef = useRef(defaultBase())
  const mockTimerRef = useRef(null)
  const createRef = useRef(createIfMissing)
  nameRef.current = name
  spectatorRef.current = isSpectator
  createRef.current = createIfMissing

  // ----- connection -----
  useEffect(() => {
    if (!enabled) return undefined

    if (mock) {
      const base = mockBaseRef.current
      const joined = mockJoin(makeSessionFixture(base), makePlanFixture(base), participantId, nameRef.current, spectatorRef.current)
      setSession(joined.session)
      setPlan(joined.plan)
      setConnections(connectionsOf(joined.session))
      setHelpRequests([])
      setInterrupt(null)
      setConnected(true)
      return () => {
        if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      }
    }

    let cancelled = false
    let socket = null

    const connect = () => {
      if (cancelled) return
      socket = io(SERVER_URL)
      socketRef.current = socket
      socket.on('connect', () => {
        setConnected(true)
        socket.emit('joinSession', {
          sessionId,
          participantId,
          name: nameRef.current || '',
          isSpectator: !!spectatorRef.current,
        })
      })
      socket.on('session', (s) => setSession(s))
      socket.on('plan', (p) => setPlan(p))
      socket.on('connections', (c) => setConnections(c || []))
      socket.on('helpRequests', (h) => setHelpRequests(Array.isArray(h) ? h : Array.from(h || [])))
      socket.on('interrupt', (i) => {
        if (i && i.participantId === participantId) setInterrupt(i)
      })
      socket.on('error', (e) => setError(e?.message || 'An error occurred'))
      socket.on('connect_error', () => setConnected(false))
      socket.on('disconnect', () => setConnected(false))
    }

    const create = createRef.current
    if (create) {
      const body = { sessionId }
      if (create.recipeId) body.dishes = [{ recipeId: create.recipeId }]
      fetch(`${SERVER_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          if (!response.ok && response.status !== 409) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || data.message || 'Failed to create session')
          }
        })
        .catch((e) => setError(e.message || 'Failed to create session'))
        .finally(connect)
    } else {
      connect()
    }

    return () => {
      cancelled = true
      if (socket) socket.disconnect()
      socketRef.current = null
    }
  }, [sessionId, participantId, enabled, mock])

  // ----- emit helpers -----
  const emit = useCallback(
    (event, payload) => {
      if (socketRef.current) socketRef.current.emit(event, { sessionId, ...payload })
    },
    [sessionId]
  )

  const updateName = useCallback(
    (newName) => {
      if (mock) {
        setSession((s) => s && { ...s, participants: s.participants.map((p) => (p.id === participantId ? { ...p, name: newName } : p)) })
        setConnections((c) => c.map((p) => (p.id === participantId ? { ...p, name: newName } : p)))
        return
      }
      emit('updateName', { participantId, name: newName })
    },
    [emit, participantId, mock]
  )

  const updateParticipant = useCallback(
    (targetId, { profile, isSpectator: spectator } = {}) => {
      if (mock) {
        setSession(
          (s) =>
            s && {
              ...s,
              participants: s.participants.map((p) =>
                p.id === targetId
                  ? { ...p, profile: { ...p.profile, ...(profile || {}) }, isSpectator: spectator === undefined ? p.isSpectator : spectator }
                  : p
              ),
            }
        )
        if (spectator !== undefined) setConnections((c) => c.map((p) => (p.id === targetId ? { ...p, isSpectator: spectator } : p)))
        return
      }
      const payload = { participantId: targetId }
      if (profile) payload.profile = profile
      if (spectator !== undefined) payload.isSpectator = spectator
      emit('updateParticipant', payload)
    },
    [emit, mock]
  )

  const addPlaceholder = useCallback(
    ({ name: placeholderName, profile } = {}) => {
      if (mock) {
        setSession((s) => {
          if (!s) return s
          const n = s.participants.filter((p) => p.id.startsWith('placeholder-')).length + 1
          const id = `placeholder-${n}`
          setPlan((p) => p && { ...p, lanes: [...p.lanes, { participantId: id, items: [], report: { load: 0, expectedLoad: 0, switches: 0, longestLopsidedIdle: 0, timersHeld: 0 } }] })
          return {
            ...s,
            participants: [
              ...s.participants,
              { id, name: placeholderName || `Cook ${s.participants.length + 1}`, isSpectator: false, connected: false, placeholder: true, profile: { ...DEFAULT_PROFILE, ...(profile || {}) } },
            ],
          }
        })
        return
      }
      emit('addPlaceholder', { participantId, name: placeholderName, profile })
    },
    [emit, participantId, mock]
  )

  const removePlaceholder = useCallback(
    (placeholderId) => {
      if (mock) {
        setSession((s) => s && { ...s, participants: s.participants.filter((p) => p.id !== placeholderId) })
        setPlan((p) => p && { ...p, lanes: p.lanes.filter((l) => l.participantId !== placeholderId) })
        return
      }
      emit('removePlaceholder', { participantId: placeholderId })
    },
    [emit, mock]
  )

  const updateDishes = useCallback(
    (dishes) => {
      if (mock) {
        setSession(
          (s) =>
            s && {
              ...s,
              dishes: dishes.map((d, i) => ({
                id: d.id || `${d.recipeId}-${i}`,
                recipeId: d.recipeId,
                title: d.title || s.dishes.find((x) => x.recipeId === d.recipeId)?.title || d.recipeId,
                scale: d.scale ?? 1,
                serveTime: d.serveTime,
                earlyTolerance: d.earlyTolerance ?? 0,
                lateTolerance: d.lateTolerance ?? 300_000,
              })),
            }
        )
        return
      }
      emit('updateDishes', { participantId, dishes })
    },
    [emit, participantId, mock]
  )

  const updateInventory = useCallback(
    (inventory) => {
      if (mock) {
        setSession((s) => {
          if (!s) return s
          const merged = { ...s.inventory }
          for (const list of ['tools', 'appliances', 'stations', 'holding']) {
            if (!inventory[list]) continue
            merged[list] = [...(merged[list] || [])]
            for (const o of inventory[list]) {
              const i = merged[list].findIndex((x) => x.type === o.type)
              if (i >= 0) merged[list][i] = { ...merged[list][i], ...o }
              else merged[list].push({ ...o })
            }
          }
          if (inventory.cleaning) merged.cleaning = { ...merged.cleaning, ...inventory.cleaning }
          return { ...s, inventory: merged }
        })
        return
      }
      emit('updateInventory', { participantId, inventory })
    },
    [emit, participantId, mock]
  )

  const updatePolicy = useCallback(
    (policy) => {
      if (mock) {
        setSession((s) => s && { ...s, policy: { ...s.policy, ...policy, weights: { ...s.policy.weights, ...(policy.weights || {}) } } })
        return
      }
      emit('updatePolicy', { participantId, policy })
    },
    [emit, participantId, mock]
  )

  const startSession = useCallback(() => {
    if (mock) {
      const now = Date.now()
      setSession((s) => s && { ...s, status: 'running', startTime: now })
      setPlan((p) => p && { ...p, status: 'running', mode: 'online', computedAt: now, now, diff: makeDiffFixture(mockBaseRef.current) })
      if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      mockTimerRef.current = setTimeout(() => {
        setPlan((p) => {
          if (!p) return p
          const mine = currentItem(laneFor(p, participantId))
          setInterrupt({
            participantId,
            appointmentUuid: 'buns:bake#b1@done',
            title: 'Take sheet 1 out of the oven',
            instructions: 'The buns on sheet 1 are done. Take the sheet out with the towel and put it on the counter.',
            preempts: mine && mine.kind !== 'appointment' ? mine.uuid : null,
            deadline: Date.now() + 15_000,
          })
          return p
        })
      }, 20_000)
      return
    }
    emit('startSession', { participantId })
  }, [emit, participantId, mock])

  const restart = useCallback(() => {
    if (mock) {
      if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      const base = mockBaseRef.current
      const joined = mockJoin(makeSessionFixture(base), makePlanFixture(base), participantId, nameRef.current, spectatorRef.current)
      setSession(joined.session)
      setPlan(joined.plan)
      setConnections(connectionsOf(joined.session))
      setInterrupt(null)
      setHelpRequests([])
      return
    }
    emit('restart', {})
  }, [emit, participantId, mock])

  /** Emit a task event. `extra` may hold `units` and `payload`; `actAs` lets the host act for another participant. */
  const sendEvent = useCallback(
    (type, uuid, extra = {}) => {
      const { actAs, ...rest } = extra
      const event = { type, participantId: actAs || participantId, uuid, ...rest }
      if (mock) {
        setPlan((p) => p && mockApplyEvent(p, event, Date.now()))
        if (type === 'appointmentAcknowledged') {
          setInterrupt((i) => {
            if (i && i.preempts) setPlan((p) => p && mockApplyEvent(p, { type: 'taskPaused', uuid: i.preempts }, Date.now()))
            return null
          })
        }
        return
      }
      emit('event', event)
      if (type === 'appointmentAcknowledged') setInterrupt((i) => (i && i.appointmentUuid === uuid ? null : i))
    },
    [emit, participantId, mock]
  )

  const askForHelp = useCallback(
    (requested) => {
      if (mock) {
        setHelpRequests((h) => (requested ? Array.from(new Set([...h, participantId])) : h.filter((id) => id !== participantId)))
        return
      }
      emit('askForHelp', { participantId, requested })
    },
    [emit, participantId, mock]
  )

  const clearError = useCallback(() => setError(null), [])
  const clearInterrupt = useCallback(() => setInterrupt(null), [])

  return useMemo(
    () => ({
      session,
      plan,
      connections,
      helpRequests,
      interrupt,
      error,
      connected,
      clearError,
      clearInterrupt,
      updateName,
      updateParticipant,
      addPlaceholder,
      removePlaceholder,
      updateDishes,
      updateInventory,
      updatePolicy,
      startSession,
      restart,
      sendEvent,
      askForHelp,
    }),
    [
      session,
      plan,
      connections,
      helpRequests,
      interrupt,
      error,
      connected,
      clearError,
      clearInterrupt,
      updateName,
      updateParticipant,
      addPlaceholder,
      removePlaceholder,
      updateDishes,
      updateInventory,
      updatePolicy,
      startSession,
      restart,
      sendEvent,
      askForHelp,
    ]
  )
}
