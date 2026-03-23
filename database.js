var Database = require("better-sqlite3");
var path = require("path");

var DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "tracker.db");

function initDB() {
  // Ensure data directory exists
  var fs = require("fs");
  var dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  var db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      filler TEXT NOT NULL,
      equipment_id TEXT,
      issue TEXT,
      resolution TEXT,
      start_time INTEGER,
      stop_time INTEGER,
      duration_min INTEGER,
      date TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_parts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      part_number TEXT,
      qty INTEGER DEFAULT 1,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS parts_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      part_number TEXT,
      description TEXT,
      supplier TEXT,
      location TEXT,
      photo_filename TEXT,
      usage_count INTEGER DEFAULT 0,
      last_used TEXT,
      date_added TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS part_fillers (
      part_id TEXT NOT NULL,
      filler TEXT NOT NULL,
      PRIMARY KEY (part_id, filler),
      FOREIGN KEY (part_id) REFERENCES parts_catalog(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS part_equipment (
      part_id TEXT NOT NULL,
      equipment TEXT NOT NULL,
      PRIMARY KEY (part_id, equipment),
      FOREIGN KEY (part_id) REFERENCES parts_catalog(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS equipment (
      name TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS timers (
      filler TEXT PRIMARY KEY,
      running INTEGER DEFAULT 0,
      start_time INTEGER
    );

    CREATE TABLE IF NOT EXISTS technicians (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS event_techs (
      event_id TEXT NOT NULL,
      tech_id TEXT NOT NULL,
      PRIMARY KEY (event_id, tech_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (tech_id) REFERENCES technicians(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS timer_techs (
      filler TEXT NOT NULL,
      tech_id TEXT NOT NULL,
      PRIMARY KEY (filler, tech_id),
      FOREIGN KEY (filler) REFERENCES timers(filler) ON DELETE CASCADE,
      FOREIGN KEY (tech_id) REFERENCES technicians(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS part_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS event_photos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      caption TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS idx_events_filler ON events(filler);
    CREATE INDEX IF NOT EXISTS idx_event_parts_event ON event_parts(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_photos_event ON event_photos(event_id);
  `);

  // Add part_type column to parts_catalog if not exists
  try { db.exec("ALTER TABLE parts_catalog ADD COLUMN part_type TEXT"); } catch(e) {}

  // Seed default part types if empty
  var count = db.prepare("SELECT COUNT(*) as c FROM part_types").get().c;
  if (count === 0) {
    var defaults = ["Sensor","Cable","Motor","Gearbox","Belt","Bearing","Valve","Cylinder","Pump","Filter","Relay","Contactor","VFD","Fuse","Seal","Gasket","Sprocket","Chain","Coupling","Other"];
    var stmt = db.prepare("INSERT OR IGNORE INTO part_types (id, name) VALUES (?, ?)");
    defaults.forEach(function(name) {
      stmt.run(Date.now().toString(36) + Math.random().toString(36).slice(2,7), name);
    });
  }

  return db;
}

module.exports = initDB;
