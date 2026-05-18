const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

let _db = null;

async function getDb() {
  if (_db) return _db;

  _db = await open({
    filename: path.join(dataDir, 'dguv.db'),
    driver: sqlite3.Database
  });

  await _db.exec('PRAGMA journal_mode = WAL');
  await _db.exec('PRAGMA foreign_keys = ON');

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL DEFAULT 'admin',
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kw_start INTEGER,
      kw_end INTEGER,
      year INTEGER DEFAULT 2025
    );

    CREATE TABLE IF NOT EXISTS objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      street TEXT,
      plz TEXT,
      stadtteil TEXT,
      device_count INTEGER NOT NULL DEFAULT 0,
      days_needed REAL,
      route_group INTEGER,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      last_inspection TEXT,
      inspection_cycle INTEGER,
      contact_name TEXT,
      contact_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS availabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      slot_index INTEGER NOT NULL CHECK(slot_index IN (0,1,2,3)),
      marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, date, slot_index)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      devices_in_slot INTEGER NOT NULL,
      scheduled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, date, slot_index)
    );
  `);

  // Migrate existing databases: add new columns if missing
  const cols = (await _db.all("PRAGMA table_info(objects)")).map(c => c.name);
  const migrations = [
    ['days_needed',       'REAL'],
    ['route_group',       'INTEGER'],
    ['plz',               'TEXT'],
    ['stadtteil',         'TEXT'],
    ['last_inspection',   'TEXT'],
    ['inspection_cycle',  'INTEGER'],
  ];
  for (const [col, type] of migrations) {
    if (!cols.includes(col)) {
      await _db.run(`ALTER TABLE objects ADD COLUMN ${col} ${type}`);
    }
  }

  const admin = await _db.get('SELECT id FROM admin LIMIT 1');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await _db.run('INSERT INTO admin (username, password_hash) VALUES (?,?)', ['admin', hash]);
  }

  return _db;
}

module.exports = { getDb };
