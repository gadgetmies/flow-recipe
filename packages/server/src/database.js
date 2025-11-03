const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
let db = null;

function initDatabase() {
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      socket_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS completed_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      task_uuid TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      UNIQUE(session_id, participant_id, task_uuid)
    );

    CREATE TABLE IF NOT EXISTS help_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      requested_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      UNIQUE(session_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
    CREATE INDEX IF NOT EXISTS idx_completed_tasks_session ON completed_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_help_requests_session ON help_requests(session_id);
  `);

  console.log('Database initialized');
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

module.exports = {
  initDatabase,
  getDatabase,
};

