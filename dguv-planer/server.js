const express = require('express');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const { getDb } = require('./db');
const { runAutoSchedule, SLOT_CAPACITY, DAY_CAPACITY, SLOT_TIMES, SLOT_SHORT } = require('./scheduler');

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

app.post('/api/login', async (req, res) => {
  try {
    const db = await getDb();
    const { username, password } = req.body;
    const admin = await db.get('SELECT * FROM admin LIMIT 1');
    if (!admin || username !== admin.username || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }
    req.session.isAdmin = true;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

app.post('/api/change-password', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { currentPassword, newPassword } = req.body;
    const admin = await db.get('SELECT * FROM admin LIMIT 1');
    if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
      return res.status(400).json({ error: 'Aktuelles Passwort falsch' });
    }
    await db.run('UPDATE admin SET password_hash=? WHERE id=?', [bcrypt.hashSync(newPassword, 10), admin.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GROUPS ────────────────────────────────────────────────────────────────────

app.get('/api/groups', async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.all('SELECT * FROM groups ORDER BY name'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { name, kw_start, kw_end, year } = req.body;
    if (!name) return res.status(400).json({ error: 'Name erforderlich' });
    const r = await db.run('INSERT INTO groups (name,kw_start,kw_end,year) VALUES (?,?,?,?)',
      [name, kw_start || null, kw_end || null, year || new Date().getFullYear()]);
    res.json({ id: r.lastID, success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Gruppe existiert bereits' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/groups/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { name, kw_start, kw_end, year } = req.body;
    await db.run('UPDATE groups SET name=?,kw_start=?,kw_end=?,year=? WHERE id=?',
      [name, kw_start || null, kw_end || null, year || new Date().getFullYear(), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/groups/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM groups WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OBJECTS ───────────────────────────────────────────────────────────────────

app.get('/api/objects', async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(`
      SELECT o.*, g.name AS group_name, g.kw_start, g.kw_end, g.year AS kw_year
      FROM objects o
      LEFT JOIN groups g ON o.group_id = g.id
      ORDER BY COALESCE(o.route_group, 9999), o.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/objects', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { name, street, device_count, group_id, contact_name, contact_email } = req.body;
    if (!name || !device_count) return res.status(400).json({ error: 'Name und Geräteanzahl erforderlich' });
    const r = await db.run(
      'INSERT INTO objects (name,street,device_count,group_id,contact_name,contact_email) VALUES (?,?,?,?,?,?)',
      [name, street || name, parseInt(device_count), group_id || null, contact_name || null, contact_email || null]
    );
    res.json({ id: r.lastID, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/objects/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { name, street, device_count, group_id, contact_name, contact_email } = req.body;
    await db.run(
      'UPDATE objects SET name=?,street=?,device_count=?,group_id=?,contact_name=?,contact_email=? WHERE id=?',
      [name, street || name, parseInt(device_count), group_id || null, contact_name || null, contact_email || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/objects/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM objects WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excel-Import
app.post('/api/upload-excel', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  try {
    const db = await getDb();
    const wb = XLSX.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    let imported = 0;
    const errors = [];

    // Auto-create groups from Gebäudetyp column
    const groupCache = {};
    const ensureGroup = async (typeName) => {
      if (!typeName) return null;
      if (groupCache[typeName]) return groupCache[typeName];
      const existing = await db.get('SELECT id FROM groups WHERE name=?', [typeName]);
      if (existing) { groupCache[typeName] = existing.id; return existing.id; }
      const r = await db.run('INSERT INTO groups (name) VALUES (?)', [typeName]);
      groupCache[typeName] = r.lastID;
      return r.lastID;
    };

    for (const row of data) {
      // F: Objekt, G: Straße, H: PLZ, I: Stadtteil, J: Gebäudetyp
      // L: Letztes Prüfdatum, O: Prüfzyklus Jahre, Q: geprüfte Geräte
      // R: Tage (Fenster-Bedarf), S: Gruppen (Wegeaufwand)
      const name = String(row['Objekt'] || row['Name'] || row['Adresse'] || '').trim();
      const street = String(row['Straße'] || row['Strasse'] || '').trim();
      const plz = String(row['PLZ'] || '').trim();
      const stadtteil = String(row['Stadtteil'] || '').trim();
      const gebaeudetype = String(row['Gebäudetyp'] || row['Gebaeudetyp'] || row['Typ'] || '').trim();
      const lastInspection = String(row['Letztes Prüfdatum'] || row['letztes Prüfdatum'] || '').trim();
      const inspCycle = parseInt(row['Prüfzyklus Jahre'] || row['Prüfzyklu s Jahre'] || '') || null;

      // "geprüfte Geräte" = actual device count
      const deviceRaw = row['geprüfte Geräte'] || row['geprufte Gerate'] || row['Geräte'] ||
                        row['Anzahl'] || row['Geräteanzahl'] || row['Anzahl Geräte'] || '';
      const devices = parseInt(deviceRaw);

      // "Tage" = slot demand (0.125=1/8 day, 0.25=1 slot, 0.5=2 slots, 1.0=4 slots=full day)
      const daysRaw = parseFloat(row['Tage'] || row['Gruppen Tagesanzahl'] || '');
      const daysNeeded = isNaN(daysRaw) ? null : daysRaw;

      // "Gruppen (Wegeaufwand)" = route group 1–9 for travel optimization
      const routeGroupRaw = parseInt(row['Gruppen (Wegeaufwand)'] || row['Gruppen'] || '');
      const routeGroup = isNaN(routeGroupRaw) ? null : routeGroupRaw;

      if (!name) continue;
      if ((isNaN(devices) || devices <= 0) && !daysNeeded) {
        errors.push(`Übersprungen (keine Geräte/Tage): ${name}`);
        continue;
      }

      const fullName = stadtteil && !name.includes(stadtteil) ? `${name} (${stadtteil})` : name;
      const groupId = await ensureGroup(gebaeudetype || null);

      await db.run(`
        INSERT OR REPLACE INTO objects
          (name, street, plz, stadtteil, device_count, days_needed, route_group,
           group_id, last_inspection, inspection_cycle)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `, [
        fullName,
        street || fullName,
        plz || null,
        stadtteil || null,
        isNaN(devices) ? 0 : devices,
        daysNeeded,
        routeGroup,
        groupId,
        lastInspection || null,
        inspCycle,
      ]);
      imported++;
    }

    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.json({ imported, errors });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: `Excel-Fehler: ${err.message}` });
  }
});

// ── AVAILABILITIES ────────────────────────────────────────────────────────────

app.get('/api/availabilities/:objectId', async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.all('SELECT * FROM availabilities WHERE object_id=? ORDER BY date,slot_index', [req.params.objectId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/availabilities', async (req, res) => {
  try {
    const db = await getDb();
    const { object_id, date, slot_index } = req.body;
    if (!object_id || !date || slot_index === undefined) return res.status(400).json({ error: 'Fehlende Parameter' });

    const obj = await db.get(`
      SELECT o.*, g.kw_start, g.kw_end, g.year AS kw_year
      FROM objects o LEFT JOIN groups g ON o.group_id=g.id WHERE o.id=?
    `, [object_id]);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    if (obj.kw_start && obj.kw_end) {
      const kw = getKW(date);
      if (kw < obj.kw_start || kw > obj.kw_end) {
        return res.status(400).json({ error: `Dieses Objekt darf nur in KW ${obj.kw_start}–${obj.kw_end} eingetragen werden` });
      }
    }

    const dow = new Date(date).getDay();
    if (dow === 0 || dow === 6) return res.status(400).json({ error: 'Keine Termine am Wochenende' });

    try {
      await db.run('INSERT INTO availabilities (object_id,date,slot_index) VALUES (?,?,?)', [object_id, date, parseInt(slot_index)]);
      res.json({ success: true, added: true });
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        await db.run('DELETE FROM availabilities WHERE object_id=? AND date=? AND slot_index=?', [object_id, date, parseInt(slot_index)]);
        return res.json({ success: true, removed: true });
      }
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────────

app.post('/api/auto-schedule', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const result = await runAutoSchedule(db);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

app.get('/api/bookings', async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(`
      SELECT b.*, o.name AS object_name, o.device_count, g.name AS group_name
      FROM bookings b
      JOIN objects o ON b.object_id=o.id
      LEFT JOIN groups g ON o.group_id=g.id
      ORDER BY b.date, b.slot_index, o.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bookings/object/:objectId', async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.all('SELECT * FROM bookings WHERE object_id=? ORDER BY date,slot_index', [req.params.objectId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bookings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM bookings');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CALENDAR DATA ─────────────────────────────────────────────────────────────

app.get('/api/calendar/:year/:month', async (req, res) => {
  try {
    const db = await getDb();
    const { year, month } = req.params;
    const prefix = `${year}-${month.padStart(2, '0')}`;

    const slots = await db.all(`
      SELECT b.date, b.slot_index,
             SUM(b.devices_in_slot) AS total_devices,
             COUNT(DISTINCT b.object_id) AS object_count
      FROM bookings b WHERE b.date LIKE ?
      GROUP BY b.date, b.slot_index
    `, [`${prefix}%`]);

    const avails = await db.all(`
      SELECT a.date, a.slot_index, COUNT(*) AS count
      FROM availabilities a WHERE a.date LIKE ?
      GROUP BY a.date, a.slot_index
    `, [`${prefix}%`]);

    res.json({ slots, availabilities: avails, slotCapacity: SLOT_CAPACITY, dayCapacity: DAY_CAPACITY, slotTimes: SLOT_TIMES, slotShort: SLOT_SHORT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAGES ─────────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── START ─────────────────────────────────────────────────────────────────────

async function start() {
  await getDb(); // initialize DB
  app.listen(PORT, () => {
    console.log(`\nDGUV-3 Prüfungsplaner läuft auf http://localhost:${PORT}`);
    console.log(`Admin-Login: admin / admin123\n`);
  });
}

start().catch(console.error);
