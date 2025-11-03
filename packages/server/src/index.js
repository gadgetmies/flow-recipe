const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { initDatabase, getDatabase } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

initDatabase();
const db = getDatabase();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinSession', async ({ sessionId, participantId, name }) => {
    console.log('joinSession', { sessionId, participantId, name })
    try {
      socket.join(sessionId);

      db.prepare(
        `INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)`
      ).run(sessionId, new Date().toISOString());

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

      io.to(sessionId).emit('helpRequests', helpRequests);

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

