const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase, getDatabase } = require('./database');
const sessions = require('./services/sessions');
const recipes = require('./services/recipes');
const planning = require('./services/planning');

const app = express();
const server = http.createServer(app);

const clientUrl = process.env.CLIENT_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  'http://localhost:3000';

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [clientUrl, ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`] : [])]
  : [clientUrl, 'http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

const HOST_ID = sessions.HOST_ID;
const INTERRUPT_CHECK_MS = parseInt(process.env.FLOW_INTERRUPT_CHECK_MS || '5000', 10);
const CLIENT_EVENT_TYPES = new Set([
  'taskStarted',
  'taskDone',
  'taskPaused',
  'taskProgress',
  'appointmentAcknowledged',
  'participantPaused',
]);

// ---- REST -----------------------------------------------------------------------------------------------------

app.get('/api/recipes', (req, res) => {
  try {
    res.json(recipes.listRecipes());
  } catch (error) {
    console.error('Error listing recipes:', error);
    res.status(500).json({ error: 'Failed to list recipes' });
  }
});

app.get('/api/recipes/:id', (req, res) => {
  const id = req.params.id;
  const file = recipes.recipePath(id);
  if (!file || !fs.existsSync(file) || id === 'operations') {
    return res.status(404).json({ error: 'Recipe not found' });
  }
  try {
    const result = planning.validateRecipe(fs.readFileSync(file, 'utf-8'), id);
    if (result) {
      for (const message of result.errors || []) console.warn(`[recipe ${id}] error: ${message}`);
      for (const message of result.warnings || []) console.warn(`[recipe ${id}] warning: ${message}`);
    }
  } catch (error) {
    console.warn(`[recipe ${id}] validation failed:`, error.message);
  }
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(file);
});

app.get('/api/operations', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(recipes.RECIPES_DIR, 'operations.xml'));
});

app.get('/api/inventory/default', (req, res) => {
  res.json(planning.defaultInventory());
});

app.post('/api/sessions', (req, res) => {
  try {
    const { sessionId, dishes, inventory, policy, startTime } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    if (sessions.sessionExists(sessionId)) {
      return res.status(409).json({ error: 'Session already exists' });
    }

    let session;
    try {
      session = sessions.createSession({
        sessionId,
        dishes,
        inventory: planning.mergeInventory(planning.defaultInventory(), inventory || {}),
        policy,
        startTime,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const plan = planning.rebuild(sessionId);
    res.status(201).json({ session, plan });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session, plan: planning.getPlan(session.id) });
});

app.get('/api/sessions/:id/events', (req, res) => {
  if (!sessions.sessionExists(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  res.json(sessions.getEvents(req.params.id));
});

const clientBuildPath = path.join(__dirname, '../../client/build');

if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('Warning: Client build directory not found. Make sure to build the client before deploying.');
}

initDatabase();
const db = getDatabase();

// ---- broadcasting ---------------------------------------------------------------------------------------------

function participantRoom(sessionId, participantId) {
  return `${sessionId}::participant::${participantId}`;
}

function broadcastSession(sessionId) {
  const view = sessions.getSession(sessionId);
  if (!view) return null;
  io.to(sessionId).emit('session', view);
  io.to(sessionId).emit('connections', sessions.getConnections(sessionId));
  return view;
}

function broadcastPlan(sessionId, plan) {
  const current = plan === undefined ? planning.getPlan(sessionId) : plan;
  io.to(sessionId).emit('plan', current);
  if (current && current.status === 'done') {
    const view = sessions.getSession(sessionId);
    if (view && view.status === 'running') {
      sessions.setStatus(sessionId, 'done');
      stopInterruptLoop(sessionId);
      broadcastSession(sessionId);
    }
  }
}

planning.configure({
  onPlan: (sessionId, plan) => {
    broadcastPlan(sessionId, plan);
    runInterruptCheck(sessionId);
  },
});

function recordEvent(sessionId, event) {
  const stamped = sessions.appendEvent(sessionId, { ...event, at: Date.now() });
  return planning.applyEvent(sessionId, stamped);
}

// Settings changed (dishes, inventory, policy, roster): draft → offline plan; running → event + re-plan.
function afterSettingsChange(sessionId, reason, participantId) {
  const view = broadcastSession(sessionId);
  if (!view) return;
  if (view.status === 'draft') {
    broadcastPlan(sessionId, planning.rebuild(sessionId));
  } else if (view.status === 'running') {
    const event = { type: reason };
    if (participantId !== undefined) event.participantId = participantId;
    const plan = recordEvent(sessionId, event);
    broadcastPlan(sessionId, plan === null ? undefined : plan);
    runInterruptCheck(sessionId);
  }
}

// ---- interrupts (spec §6.3): per-session escalation timers ----------------------------------------------------

const interruptTimers = new Map(); // sessionId -> Map<appointmentUuid, { timer, tried, current, payload }>
const interruptLoops = new Map(); // sessionId -> interval

function sessionInterrupts(sessionId) {
  let map = interruptTimers.get(sessionId);
  if (!map) {
    map = new Map();
    interruptTimers.set(sessionId, map);
  }
  return map;
}

function clearInterrupt(sessionId, appointmentUuid) {
  const map = interruptTimers.get(sessionId);
  const record = map && map.get(appointmentUuid);
  if (record) {
    clearTimeout(record.timer);
    map.delete(appointmentUuid);
  }
}

function sendInterrupt(sessionId, interrupt, tried) {
  const view = sessions.getSession(sessionId);
  if (!view || view.status !== 'running') return;
  const { holderId, ...payload } = interrupt;
  clearInterrupt(sessionId, payload.appointmentUuid);
  io.to(participantRoom(sessionId, payload.participantId)).emit('interrupt', payload);
  console.log(`[interrupt] ${sessionId}: ${payload.appointmentUuid} → ${payload.participantId}`);
  const timeoutMs = Math.max(1000, (view.policy.ackTimeoutSeconds || 15) * 1000);
  const timer = setTimeout(() => escalateInterrupt(sessionId, payload.appointmentUuid), timeoutMs);
  if (timer.unref) timer.unref();
  sessionInterrupts(sessionId).set(payload.appointmentUuid, { timer, tried, current: payload.participantId, payload });
}

function escalateInterrupt(sessionId, appointmentUuid) {
  const map = interruptTimers.get(sessionId);
  const record = map && map.get(appointmentUuid);
  if (!record) return;
  record.tried.add(record.current);
  const next = planning.nextInterruptTarget(sessionId, appointmentUuid, record.tried);
  if (next) {
    sendInterrupt(sessionId, next, record.tried);
  } else {
    // Nobody left to ask: broadcast to everyone (spec §6.3).
    io.to(sessionId).emit('interrupt', { ...record.payload, participantId: null });
    console.log(`[interrupt] ${sessionId}: ${appointmentUuid} broadcast to everyone`);
    map.delete(appointmentUuid);
  }
}

function runInterruptCheck(sessionId) {
  try {
    for (const interrupt of planning.checkInterrupts(sessionId, Date.now())) {
      sendInterrupt(sessionId, interrupt, new Set());
    }
  } catch (error) {
    console.error(`[interrupt] check failed for ${sessionId}:`, error);
  }
}

function startInterruptLoop(sessionId) {
  if (interruptLoops.has(sessionId)) return;
  const interval = setInterval(() => runInterruptCheck(sessionId), INTERRUPT_CHECK_MS);
  if (interval.unref) interval.unref();
  interruptLoops.set(sessionId, interval);
}

function stopInterruptLoop(sessionId) {
  const interval = interruptLoops.get(sessionId);
  if (interval) {
    clearInterval(interval);
    interruptLoops.delete(sessionId);
  }
  const map = interruptTimers.get(sessionId);
  if (map) {
    for (const record of map.values()) clearTimeout(record.timer);
    interruptTimers.delete(sessionId);
  }
}

// ---- sockets --------------------------------------------------------------------------------------------------

function requireHost(socket, participantId, action) {
  if (participantId !== HOST_ID) {
    socket.emit('error', { message: `Only the host can ${action}` });
    return false;
  }
  return true;
}

function requireSelfOrHost(socket, participantId, action) {
  const self = socket.data && socket.data.participantId;
  if (self === HOST_ID || (self !== undefined && self === participantId)) return true;
  socket.emit('error', { message: `Only the participant or the host can ${action}` });
  return false;
}

function requireSession(socket, sessionId) {
  if (sessionId && sessions.sessionExists(sessionId)) return true;
  socket.emit('error', { message: 'Session not found' });
  return false;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinSession', ({ sessionId, participantId, name, isSpectator } = {}) => {
    console.log('joinSession', { sessionId, participantId, name, isSpectator });
    try {
      if (!requireSession(socket, sessionId)) return;
      if (participantId === undefined || participantId === null || participantId === '') {
        socket.emit('error', { message: 'participantId is required' });
        return;
      }
      participantId = String(participantId);

      if (socket.data.sessionId && (socket.data.sessionId !== sessionId || socket.data.participantId !== participantId)) {
        socket.leave(socket.data.sessionId);
        socket.leave(participantRoom(socket.data.sessionId, socket.data.participantId));
      }
      socket.data.sessionId = sessionId;
      socket.data.participantId = participantId;
      socket.join(sessionId);
      socket.join(participantRoom(sessionId, participantId));

      sessions.joinParticipant(sessionId, { participantId, socketId: socket.id, name, isSpectator });

      const view = broadcastSession(sessionId);
      socket.emit('helpRequests', sessions.getHelpRequests(sessionId));

      if (view.status === 'draft') {
        broadcastPlan(sessionId, planning.rebuild(sessionId));
      } else if (view.status === 'running') {
        const plan = recordEvent(sessionId, { type: 'participantJoined', participantId });
        broadcastPlan(sessionId, plan === null ? undefined : plan);
        runInterruptCheck(sessionId);
      } else {
        socket.emit('plan', planning.getPlan(sessionId));
      }

      console.log(`Participant ${participantId} joined session ${sessionId}`);
    } catch (error) {
      console.error('Error joining session:', error);
      socket.emit('error', { message: 'Failed to join session' });
    }
  });

  socket.on('updateName', ({ sessionId, participantId, name } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      sessions.updateName(sessionId, String(participantId), name);
      broadcastSession(sessionId);
    } catch (error) {
      console.error('Error updating name:', error);
    }
  });

  socket.on('updateParticipant', ({ sessionId, participantId, profile, isSpectator, name } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      participantId = String(participantId);
      if (!requireSelfOrHost(socket, participantId, 'update a participant')) return;
      const updated = sessions.updateParticipant(sessionId, participantId, { profile, isSpectator, name });
      if (!updated) {
        socket.emit('error', { message: 'Participant not found' });
        return;
      }
      afterSettingsChange(sessionId, 'resourceChanged', participantId);
    } catch (error) {
      console.error('Error updating participant:', error);
      socket.emit('error', { message: 'Failed to update participant' });
    }
  });

  socket.on('addPlaceholder', ({ sessionId, participantId, name, profile } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      if (!requireHost(socket, participantId, 'add placeholders')) return;
      const placeholder = sessions.addPlaceholder(sessionId, { name, profile });
      afterSettingsChange(sessionId, 'resourceChanged', placeholder.id);
    } catch (error) {
      console.error('Error adding placeholder:', error);
      socket.emit('error', { message: 'Failed to add placeholder' });
    }
  });

  socket.on('removePlaceholder', ({ sessionId, participantId } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      // Per API.md the payload's participantId is the placeholder id, so the host check uses the socket identity.
      if (!requireHost(socket, socket.data && socket.data.participantId, 'remove placeholders')) return;
      const target = String(participantId);
      if (!sessions.removePlaceholder(sessionId, target)) {
        socket.emit('error', { message: 'Placeholder not found' });
        return;
      }
      afterSettingsChange(sessionId, 'resourceChanged', target);
    } catch (error) {
      console.error('Error removing placeholder:', error);
      socket.emit('error', { message: 'Failed to remove placeholder' });
    }
  });

  socket.on('updateDishes', ({ sessionId, participantId, dishes } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      if (!requireHost(socket, participantId, 'update the dishes')) return;
      if (!Array.isArray(dishes) || dishes.length === 0) {
        socket.emit('error', { message: 'At least one dish is required' });
        return;
      }
      try {
        sessions.setDishes(sessionId, dishes);
      } catch (error) {
        socket.emit('error', { message: error.message });
        return;
      }
      afterSettingsChange(sessionId, 'deadlineChanged');
    } catch (error) {
      console.error('Error updating dishes:', error);
      socket.emit('error', { message: 'Failed to update dishes' });
    }
  });

  socket.on('updateInventory', ({ sessionId, participantId, inventory } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      if (!requireHost(socket, participantId, 'update the inventory')) return;
      const view = sessions.getSession(sessionId);
      const merged = planning.mergeInventory(view.inventory || planning.defaultInventory(), inventory || {});
      sessions.setInventory(sessionId, merged);
      afterSettingsChange(sessionId, 'resourceChanged');
    } catch (error) {
      console.error('Error updating inventory:', error);
      socket.emit('error', { message: 'Failed to update inventory' });
    }
  });

  socket.on('updatePolicy', ({ sessionId, participantId, policy } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      if (!requireHost(socket, participantId, 'update the policy')) return;
      sessions.setPolicy(sessionId, policy || {});
      afterSettingsChange(sessionId, 'resourceChanged');
    } catch (error) {
      console.error('Error updating policy:', error);
      socket.emit('error', { message: 'Failed to update policy' });
    }
  });

  socket.on('startSession', ({ sessionId, participantId } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      if (!requireHost(socket, participantId, 'start the session')) return;
      const view = sessions.getSession(sessionId);
      if (view.status !== 'draft') {
        socket.emit('error', { message: 'Session already started' });
        return;
      }
      const now = Date.now();
      sessions.removeAllPlaceholders(sessionId);
      sessions.setStatus(sessionId, 'running', now);
      sessions.appendEvent(sessionId, { type: 'sessionStarted', participantId: HOST_ID, at: now });
      const plan = planning.start(sessionId, now);
      broadcastSession(sessionId);
      broadcastPlan(sessionId, plan);
      startInterruptLoop(sessionId);
      runInterruptCheck(sessionId);
    } catch (error) {
      console.error('Error starting session:', error);
      socket.emit('error', { message: 'Failed to start session' });
    }
  });

  socket.on('restart', ({ sessionId, participantId } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      const hostId = participantId === undefined ? socket.data && socket.data.participantId : participantId;
      if (!requireHost(socket, hostId, 'restart the session')) return;
      stopInterruptLoop(sessionId);
      planning.drop(sessionId);
      sessions.clearEvents(sessionId);
      sessions.clearHelpRequests(sessionId);
      sessions.setStatus(sessionId, 'draft', null);
      io.to(sessionId).emit('helpRequests', []);
      broadcastSession(sessionId);
      broadcastPlan(sessionId, planning.rebuild(sessionId));
    } catch (error) {
      console.error('Error restarting session:', error);
      socket.emit('error', { message: 'Failed to restart session' });
    }
  });

  socket.on('event', (event = {}) => {
    try {
      const { sessionId, type, uuid, units, payload } = event;
      if (!requireSession(socket, sessionId)) return;
      if (!CLIENT_EVENT_TYPES.has(type)) {
        socket.emit('error', { message: `Unknown event type '${type}'` });
        return;
      }
      const participantId = String(
        event.participantId === undefined || event.participantId === null ? socket.data.participantId : event.participantId
      );
      if (!requireSelfOrHost(socket, participantId, 'report events for a participant')) return;
      const participant = sessions.getParticipant(sessionId, participantId);
      if (participant && participant.isSpectator && participantId !== HOST_ID) {
        socket.emit('error', { message: 'Spectators cannot report events' });
        return;
      }
      const view = sessions.getSession(sessionId);
      if (view.status !== 'running') {
        socket.emit('error', { message: 'Session is not running' });
        return;
      }
      const stored = { type, participantId };
      if (uuid !== undefined && uuid !== null) stored.uuid = String(uuid);
      if (units !== undefined && units !== null) stored.units = Number(units);
      if (payload !== undefined && payload !== null) stored.payload = payload;
      const plan = recordEvent(sessionId, stored);
      if (type === 'appointmentAcknowledged' && stored.uuid) clearInterrupt(sessionId, stored.uuid);
      broadcastPlan(sessionId, plan === null ? undefined : plan);
      runInterruptCheck(sessionId);
    } catch (error) {
      console.error('Error handling event:', error);
      socket.emit('error', { message: 'Failed to handle event' });
    }
  });

  socket.on('askForHelp', ({ sessionId, participantId, requested } = {}) => {
    try {
      if (!requireSession(socket, sessionId)) return;
      sessions.setHelpRequest(sessionId, String(participantId), !!requested);
      io.to(sessionId).emit('helpRequests', sessions.getHelpRequests(sessionId));
    } catch (error) {
      console.error('Error handling help request:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    try {
      const found = sessions.findBySocket(socket.id);
      if (!found) return;
      const { sessionId, participantId } = found;
      sessions.setConnected(sessionId, participantId, false);
      sessions.setHelpRequest(sessionId, participantId, false);
      io.to(sessionId).emit('helpRequests', sessions.getHelpRequests(sessionId));
      const view = broadcastSession(sessionId);
      if (view && view.status === 'running') {
        const plan = recordEvent(sessionId, { type: 'participantLeft', participantId });
        if (plan) broadcastPlan(sessionId, plan);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// ---- startup --------------------------------------------------------------------------------------------------

async function main() {
  await planning.init();

  // Mark everyone disconnected after a restart and resume interrupt checks for running sessions.
  db.prepare(`UPDATE participants SET connected = 0`).run();
  for (const row of db.prepare(`SELECT session_id FROM sessions WHERE status = 'running'`).all()) {
    startInterruptLoop(row.session_id);
  }

  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Server running on port ${server.address().port}`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
