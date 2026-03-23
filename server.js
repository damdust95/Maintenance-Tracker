var express = require("express");
var cors = require("cors");
var path = require("path");
var fs = require("fs");
var multer = require("multer");
var initDB = require("./database");

var app = express();
var PORT = process.env.PORT || 3000;

// Initialize database
var db = initDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Photo uploads
var uploadDir = path.join(__dirname, "data", "photos");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) {
    var ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Serve uploaded photos
app.use("/photos", express.static(uploadDir));

// ════════════════════════════════════════
// EVENTS API
// ════════════════════════════════════════

// GET all events (optionally filter by date)
app.get("/api/events", function (req, res) {
  try {
    var query = "SELECT * FROM events ORDER BY date DESC, start_time DESC";
    var params = [];
    if (req.query.date) {
      query = "SELECT * FROM events WHERE date = ? ORDER BY start_time DESC";
      params = [req.query.date];
    }
    var events = db.prepare(query).all.apply(db.prepare(query), params);

    // Attach parts, techs, and photos to each event
    var partsStmt = db.prepare("SELECT * FROM event_parts WHERE event_id = ?");
    var techsStmt = db.prepare("SELECT t.id, t.name FROM event_techs et JOIN technicians t ON et.tech_id = t.id WHERE et.event_id = ?");
    var photosStmt = db.prepare("SELECT * FROM event_photos WHERE event_id = ?");
    events.forEach(function (e) {
      e.parts = partsStmt.all(e.id);
      e.techs = techsStmt.all(e.id);
      e.photos = photosStmt.all(e.id);
    });

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create event
app.post("/api/events", function (req, res) {
  try {
    var e = req.body;
    db.prepare(
      "INSERT INTO events (id, filler, equipment_id, issue, resolution, start_time, stop_time, duration_min, date, timestamp, work_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(e.id, e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, e.date, e.timestamp, e.workOrder || null);

    // Insert parts
    var partStmt = db.prepare("INSERT INTO event_parts (id, event_id, name, part_number, qty, part_type) VALUES (?, ?, ?, ?, ?, ?)");
    (e.parts || []).forEach(function (p) {
      partStmt.run(p.id, e.id, p.name, p.partNumber, p.qty || 1, p.partType || null);
    });

    // Update equipment list
    if (e.equipmentId) {
      db.prepare("INSERT OR IGNORE INTO equipment (name) VALUES (?)").run(e.equipmentId);
    }

    // Update parts catalog
    updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, false);

    // Insert techs
    var techStmt = db.prepare("INSERT OR IGNORE INTO event_techs (event_id, tech_id) VALUES (?, ?)");
    (e.techIds || []).forEach(function (tid) {
      techStmt.run(e.id, tid);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update event
app.put("/api/events/:id", function (req, res) {
  try {
    var e = req.body;
    db.prepare(
      "UPDATE events SET filler=?, equipment_id=?, issue=?, resolution=?, start_time=?, stop_time=?, duration_min=?, work_order=?, time_edit_reason=COALESCE(?,time_edit_reason) WHERE id=?"
    ).run(e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, e.workOrder || null, e.timeEditReason || null, req.params.id);

    // Replace parts
    db.prepare("DELETE FROM event_parts WHERE event_id = ?").run(req.params.id);
    var partStmt = db.prepare("INSERT INTO event_parts (id, event_id, name, part_number, qty, part_type) VALUES (?, ?, ?, ?, ?, ?)");
    (e.parts || []).forEach(function (p) {
      partStmt.run(p.id, req.params.id, p.name, p.partNumber, p.qty || 1, p.partType || null);
    });

    if (e.equipmentId) {
      db.prepare("INSERT OR IGNORE INTO equipment (name) VALUES (?)").run(e.equipmentId);
    }

    updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, true);

    // Replace techs
    db.prepare("DELETE FROM event_techs WHERE event_id = ?").run(req.params.id);
    var techStmt = db.prepare("INSERT OR IGNORE INTO event_techs (event_id, tech_id) VALUES (?, ?)");
    (e.techIds || []).forEach(function (tid) {
      techStmt.run(req.params.id, tid);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE event
app.delete("/api/events/:id", function (req, res) {
  try {
    db.prepare("DELETE FROM event_parts WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// TIMERS API
// ════════════════════════════════════════

app.get("/api/timers", function (req, res) {
  try {
    var rows = db.prepare("SELECT * FROM timers").all();
    var techStmt = db.prepare("SELECT t.id, t.name FROM timer_techs tt JOIN technicians t ON tt.tech_id = t.id WHERE tt.filler = ?");
    var timers = {};
    rows.forEach(function (r) {
      timers[r.filler] = { running: !!r.running, startTime: r.start_time, techs: techStmt.all(r.filler) };
    });
    res.json(timers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timers/:filler/start", function (req, res) {
  try {
    var now = Date.now();
    var techIds = req.body.techIds || [];
    db.prepare(
      "INSERT OR REPLACE INTO timers (filler, running, start_time) VALUES (?, 1, ?)"
    ).run(req.params.filler, now);
    // Save assigned techs
    db.prepare("DELETE FROM timer_techs WHERE filler = ?").run(req.params.filler);
    var stmt = db.prepare("INSERT OR IGNORE INTO timer_techs (filler, tech_id) VALUES (?, ?)");
    techIds.forEach(function (tid) { stmt.run(req.params.filler, tid); });
    res.json({ running: true, startTime: now, techIds: techIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timers/:filler/stop", function (req, res) {
  try {
    var timer = db.prepare("SELECT * FROM timers WHERE filler = ?").get(req.params.filler);
    var techRows = db.prepare("SELECT tech_id FROM timer_techs WHERE filler = ?").all(req.params.filler);
    var techIds = techRows.map(function (r) { return r.tech_id; });
    db.prepare("DELETE FROM timer_techs WHERE filler = ?").run(req.params.filler);
    db.prepare("DELETE FROM timers WHERE filler = ?").run(req.params.filler);
    res.json({
      startTime: timer ? timer.start_time : null,
      stopTime: Date.now(),
      techIds: techIds
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timers/:filler/join", function (req, res) {
  try {
    var techIds = req.body.techIds || [];
    var stmt = db.prepare("INSERT OR IGNORE INTO timer_techs (filler, tech_id) VALUES (?, ?)");
    techIds.forEach(function (tid) { stmt.run(req.params.filler, tid); });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// PARTS CATALOG API
// ════════════════════════════════════════

app.get("/api/catalog", function (req, res) {
  try {
    var parts = db.prepare("SELECT * FROM parts_catalog ORDER BY usage_count DESC").all();
    var fillerStmt = db.prepare("SELECT filler FROM part_fillers WHERE part_id = ?");
    var eqStmt = db.prepare("SELECT equipment FROM part_equipment WHERE part_id = ?");
    parts.forEach(function (p) {
      p.fillersUsed = fillerStmt.all(p.id).map(function (r) { return r.filler; });
      p.equipmentUsed = eqStmt.all(p.id).map(function (r) { return r.equipment; });
    });
    res.json(parts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add part to catalog manually
app.post("/api/catalog", function (req, res) {
  try {
    var p = req.body;
    var id = p.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    db.prepare(
      "INSERT INTO parts_catalog (id, name, part_number, description, supplier, location, photo_filename, part_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, p.name, p.partNumber || null, p.description || null, p.supplier || null, p.location || null, p.photoFilename || null, p.partType || null);
    res.json({ success: true, id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update catalog part
app.put("/api/catalog/:id", function (req, res) {
  try {
    var p = req.body;
    db.prepare(
      "UPDATE parts_catalog SET name=?, part_number=?, description=?, supplier=?, location=?, photo_filename=?, part_type=? WHERE id=?"
    ).run(p.name, p.partNumber || null, p.description || null, p.supplier || null, p.location || null, p.photoFilename || null, p.partType || null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE catalog part
app.delete("/api/catalog/:id", function (req, res) {
  try {
    db.prepare("DELETE FROM part_fillers WHERE part_id = ?").run(req.params.id);
    db.prepare("DELETE FROM part_equipment WHERE part_id = ?").run(req.params.id);
    db.prepare("DELETE FROM parts_catalog WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upload photo for a catalog part
app.post("/api/catalog/:id/photo", upload.single("photo"), function (req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    db.prepare("UPDATE parts_catalog SET photo_filename = ? WHERE id = ?").run(req.file.filename, req.params.id);
    res.json({ success: true, filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// EQUIPMENT API
// ════════════════════════════════════════

app.get("/api/equipment", function (req, res) {
  try {
    var rows = db.prepare("SELECT name FROM equipment ORDER BY name").all();
    res.json(rows.map(function (r) { return r.name; }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// TECHNICIANS API
// ════════════════════════════════════════

app.get("/api/technicians", function (req, res) {
  try {
    var rows = db.prepare("SELECT * FROM technicians ORDER BY name").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/technicians", function (req, res) {
  try {
    var name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    db.prepare("INSERT INTO technicians (id, name) VALUES (?, ?)").run(id, name);
    res.json({ success: true, id: id, name: name });
  } catch (err) {
    if (err.message && err.message.indexOf("UNIQUE") >= 0) {
      return res.status(400).json({ error: "Technician already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/technicians/:id", function (req, res) {
  try {
    db.prepare("DELETE FROM event_techs WHERE tech_id = ?").run(req.params.id);
    db.prepare("DELETE FROM timer_techs WHERE tech_id = ?").run(req.params.id);
    db.prepare("DELETE FROM technicians WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// PART TYPES API
// ════════════════════════════════════════

app.get("/api/part-types", function (req, res) {
  try {
    var rows = db.prepare("SELECT * FROM part_types ORDER BY name").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/part-types", function (req, res) {
  try {
    var name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    db.prepare("INSERT INTO part_types (id, name) VALUES (?, ?)").run(id, name);
    res.json({ success: true, id: id, name: name });
  } catch (err) {
    if (err.message && err.message.indexOf("UNIQUE") >= 0) {
      return res.status(400).json({ error: "Part type already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/part-types/:id", function (req, res) {
  try {
    db.prepare("DELETE FROM part_types WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// EVENT PHOTOS API
// ════════════════════════════════════════

app.post("/api/events/:id/photos", upload.array("photos", 5), function (req, res) {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
    var stmt = db.prepare("INSERT INTO event_photos (id, event_id, filename, caption) VALUES (?, ?, ?, ?)");
    var photos = [];
    req.files.forEach(function (file) {
      var pid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      stmt.run(pid, req.params.id, file.filename, null);
      photos.push({ id: pid, filename: file.filename });
    });
    res.json({ success: true, photos: photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/event-photos/:id", function (req, res) {
  try {
    var photo = db.prepare("SELECT * FROM event_photos WHERE id = ?").get(req.params.id);
    if (photo) {
      var filePath = path.join(uploadDir, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.prepare("DELETE FROM event_photos WHERE id = ?").run(req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// HELPER: Update catalog from event parts
// ════════════════════════════════════════

function updateCatalogFromParts(parts, filler, equipmentId, isEdit) {
  parts.forEach(function (p) {
    if (!p.name || !p.name.trim()) return;
    var name = p.name.trim();
    var partNum = (p.partNumber || "").trim();
    var partType = (p.partType || "").trim();

    var existing = db.prepare(
      "SELECT * FROM parts_catalog WHERE LOWER(name) = LOWER(?) AND COALESCE(part_number,'') = ?"
    ).get(name, partNum);

    if (existing) {
      if (!isEdit) {
        db.prepare("UPDATE parts_catalog SET usage_count = usage_count + 1, last_used = date('now') WHERE id = ?").run(existing.id);
      } else {
        db.prepare("UPDATE parts_catalog SET last_used = date('now') WHERE id = ?").run(existing.id);
      }
      // Update part_type if it was blank and now we have one
      if (partType && !existing.part_type) {
        db.prepare("UPDATE parts_catalog SET part_type = ? WHERE id = ?").run(partType, existing.id);
      }
      if (filler) {
        db.prepare("INSERT OR IGNORE INTO part_fillers (part_id, filler) VALUES (?, ?)").run(existing.id, filler);
      }
      if (equipmentId) {
        db.prepare("INSERT OR IGNORE INTO part_equipment (part_id, equipment) VALUES (?, ?)").run(existing.id, equipmentId);
      }
    } else {
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      db.prepare(
        "INSERT INTO parts_catalog (id, name, part_number, part_type, usage_count, last_used) VALUES (?, ?, ?, ?, 1, date('now'))"
      ).run(id, name, partNum || null, partType || null);
      if (filler) {
        db.prepare("INSERT OR IGNORE INTO part_fillers (part_id, filler) VALUES (?, ?)").run(id, filler);
      }
      if (equipmentId) {
        db.prepare("INSERT OR IGNORE INTO part_equipment (part_id, equipment) VALUES (?, ?)").run(id, equipmentId);
      }
    }
  });
}

// ════════════════════════════════════════
// SERVE FRONTEND
// ════════════════════════════════════════

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ════════════════════════════════════════
// START
// ════════════════════════════════════════

app.listen(PORT, function () {
  console.log("Maintenance Tracker running on port " + PORT);
  console.log("Open http://localhost:" + PORT + " in your browser");
});
