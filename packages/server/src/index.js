const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase, getDatabase } = require('./database');

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

app.get('/api/recipes/:recipeName', (req, res) => {
  const recipeName = req.params.recipeName;
  const recipePath = path.join(__dirname, 'recipes', `${recipeName}.xml`);
  
  if (fs.existsSync(recipePath)) {
    res.setHeader('Content-Type', 'application/xml');
    res.sendFile(recipePath);
  } else {
    res.status(404).json({ error: 'Recipe not found' });
  }
});

app.post('/api/sessions', (req, res) => {
  try {
    const { sessionId, recipeName } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const recipeToStore = recipeName || 'bday-cake';
    const existingSession = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId);
    
    if (existingSession) {
      return res.status(409).json({ error: 'Session already exists' });
    }

    db.prepare(
      `INSERT INTO sessions (id, created_at, recipe_name, scale) VALUES (?, ?, ?, 1)`
    ).run(sessionId, new Date().toISOString(), recipeToStore);

    res.status(201).json({ 
      sessionId, 
      recipeName: recipeToStore,
      message: 'Session created successfully' 
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinSession', async ({ sessionId, participantId, name }) => {
    console.log('joinSession', { sessionId, participantId, name })
    try {
      const existingSession = db.prepare(`SELECT id, recipe_name FROM sessions WHERE id = ?`).get(sessionId);
      
      if (!existingSession) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      socket.join(sessionId);
      
      const sessionData = db.prepare(`SELECT recipe_name, scale FROM sessions WHERE id = ?`).get(sessionId);
      if (sessionData) {
        if (sessionData.recipe_name) {
          socket.emit('recipeName', sessionData.recipe_name);
        }
        socket.emit('scale', sessionData.scale || 1);
      }

      const participant = {
        id: participantId,
        socketId: socket.id,
        sessionId,
        name: name || '',
        joinedAt: new Date().toISOString(),
      };

      db.prepare(
        `INSERT OR REPLACE INTO participants (id, socket_id, session_id, name, joined_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        `${sessionId}-${participantId}`,
        socket.id,
        sessionId,
        name || '',
        participant.joinedAt
      );

      const participants = db
        .prepare(
          `SELECT id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at`
        )
        .all(sessionId)
        .map(extractParticipantId(sessionId));

      io.to(sessionId).emit('connections', participants);

      const completedTasks = db
        .prepare(`SELECT task_uuid FROM completed_tasks WHERE session_id = ?`)
        .all(sessionId)
        .map((row) => row.task_uuid);

      socket.emit('completedTasks', completedTasks);

      const helpRequests = db
        .prepare(
          `SELECT DISTINCT p.name FROM help_requests hr
           JOIN participants p ON hr.participant_id = p.id
           WHERE hr.session_id = ? AND hr.active = 1`
        )
        .all(sessionId)
        .map((row) => row.name);

      socket.emit('helpRequests', helpRequests);

      console.log(`Participant ${participantId} joined session ${sessionId}`);
    } catch (error) {
      console.error('Error joining session:', error);
      socket.emit('error', { message: 'Failed to join session' });
    }
  });

  socket.on('updateName', ({ sessionId, participantId, name }) => {
    try {
      db.prepare(
        `UPDATE participants SET name = ? WHERE id = ?`
      ).run(name, `${sessionId}-${participantId}`);

      const participants = db
        .prepare(
          `SELECT id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at`
        )
        .all(sessionId)
        .map((p) => {
          const [session, pid] = p.id.split('-');
          return {
            id: pid,
            name: p.name,
          };
        });

      io.to(sessionId).emit('connections', participants);
    } catch (error) {
      console.error('Error updating name:', error);
    }
  });

  socket.on('taskCompleted', ({ sessionId, participantId, taskUuid }) => {
    try {
      const participantKey = `${sessionId}-${participantId}`;
      db.prepare(
        `INSERT OR IGNORE INTO completed_tasks (session_id, participant_id, task_uuid, completed_at)
         VALUES (?, ?, ?, ?)`
      ).run(sessionId, participantKey, taskUuid, new Date().toISOString());

      const completedTasks = db
        .prepare(`SELECT DISTINCT task_uuid FROM completed_tasks WHERE session_id = ?`)
        .all(sessionId)
        .map((row) => row.task_uuid);

      io.to(sessionId).emit('completedTasks', completedTasks);
    } catch (error) {
      console.error('Error completing task:', error);
    }
  });

  socket.on('askForHelp', ({ sessionId, participantId, requested }) => {
    try {
      const participantKey = `${sessionId}-${participantId}`;
      if (requested) {
        db.prepare(
          `INSERT OR REPLACE INTO help_requests (session_id, participant_id, active, requested_at)
           VALUES (?, ?, 1, ?)`
        ).run(sessionId, participantKey, new Date().toISOString());
      } else {
        db.prepare(
          `UPDATE help_requests SET active = 0 WHERE session_id = ? AND participant_id = ?`
        ).run(sessionId, participantKey);
      }

      const helpRequests = db
        .prepare(
          `SELECT DISTINCT p.name FROM help_requests hr
           JOIN participants p ON hr.participant_id = p.id
           WHERE hr.session_id = ? AND hr.active = 1`
        )
        .all(sessionId)
        .map((row) => row.name);

      io.to(sessionId).emit('helpRequests', helpRequests);
    } catch (error) {
      console.error('Error handling help request:', error);
    }
  });

  socket.on('updateScale', ({ sessionId, participantId, scale }) => {
    try {
      if (participantId !== '0') {
        socket.emit('error', { message: 'Only the host can update the scale' });
        return;
      }

      const scaleValue = parseFloat(scale);
      if (isNaN(scaleValue) || scaleValue <= 0) {
        socket.emit('error', { message: 'Invalid scale value' });
        return;
      }

      db.prepare(`UPDATE sessions SET scale = ? WHERE id = ?`).run(scaleValue, sessionId);
      io.to(sessionId).emit('scale', scaleValue);
    } catch (error) {
      console.error('Error updating scale:', error);
      socket.emit('error', { message: 'Failed to update scale' });
    }
  });

  socket.on('restart', ({ sessionId }) => {
    try {
      db.prepare(`DELETE FROM completed_tasks WHERE session_id = ?`).run(sessionId);
      db.prepare(`UPDATE help_requests SET active = 0 WHERE session_id = ?`).run(sessionId);

      io.to(sessionId).emit('completedTasks', []);
      io.to(sessionId).emit('helpRequests', []);
    } catch (error) {
      console.error('Error restarting session:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const participant = db
      .prepare(`SELECT session_id FROM participants WHERE socket_id = ?`)
      .get(socket.id);

    if (participant) {
      db.prepare(`UPDATE help_requests SET active = 0 WHERE participant_id LIKE ?`).run(
        `%${participant.session_id}%`
      );

      const participants = db
        .prepare(
          `SELECT id, name, joined_at FROM participants WHERE session_id = ? AND socket_id != ? ORDER BY joined_at`
        )
        .all(participant.session_id, socket.id)
        .map(extractParticipantId(participant.session_id));

      io.to(participant.session_id).emit('connections', participants);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

function extractParticipantId(sessionId) {
  return (p) => {
    // The id format is `${sessionId}-${participantId}` where both ids may contain dashes.
    // To extract the participant id, remove `${sessionId}-` prefix from p.id.
    const pid = p.id.slice(sessionId.length + 1);
    return {
      id: pid,
      name: p.name,
    };
  };
}

