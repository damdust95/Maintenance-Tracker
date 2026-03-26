var { Pool } = require("pg");

var pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.indexOf("localhost") < 0 ? { rejectUnauthorized: false } : false
});

async function initDB() {
  var client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        filler TEXT NOT NULL,
        equipment_id TEXT,
        issue TEXT,
        resolution TEXT,
        start_time BIGINT,
        stop_time BIGINT,
        duration_min INTEGER,
        date TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        work_order TEXT,
        time_edit_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS event_parts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        part_number TEXT,
        qty INTEGER DEFAULT 1,
        part_type TEXT
      );

      CREATE TABLE IF NOT EXISTS parts_catalog (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        part_number TEXT,
        description TEXT,
        supplier TEXT,
        location TEXT,
        photo_filename TEXT,
        part_type TEXT,
        usage_count INTEGER DEFAULT 0,
        last_used TEXT,
        date_added TEXT DEFAULT CURRENT_DATE::TEXT
      );

      CREATE TABLE IF NOT EXISTS part_fillers (
        part_id TEXT NOT NULL REFERENCES parts_catalog(id) ON DELETE CASCADE,
        filler TEXT NOT NULL,
        PRIMARY KEY (part_id, filler)
      );

      CREATE TABLE IF NOT EXISTS part_equipment (
        part_id TEXT NOT NULL REFERENCES parts_catalog(id) ON DELETE CASCADE,
        equipment TEXT NOT NULL,
        PRIMARY KEY (part_id, equipment)
      );

      CREATE TABLE IF NOT EXISTS equipment (
        name TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS timers (
        filler TEXT PRIMARY KEY,
        running BOOLEAN DEFAULT FALSE,
        start_time BIGINT,
        started_by TEXT
      );

      CREATE TABLE IF NOT EXISTS technicians (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        shift TEXT DEFAULT '1st',
        password TEXT DEFAULT '987654'
      );

      CREATE TABLE IF NOT EXISTS event_techs (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        tech_id TEXT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
        PRIMARY KEY (event_id, tech_id)
      );

      CREATE TABLE IF NOT EXISTS timer_techs (
        filler TEXT NOT NULL,
        tech_id TEXT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
        PRIMARY KEY (filler, tech_id)
      );

      CREATE TABLE IF NOT EXISTS part_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS event_photos (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        caption TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details TEXT,
        performed_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
      CREATE INDEX IF NOT EXISTS idx_events_filler ON events(filler);
      CREATE INDEX IF NOT EXISTS idx_event_parts_event ON event_parts(event_id);
      CREATE INDEX IF NOT EXISTS idx_event_photos_event ON event_photos(event_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    `);

    // Add password column if not exists
    try { await client.query("ALTER TABLE technicians ADD COLUMN password TEXT DEFAULT '987654'"); } catch(e) {}
    // Add break_status column if not exists (null = working, 'lunch', 'break')
    try { await client.query("ALTER TABLE technicians ADD COLUMN break_status TEXT"); } catch(e) {}
    // Add started_by to timers if not exists
    try { await client.query("ALTER TABLE timers ADD COLUMN started_by TEXT"); } catch(e) {}
    // Add started_by to events if not exists
    try { await client.query("ALTER TABLE events ADD COLUMN started_by TEXT"); } catch(e) {}

    // Seed default part types if empty
    var ptCount = await client.query("SELECT COUNT(*) as c FROM part_types");
    if (parseInt(ptCount.rows[0].c) === 0) {
      var defaults = ["Sensor","Cable","Motor","Gearbox","Belt","Bearing","Valve","Cylinder","Pump","Filter","Relay","Contactor","VFD","Fuse","Seal","Gasket","Sprocket","Chain","Coupling","Other"];
      for (var i = 0; i < defaults.length; i++) {
        var pid = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
        await client.query("INSERT INTO part_types (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [pid, defaults[i]]);
      }
    }

    // Seed default technicians if empty (2nd shift only for now, password 987654)
    var tcCount = await client.query("SELECT COUNT(*) as c FROM technicians");
    if (parseInt(tcCount.rows[0].c) === 0) {
      var techs = [
        ["J. BULLARD","1st"],["J. CLARK","1st"],["J. HUCKS","1st"],["J. JACOBS","1st"],
        ["K. MCLELLAN","1st"],["M. SIMMONS","1st"],["R. KELLY","1st"],
        ["D. POIRIER","2nd"],["F. LEWIS","2nd"],["J. FISHBACH","2nd"],
        ["J. GONZALEZ","2nd"],["M. MORGAN","2nd"],
        ["B. DIMERY","3rd"],["D. SMITH","3rd"],["J. EVERITTE","3rd"],["R. LOWERY","3rd"]
      ];
      for (var j = 0; j < techs.length; j++) {
        var tid = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
        await client.query("INSERT INTO technicians (id, name, shift, password) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [tid, techs[j][0], techs[j][1], "987654"]);
      }
    }

    console.log("Database initialized successfully");
  } finally {
    client.release();
  }
}

module.exports = { pool: pool, initDB: initDB };
