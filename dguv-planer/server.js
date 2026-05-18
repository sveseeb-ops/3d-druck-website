const express = require('express');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { runAutoSchedule, SLOT_CAPACITY, DAY_CAPACITY, SLOT_TIMES, SLOT_SHORT, slotsNeeded } = require('./scheduler');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dguv-geraetepruefung-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: uploadsDir });

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Nicht autorisiert – bitte einloggen' });
}

function getKW(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin LIMIT 1').get();
  if (!admin || username !== admin.username || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }
  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

app.post('/api/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admin LIMIT 1').get();
  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(400).json({ error: 'Aktuelles Passwort falsch' });
  }
  db.prepare('UPDATE admin SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), admin.id);
  res.json({ success: true });
});

// ── GROUPS ────────────────────────────────────────────────────────────────────

app.get('/api/groups', (req, res) => {
  res.json(db.prepare('SELECT * FROM groups ORDER BY name').all());
});

app.post('/api/groups', requireAdmin, (req, res) => {
  const { name, kw_start, kw_end, year } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const r = db.prepare('INSERT INTO groups (name,kw_start,kw_end,year) VALUES (?,?,?,?)')
      .run(name, kw_start || null, kw_end || null, year || new Date().getFullYear());
    res.json({ id: r.lastInsertRowid, success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Gruppe existiert bereits' });
    throw e;
  }
});

app.put('/api/groups/:id', requireAdmin, (req, res) => {
  const { name, kw_start, kw_end, year } = req.body;
  db.prepare('UPDATE groups SET name=?,kw_start=?,kw_end=?,year=? WHERE id=?')
    .run(name, kw_start || null, kw_end || null, year || new Date().getFullYear(), req.params.id);
  res.json({ success: true });
});

app.delete('/api/groups/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM groups WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── OBJECTS ───────────────────────────────────────────────────────────────────

app.get('/api/objects', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, g.name AS group_name, g.kw_start, g.kw_end, g.year AS kw_year
    FROM objects o
    LEFT JOIN groups g ON o.group_id = g.id
    ORDER BY o.name
  `).all();
  res.json(rows);
});

app.post('/api/objects', requireAdmin, (req, res) => {
  const { name, street, device_count, group_id, contact_name, contact_email } = req.body;
  if (!name || !device_count) return res.status(400).json({ error: 'Name und Geräteanzahl erforderlich' });
  const r = db.prepare(
    'INSERT INTO objects (name,street,device_count,group_id,contact_name,contact_email) VALUES (?,?,?,?,?,?)'
  ).run(name, street || name, parseInt(device_count), group_id || null, contact_name || null, contact_email || null);
  res.json({ id: r.lastInsertRowid, success: true });
});

app.put('/api/objects/:id', requireAdmin, (req, res) => {
  const { name, street, device_count, group_id, contact_name, contact_email } = req.body;
  db.prepare(
    'UPDATE objects SET name=?,street=?,device_count=?,group_id=?,contact_name=?,contact_email=? WHERE id=?'
  ).run(name, street || name, parseInt(device_count), group_id || null, contact_name || null, contact_email || null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/objects/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM objects WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Excel-Import
app.post('/api/upload-excel', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    let imported = 0;
    const errors = [];

    const insert = db.prepare(
      'INSERT OR REPLACE INTO objects (name,street,device_count) VALUES (?,?,?)'
    );
    const importAll = db.transaction((rows) => {
      for (const row of rows) {
        const vals = Object.values(row);
        const name = String(row['Objekt'] || row['Straße'] || row['Name'] || row['Adresse'] || vals[0] || '').trim();
        const devices = parseInt(row['Geräte'] || row['Anzahl'] || row['Geräteanzahl'] || row['Anzahl Geräte'] || vals[1]);
        if (!name || isNaN(devices) || devices <= 0) {
          errors.push(`Übersprungen: ${JSON.stringify(row)}`);
          continue;
        }
        insert.run(name, name, devices);
        imported++;
      }
    });
    importAll(data);
    fs.unlinkSync(req.file.path);
    res.json({ imported, errors });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: `Excel-Fehler: ${err.message}` });
  }
});

// ── AVAILABILITIES ────────────────────────────────────────────────────────────

app.get('/api/availabilities/:objectId', (req, res) => {
  res.json(db.prepare('SELECT * FROM availabilities WHERE object_id=? ORDER BY date,slot_index').all(req.params.objectId));
});

app.post('/api/availabilities', (req, res) => {
  const { object_id, date, slot_index } = req.body;
  if (!object_id || !date || slot_index === undefined) return res.status(400).json({ error: 'Fehlende Parameter' });

  const obj = db.prepare(`
    SELECT o.*, g.kw_start, g.kw_end, g.year AS kw_year
    FROM objects o LEFT JOIN groups g ON o.group_id=g.id
    WHERE o.id=?
  `).get(object_id);
  if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

  if (obj.kw_start && obj.kw_end) {
    const kw = getKW(date);
    if (kw < obj.kw_start || kw > obj.kw_end) {
      return res.status(400).json({ error: `Dieses Objekt darf nur in KW ${obj.kw_start}–${obj.kw_end} eingetragen werden` });
    }
  }

  // Weekends not allowed
  const dow = new Date(date).getDay();
  if (dow === 0 || dow === 6) return res.status(400).json({ error: 'Keine Termine am Wochenende' });

  try {
    db.prepare('INSERT INTO availabilities (object_id,date,slot_index) VALUES (?,?,?)').run(object_id, date, parseInt(slot_index));
    res.json({ success: true, added: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      // Toggle: remove if already exists
      db.prepare('DELETE FROM availabilities WHERE object_id=? AND date=? AND slot_index=?').run(object_id, date, parseInt(slot_index));
      return res.json({ success: true, removed: true });
    }
    throw e;
  }
});

app.delete('/api/availabilities/object/:objectId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM availabilities WHERE object_id=?').run(req.params.objectId);
  res.json({ success: true });
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────────

app.post('/api/auto-schedule', requireAdmin, (req, res) => {
  const result = runAutoSchedule(db);
  res.json(result);
});

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

app.get('/api/bookings', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, o.name AS object_name, o.device_count, g.name AS group_name
    FROM bookings b
    JOIN objects o ON b.object_id=o.id
    LEFT JOIN groups g ON o.group_id=g.id
    ORDER BY b.date, b.slot_index, o.name
  `).all();
  res.json(rows);
});

