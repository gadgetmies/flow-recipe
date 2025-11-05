const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
let db = null;

const EXPECTED_SCHEMAS = {
  sessions: `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  recipe_name TEXT,
  scale REAL DEFAULT 1
)`,
  participants: `CREATE TABLE IF NOT EXISTS participants (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  socket_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL,
  is_spectator BOOLEAN NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, participant_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`,
  completed_tasks: `CREATE TABLE IF NOT EXISTS completed_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  task_uuid TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (session_id, participant_id) REFERENCES participants(session_id, participant_id),
  UNIQUE(session_id, participant_id, task_uuid)
)`,
  help_requests: `CREATE TABLE IF NOT EXISTS help_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1,
  requested_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (session_id, participant_id) REFERENCES participants(session_id, participant_id),
  UNIQUE(session_id, participant_id)
)`
};

function normalizeSchema(sql) {
  if (!sql) return '';
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*,\s*/g, ',')
    .trim()
    .toUpperCase();
}

function initDatabase() {
  db = new Database(dbPath);

  let schemaChanged = false;

  for (const [tableName, expectedSchema] of Object.entries(EXPECTED_SCHEMAS)) {
    const actualTable = db.prepare(`
      SELECT sql FROM sqlite_master 
      WHERE type='table' AND name=?
    `).get(tableName);

    if (!actualTable) {
      schemaChanged = true;
      break;
    }

    const normalizedExpected = normalizeSchema(expectedSchema);
    const normalizedActual = normalizeSchema(actualTable.sql);

    if (normalizedExpected !== normalizedActual) {
      schemaChanged = true;
      break;
    }
  }

  if (schemaChanged) {
    console.log('Schema changed detected, resetting all tables...');
    db.exec(`
      DROP TABLE IF EXISTS help_requests;
      DROP TABLE IF EXISTS completed_tasks;
      DROP TABLE IF EXISTS participants;
      DROP TABLE IF EXISTS sessions;
    `);
  }

  const createTablesSql = Object.values(EXPECTED_SCHEMAS).join(';\n\n') + ';';

  db.exec(createTablesSql + `

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

