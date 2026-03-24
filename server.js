var express = require("express");
var cors = require("cors");
var path = require("path");
var fs = require("fs");
var multer = require("multer");
var { pool, initDB } = require("./database");

var app = express();
var PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Photo uploads
var uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "data", "photos");
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir, { recursive: true }); }
var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) { cb(null, Date.now() + "-" + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname)); }
});
var upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });
app.use("/photos", express.static(uploadDir, { maxAge: "7d", immutable: true }));

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function logAudit(action, entityType, entityId, details, performedBy) {
  try {
    await pool.query("INSERT INTO audit_log (id,action,entity_type,entity_id,details,performed_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid(), action, entityType, entityId, details, performedBy]);
  } catch(e) { console.error("Audit log error:", e.message); }
}

// ════════════════════════════════════════
// EVENTS API
// ════════════════════════════════════════

app.get("/api/events", async function (req, res) {
  try {
    var q = req.query.date
      ? await pool.query("SELECT * FROM events WHERE date = $1 ORDER BY start_time DESC", [req.query.date])
      : await pool.query("SELECT * FROM events ORDER BY date DESC, start_time DESC");
    var events = q.rows;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var parts = await pool.query("SELECT * FROM event_parts WHERE event_id = $1", [e.id]);
      var techs = await pool.query("SELECT t.id, t.name FROM event_techs et JOIN technicians t ON et.tech_id = t.id WHERE et.event_id = $1", [e.id]);
      var photos = await pool.query("SELECT * FROM event_photos WHERE event_id = $1", [e.id]);
      e.parts = parts.rows;
      e.techs = techs.rows;
      e.photos = photos.rows;
    }
    res.json(events);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/events", async function (req, res) {
  try {
    var e = req.body;
    await pool.query(
      "INSERT INTO events (id,filler,equipment_id,issue,resolution,start_time,stop_time,duration_min,date,timestamp,work_order,started_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [e.id, e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, e.date, e.timestamp, e.workOrder || null, e.startedBy || null]
    );
    for (var i = 0; i < (e.parts || []).length; i++) {
      var p = e.parts[i];
      await pool.query("INSERT INTO event_parts (id,event_id,name,part_number,qty,part_type) VALUES ($1,$2,$3,$4,$5,$6)", [p.id, e.id, p.name, p.partNumber, p.qty || 1, p.partType || null]);
    }
    if (e.equipmentId) await pool.query("INSERT INTO equipment (name) VALUES ($1) ON CONFLICT DO NOTHING", [e.equipmentId]);
    await updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, false);
    for (var j = 0; j < (e.techIds || []).length; j++) {
      await pool.query("INSERT INTO event_techs (event_id,tech_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e.id, e.techIds[j]]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/events/:id", async function (req, res) {
  try {
    var e = req.body;
    await pool.query(
      "UPDATE events SET filler=$1,equipment_id=$2,issue=$3,resolution=$4,start_time=$5,stop_time=$6,duration_min=$7,work_order=$8,time_edit_reason=COALESCE($9,time_edit_reason),date=COALESCE($10,date) WHERE id=$11",
      [e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, e.workOrder || null, e.timeEditReason || null, e.date || null, req.params.id]
    );
    await pool.query("DELETE FROM event_parts WHERE event_id = $1", [req.params.id]);
    for (var i = 0; i < (e.parts || []).length; i++) {
      var p = e.parts[i];
      await pool.query("INSERT INTO event_parts (id,event_id,name,part_number,qty,part_type) VALUES ($1,$2,$3,$4,$5,$6)", [p.id, req.params.id, p.name, p.partNumber, p.qty || 1, p.partType || null]);
    }
    if (e.equipmentId) await pool.query("INSERT INTO equipment (name) VALUES ($1) ON CONFLICT DO NOTHING", [e.equipmentId]);
    await updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, true);
    await pool.query("DELETE FROM event_techs WHERE event_id = $1", [req.params.id]);
    for (var j = 0; j < (e.techIds || []).length; j++) {
      await pool.query("INSERT INTO event_techs (event_id,tech_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, e.techIds[j]]);
    }
    await logAudit("edit", "event", req.params.id, "Edited event on " + e.filler, e.performedBy || null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/events/:id", async function (req, res) {
  try {
    var existing = (await pool.query("SELECT filler,date FROM events WHERE id=$1", [req.params.id])).rows[0];
    var performedBy = req.body ? req.body.performedBy : null;
    await pool.query("DELETE FROM event_parts WHERE event_id = $1", [req.params.id]);
    await pool.query("DELETE FROM event_techs WHERE event_id = $1", [req.params.id]);
    await pool.query("DELETE FROM event_photos WHERE event_id = $1", [req.params.id]);
    await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
    await logAudit("delete", "event", req.params.id, "Deleted event on " + (existing ? existing.filler + " " + existing.date : "unknown"), performedBy);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// TIMERS API
// ════════════════════════════════════════

app.get("/api/timers", async function (req, res) {
  try {
    var rows = (await pool.query("SELECT * FROM timers")).rows;
    var timers = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var techs = (await pool.query("SELECT t.id,t.name FROM timer_techs tt JOIN technicians t ON tt.tech_id=t.id WHERE tt.filler=$1", [r.filler])).rows;
      timers[r.filler] = { running: !!r.running, startTime: parseInt(r.start_time), techs: techs, startedBy: r.started_by || null };
    }
    res.json(timers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/timers/:filler/start", async function (req, res) {
  try {
    var now = Date.now();
    var techIds = req.body.techIds || [];
    var startedBy = req.body.startedBy || null;
    await pool.query("INSERT INTO timers (filler,running,start_time,started_by) VALUES ($1,true,$2,$3) ON CONFLICT (filler) DO UPDATE SET running=true,start_time=$2,started_by=$3", [req.params.filler, now, startedBy]);
    await pool.query("DELETE FROM timer_techs WHERE filler = $1", [req.params.filler]);
    for (var i = 0; i < techIds.length; i++) {
      await pool.query("INSERT INTO timer_techs (filler,tech_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.filler, techIds[i]]);
    }
    res.json({ running: true, startTime: now, techIds: techIds, startedBy: startedBy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/timers/:filler/stop", async function (req, res) {
  try {
    var timer = (await pool.query("SELECT * FROM timers WHERE filler = $1", [req.params.filler])).rows[0];
    var techRows = (await pool.query("SELECT tech_id FROM timer_techs WHERE filler = $1", [req.params.filler])).rows;
    var techIds = techRows.map(function (r) { return r.tech_id; });
    await pool.query("DELETE FROM timer_techs WHERE filler = $1", [req.params.filler]);
    await pool.query("DELETE FROM timers WHERE filler = $1", [req.params.filler]);
    var now = Date.now();
    var startTime = (timer && timer.start_time) ? parseInt(timer.start_time) : now;
    if (startTime > now) startTime = now;
    if (now - startTime > 86400000) startTime = now - 3600000;
    res.json({ startTime: startTime, stopTime: now, techIds: techIds, startedBy: timer ? timer.started_by : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/timers/:filler/join", async function (req, res) {
  try {
    var techIds = req.body.techIds || [];
    for (var i = 0; i < techIds.length; i++) {
      await pool.query("INSERT INTO timer_techs (filler,tech_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.filler, techIds[i]]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/timers/:filler/leave", async function (req, res) {
  try {
    var techId = req.body.techId;
    if (!techId) return res.status(400).json({ error: "techId required" });
    await pool.query("DELETE FROM timer_techs WHERE filler=$1 AND tech_id=$2", [req.params.filler, techId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// PARTS CATALOG API
// ════════════════════════════════════════

app.get("/api/catalog", async function (req, res) {
  try {
    var parts = (await pool.query("SELECT * FROM parts_catalog ORDER BY usage_count DESC")).rows;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      p.fillersUsed = (await pool.query("SELECT filler FROM part_fillers WHERE part_id=$1", [p.id])).rows.map(function(r){return r.filler});
      p.equipmentUsed = (await pool.query("SELECT equipment FROM part_equipment WHERE part_id=$1", [p.id])).rows.map(function(r){return r.equipment});
    }
    res.json(parts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/catalog", async function (req, res) {
  try {
    var p = req.body;
    var id = p.id || uid();
    await pool.query(
      "INSERT INTO parts_catalog (id,name,part_number,description,supplier,location,photo_filename,part_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, p.name, p.partNumber||null, p.description||null, p.supplier||null, p.location||null, p.photoFilename||null, p.partType||null]
    );
    res.json({ success: true, id: id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/catalog/:id", async function (req, res) {
  try {
    var p = req.body;
    // Don't overwrite photo_filename unless explicitly provided
    if (p.photoFilename !== undefined && p.photoFilename !== null) {
      await pool.query(
        "UPDATE parts_catalog SET name=$1,part_number=$2,description=$3,supplier=$4,location=$5,photo_filename=$6,part_type=$7 WHERE id=$8",
        [p.name, p.partNumber||null, p.description||null, p.supplier||null, p.location||null, p.photoFilename, p.partType||null, req.params.id]
      );
    } else {
      await pool.query(
        "UPDATE parts_catalog SET name=$1,part_number=$2,description=$3,supplier=$4,location=$5,part_type=$6 WHERE id=$7",
        [p.name, p.partNumber||null, p.description||null, p.supplier||null, p.location||null, p.partType||null, req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/catalog/:id", async function (req, res) {
  try {
    var existing = (await pool.query("SELECT name FROM parts_catalog WHERE id=$1", [req.params.id])).rows[0];
    await pool.query("DELETE FROM part_fillers WHERE part_id=$1", [req.params.id]);
    await pool.query("DELETE FROM part_equipment WHERE part_id=$1", [req.params.id]);
    await pool.query("DELETE FROM parts_catalog WHERE id=$1", [req.params.id]);
    await logAudit("delete", "part", req.params.id, "Deleted part: " + (existing ? existing.name : "unknown"), req.body ? req.body.performedBy : null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/catalog/:id/photo", upload.single("photo"), async function (req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    await pool.query("UPDATE parts_catalog SET photo_filename=$1 WHERE id=$2", [req.file.filename, req.params.id]);
    res.json({ success: true, filename: req.file.filename });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// EQUIPMENT API
// ════════════════════════════════════════

app.get("/api/equipment", async function (req, res) {
  try {
    var rows = (await pool.query("SELECT name FROM equipment ORDER BY name")).rows;
    res.json(rows.map(function(r){return r.name}));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// TECHNICIANS API
// ════════════════════════════════════════

app.get("/api/technicians", async function (req, res) {
  try {
    var rows = (await pool.query("SELECT * FROM technicians ORDER BY shift,name")).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/technicians", async function (req, res) {
  try {
    var name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    var shift = (req.body.shift || "1st").trim();
    var password = (req.body.password || "987654").trim();
    var id = uid();
    await pool.query("INSERT INTO technicians (id,name,shift,password) VALUES ($1,$2,$3,$4)", [id, name, shift, password]);
    res.json({ success: true, id: id, name: name, shift: shift });
  } catch (err) {
    if (err.message && err.message.indexOf("unique") >= 0) return res.status(400).json({ error: "Technician already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/technicians/:id", async function (req, res) {
  try {
    var shift = (req.body.shift || "1st").trim();
    await pool.query("UPDATE technicians SET shift=$1 WHERE id=$2", [shift, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/technicians/:id", async function (req, res) {
  try {
    await pool.query("DELETE FROM event_techs WHERE tech_id=$1", [req.params.id]);
    await pool.query("DELETE FROM timer_techs WHERE tech_id=$1", [req.params.id]);
    await pool.query("DELETE FROM technicians WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// AUTH / LOGIN API
// ════════════════════════════════════════

app.post("/api/auth/login", async function (req, res) {
  try {
    var name = (req.body.name || "").trim();
    var password = (req.body.password || "").trim();
    if (!name || !password) return res.status(400).json({ error: "Name and password are required" });
    var result = await pool.query("SELECT id,name,shift FROM technicians WHERE UPPER(name)=UPPER($1) AND password=$2", [name, password]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid name or password" });
    }
    var tech = result.rows[0];
    // Only allow enabled shifts to log in (currently 2nd shift only)
    var allowedShifts = ["2nd"];
    if (allowedShifts.indexOf(tech.shift) < 0) {
      return res.status(403).json({ error: "Login not enabled for " + tech.shift + " shift yet. Contact admin." });
    }
    res.json({ success: true, id: tech.id, name: tech.name, shift: tech.shift });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/auth/change-password", async function (req, res) {
  try {
    var techId = req.body.techId;
    var oldPassword = (req.body.oldPassword || "").trim();
    var newPassword = (req.body.newPassword || "").trim();
    if (!techId || !oldPassword || !newPassword) return res.status(400).json({ error: "All fields required" });
    var check = await pool.query("SELECT id FROM technicians WHERE id=$1 AND password=$2", [techId, oldPassword]);
    if (check.rows.length === 0) return res.status(401).json({ error: "Current password is incorrect" });
    await pool.query("UPDATE technicians SET password=$1 WHERE id=$2", [newPassword, techId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// PART TYPES API
// ════════════════════════════════════════

app.get("/api/part-types", async function (req, res) {
  try {
    var rows = (await pool.query("SELECT * FROM part_types ORDER BY name")).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/part-types", async function (req, res) {
  try {
    var name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    var id = uid();
    await pool.query("INSERT INTO part_types (id,name) VALUES ($1,$2)", [id, name]);
    res.json({ success: true, id: id, name: name });
  } catch (err) {
    if (err.message && err.message.indexOf("unique") >= 0) return res.status(400).json({ error: "Part type already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/part-types/:id", async function (req, res) {
  try {
    await pool.query("DELETE FROM part_types WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// EVENT PHOTOS API
// ════════════════════════════════════════

app.post("/api/events/:id/photos", upload.array("photos", 5), async function (req, res) {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
    var photos = [];
    for (var i = 0; i < req.files.length; i++) {
      var pid = uid();
      await pool.query("INSERT INTO event_photos (id,event_id,filename) VALUES ($1,$2,$3)", [pid, req.params.id, req.files[i].filename]);
      photos.push({ id: pid, filename: req.files[i].filename });
    }
    res.json({ success: true, photos: photos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/event-photos/:id", async function (req, res) {
  try {
    var photo = (await pool.query("SELECT * FROM event_photos WHERE id=$1", [req.params.id])).rows[0];
    if (photo) {
      var filePath = path.join(uploadDir, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await pool.query("DELETE FROM event_photos WHERE id=$1", [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// HELPER: Update catalog from event parts
// ════════════════════════════════════════

async function updateCatalogFromParts(parts, filler, equipmentId, isEdit) {
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p.name || !p.name.trim()) continue;
    var name = p.name.trim();
    var partNum = (p.partNumber || "").trim();
    var partType = (p.partType || "").trim();

    var existing = (await pool.query(
      "SELECT * FROM parts_catalog WHERE LOWER(name) = LOWER($1) AND COALESCE(part_number,'') = $2", [name, partNum]
    )).rows[0];

    if (existing) {
      if (!isEdit) {
        await pool.query("UPDATE parts_catalog SET usage_count=usage_count+1, last_used=CURRENT_DATE::TEXT WHERE id=$1", [existing.id]);
      } else {
        await pool.query("UPDATE parts_catalog SET last_used=CURRENT_DATE::TEXT WHERE id=$1", [existing.id]);
      }
      if (partType && !existing.part_type) {
        await pool.query("UPDATE parts_catalog SET part_type=$1 WHERE id=$2", [partType, existing.id]);
      }
      if (filler) await pool.query("INSERT INTO part_fillers (part_id,filler) VALUES ($1,$2) ON CONFLICT DO NOTHING", [existing.id, filler]);
      if (equipmentId) await pool.query("INSERT INTO part_equipment (part_id,equipment) VALUES ($1,$2) ON CONFLICT DO NOTHING", [existing.id, equipmentId]);
    } else {
      var id = uid();
      await pool.query(
        "INSERT INTO parts_catalog (id,name,part_number,part_type,usage_count,last_used) VALUES ($1,$2,$3,$4,1,CURRENT_DATE::TEXT)",
        [id, name, partNum||null, partType||null]
      );
      if (filler) await pool.query("INSERT INTO part_fillers (part_id,filler) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, filler]);
      if (equipmentId) await pool.query("INSERT INTO part_equipment (part_id,equipment) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, equipmentId]);
    }
  }
}

// ════════════════════════════════════════
// AUDIT LOG API
// ════════════════════════════════════════

app.get("/api/audit-log", async function (req, res) {
  try {
    var limit = parseInt(req.query.limit) || 100;
    var rows = (await pool.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1", [limit])).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
// TEMPORARY: DATA MIGRATION ENDPOINT
// Remove this after migration is complete!
// ════════════════════════════════════════

app.get("/api/migrate-from-staging", async function (req, res) {
  var sourceUrl = process.env.STAGING_DATABASE_URL;
  if (!sourceUrl) return res.status(400).json({ error: "STAGING_DATABASE_URL not set. Add it as a variable on this service." });
  
  var { Pool: SrcPool } = require("pg");
  var srcPool = new SrcPool({
    connectionString: sourceUrl,
    ssl: sourceUrl.indexOf("localhost") < 0 ? { rejectUnauthorized: false } : false
  });
  
  try {
    var src = await srcPool.connect();
    var dst = await pool.connect();
    var migrated = [];
    
    // Define tables in order (respecting foreign keys)
    var tables = [
      "technicians", "equipment", "part_types", "parts_catalog",
      "events", "event_parts", "event_techs", "event_photos",
      "timers", "timer_techs", "part_fillers", "part_equipment", "audit_log"
    ];
    
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      try {
        // Check if source table has data
        var countResult = await src.query("SELECT COUNT(*) as c FROM " + table);
        var count = parseInt(countResult.rows[0].c);
        if (count === 0) { migrated.push(table + ": 0 rows (skipped)"); continue; }
        
        // Clear destination table
        await dst.query("DELETE FROM " + table);
        
        // Get all rows from source
        var rows = (await src.query("SELECT * FROM " + table)).rows;
        
        if (rows.length > 0) {
          // Build insert from column names
          var cols = Object.keys(rows[0]);
          var placeholders = cols.map(function(_, idx) { return "$" + (idx + 1); }).join(",");
          var insertSQL = "INSERT INTO " + table + " (" + cols.join(",") + ") VALUES (" + placeholders + ") ON CONFLICT DO NOTHING";
          
          for (var j = 0; j < rows.length; j++) {
            var vals = cols.map(function(c) { return rows[j][c]; });
            await dst.query(insertSQL, vals);
          }
        }
        
        migrated.push(table + ": " + rows.length + " rows copied");
      } catch (tableErr) {
        migrated.push(table + ": ERROR - " + tableErr.message);
      }
    }
    
    src.release();
    dst.release();
    await srcPool.end();
    
    res.json({ success: true, results: migrated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// SERVE FRONTEND
// ════════════════════════════════════════

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ════════════════════════════════════════
// START
// ════════════════════════════════════════

initDB().then(function () {
  app.listen(PORT, function () {
    console.log("Maintenance Tracker running on port " + PORT);
    console.log("Connected to PostgreSQL database");
  });
}).catch(function (err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
