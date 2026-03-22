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

    // Attach parts to each event
    var partsStmt = db.prepare("SELECT * FROM event_parts WHERE event_id = ?");
    events.forEach(function (e) {
      e.parts = partsStmt.all(e.id);
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
      "INSERT INTO events (id, filler, equipment_id, issue, resolution, start_time, stop_time, duration_min, date, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(e.id, e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, e.date, e.timestamp);

    // Insert parts
    var partStmt = db.prepare("INSERT INTO event_parts (id, event_id, name, part_number, qty) VALUES (?, ?, ?, ?, ?)");
    (e.parts || []).forEach(function (p) {
      partStmt.run(p.id, e.id, p.name, p.partNumber, p.qty || 1);
    });

    // Update equipment list
    if (e.equipmentId) {
      db.prepare("INSERT OR IGNORE INTO equipment (name) VALUES (?)").run(e.equipmentId);
    }

    // Update parts catalog
    updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, false);

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
      "UPDATE events SET filler=?, equipment_id=?, issue=?, resolution=?, start_time=?, stop_time=?, duration_min=? WHERE id=?"
    ).run(e.filler, e.equipmentId, e.issue, e.resolution, e.startTime, e.stopTime, e.durationMin, req.params.id);

    // Replace parts
    db.prepare("DELETE FROM event_parts WHERE event_id = ?").run(req.params.id);
    var partStmt = db.prepare("INSERT INTO event_parts (id, event_id, name, part_number, qty) VALUES (?, ?, ?, ?, ?)");
    (e.parts || []).forEach(function (p) {
      partStmt.run(p.id, req.params.id, p.name, p.partNumber, p.qty || 1);
    });

    if (e.equipmentId) {
      db.prepare("INSERT OR IGNORE INTO equipment (name) VALUES (?)").run(e.equipmentId);
    }

    updateCatalogFromParts(e.parts || [], e.filler, e.equipmentId, true);

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
    var timers = {};
    rows.forEach(function (r) {
      timers[r.filler] = { running: !!r.running, startTime: r.start_time };
    });
    res.json(timers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timers/:filler/start", function (req, res) {
  try {
    var now = Date.now();
    db.prepare(
      "INSERT OR REPLACE INTO timers (filler, running, start_time) VALUES (?, 1, ?)"
    ).run(req.params.filler, now);
    res.json({ running: true, startTime: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timers/:filler/stop", function (req, res) {
  try {
    var timer = db.prepare("SELECT * FROM timers WHERE filler = ?").get(req.params.filler);
    db.prepare("DELETE FROM timers WHERE filler = ?").run(req.params.filler);
    res.json({
      startTime: timer ? timer.start_time : null,
      stopTime: Date.now()
    });
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
      "INSERT INTO parts_catalog (id, name, part_number, description, supplier, location, photo_filename) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, p.name, p.partNumber || null, p.description || null, p.supplier || null, p.location || null, p.photoFilename || null);
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
      "UPDATE parts_catalog SET name=?, part_number=?, description=?, supplier=?, location=?, photo_filename=? WHERE id=?"
    ).run(p.name, p.partNumber || null, p.description || null, p.supplier || null, p.location || null, p.photoFilename || null, req.params.id);
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
// HELPER: Update catalog from event parts
// ════════════════════════════════════════

function updateCatalogFromParts(parts, filler, equipmentId, isEdit) {
  parts.forEach(function (p) {
    if (!p.name || !p.name.trim()) return;
    var name = p.name.trim();
    var partNum = (p.partNumber || "").trim();

    var existing = db.prepare(
      "SELECT * FROM parts_catalog WHERE LOWER(name) = LOWER(?) AND COALESCE(part_number,'') = ?"
    ).get(name, partNum);

    if (existing) {
      if (!isEdit) {
        db.prepare("UPDATE parts_catalog SET usage_count = usage_count + 1, last_used = date('now') WHERE id = ?").run(existing.id);
      } else {
        db.prepare("UPDATE parts_catalog SET last_used = date('now') WHERE id = ?").run(existing.id);
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
        "INSERT INTO parts_catalog (id, name, part_number, usage_count, last_used) VALUES (?, ?, ?, 1, date('now'))"
      ).run(id, name, partNum || null);
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