app.get('/api/bookings/object/:objectId', (req, res) => {
  res.json(db.prepare('SELECT * FROM bookings WHERE object_id=? ORDER BY date,slot_index').all(req.params.objectId));
});

app.delete('/api/bookings', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bookings').run();
  res.json({ success: true });
});

// ── CALENDAR DATA ─────────────────────────────────────────────────────────────

app.get('/api/calendar/:year/:month', (req, res) => {
  const { year, month } = req.params;
  const prefix = `${year}-${month.padStart(2, '0')}`;

  const slots = db.prepare(`
    SELECT b.date, b.slot_index,
           SUM(b.devices_in_slot) AS total_devices,
           COUNT(DISTINCT b.object_id) AS object_count
    FROM bookings b WHERE b.date LIKE ?
    GROUP BY b.date, b.slot_index
  `).all(`${prefix}%`);

  const avails = db.prepare(`
    SELECT a.date, a.slot_index, COUNT(*) AS count
    FROM availabilities a WHERE a.date LIKE ?
    GROUP BY a.date, a.slot_index
  `).all(`${prefix}%`);

  res.json({ slots, availabilities: avails, slotCapacity: SLOT_CAPACITY, dayCapacity: DAY_CAPACITY, slotTimes: SLOT_TIMES, slotShort: SLOT_SHORT });
});

// ── ADMIN PAGE ────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nDGUV-3 Prüfungsplaner läuft auf http://localhost:${PORT}`);
  console.log(`Admin-Login: admin / admin123\n`);
});
