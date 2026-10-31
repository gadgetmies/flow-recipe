const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.FLOW_DB_PATH || path.join(__dirname, 'database.sqlite');
let db = null;

// Schema per API.md "Database". Legacy columns (scale, mise_en_place, session_started, recipe_name) stay on
// sessions for old clients during the transition; new code reads status/dishes.
const EXPECTED_SCHEMAS = {
  sessions: `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  start_time INTEGER,
  inventory_json TEXT,
  policy_json TEXT,
  plan_json TEXT,
  scale REAL DEFAULT 1,
  mise_en_place BOOLEAN DEFAULT 0,
  session_started BOOLEAN DEFAULT 0,
  recipe_name TEXT
)`,
  dishes: `CREATE TABLE IF NOT EXISTS dishes (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  scale REAL NOT NULL DEFAULT 1,
  serve_time INTEGER NOT NULL,
  early_tolerance INTEGER NOT NULL DEFAULT 0,
  late_tolerance INTEGER NOT NULL DEFAULT 300000,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`,
  participants: `CREATE TABLE IF NOT EXISTS participants (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  socket_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL,
  is_spectator BOOLEAN NOT NULL DEFAULT 1,
  connected BOOLEAN NOT NULL DEFAULT 0,
  placeholder BOOLEAN NOT NULL DEFAULT 0,
  profile_json TEXT,
  PRIMARY KEY (session_id, participant_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`,
  events: `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  participant_id TEXT,
  type TEXT NOT NULL,
  uuid TEXT,
  units REAL,
  payload_json TEXT,
  at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
)`,
};

// Tables holding user data that must survive a reset of the session tables above. Each one is checked on its own:
// a missing table is created, a changed schema is migrated by copying the columns both versions share.
const PRESERVED_SCHEMAS = {
  user_recipes: `CREATE TABLE IF NOT EXISTS user_recipes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  xml TEXT NOT NULL,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  // "Import with Claude" handoff requests (services/claudeImports.js); epoch ms.
  import_requests: `CREATE TABLE IF NOT EXISTS import_requests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  url TEXT,
  text TEXT,
  precision_scale INTEGER NOT NULL DEFAULT 0,
  servings REAL,
  notes TEXT,
  xml TEXT,
  result_json TEXT,
  recipe_id TEXT
)`,
};

function normalizeSchema(sql) {
  if (!sql) return '';
  // SQLite stores the statement without "IF NOT EXISTS", so compare without it.
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
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
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS dishes;
      DROP TABLE IF EXISTS participants;
      DROP TABLE IF EXISTS sessions;
    `);
  }

  for (const [tableName, expectedSchema] of Object.entries(PRESERVED_SCHEMAS)) {
    migratePreservedTable(tableName, expectedSchema);
  }

  const createTablesSql = Object.values(EXPECTED_SCHEMAS).join(';\n\n') + ';';

  db.exec(createTablesSql + `

    CREATE INDEX IF NOT EXISTS idx_dishes_session ON dishes(session_id);
    CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
    CREATE INDEX IF NOT EXISTS idx_participants_socket ON participants(socket_id);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_help_requests_session ON help_requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_import_requests_status ON import_requests(status, created_at);
  `);

  console.log(`Database initialized (${dbPath})`);
}

function migratePreservedTable(tableName, expectedSchema) {
  const actualTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
  if (!actualTable) {
    db.exec(expectedSchema);
    return;
  }
  if (normalizeSchema(actualTable.sql) === normalizeSchema(expectedSchema)) return;

  console.log(`Schema of ${tableName} changed, migrating its rows...`);
  const oldColumns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
  const backup = `${tableName}_migrating`;
  const migrate = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${backup}; ALTER TABLE ${tableName} RENAME TO ${backup};`);
    db.exec(expectedSchema);
    const newColumns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
    const shared = newColumns.filter((c) => oldColumns.includes(c));
    if (shared.length) {
      const list = shared.join(', ');
      db.exec(`INSERT INTO ${tableName} (${list}) SELECT ${list} FROM ${backup}`);
    }
    db.exec(`DROP TABLE ${backup}`);
  });
  try {
    migrate();
  } catch (error) {
    // The transaction rolled back: the old table and its rows are kept untouched.
    console.error(`Cannot migrate ${tableName}, keeping the old table:`, error.message);
  }
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  EXPECTED_SCHEMAS,
  PRESERVED_SCHEMAS,
  initDatabase,
  getDatabase,
  closeDatabase,
  dbPath,
};
