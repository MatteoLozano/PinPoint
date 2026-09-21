'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'data', 'pinpoint.sqlite');
require('node:fs').mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pins (
    id TEXT PRIMARY KEY,
    map_code TEXT NOT NULL REFERENCES maps(code) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    name TEXT NOT NULL,
    country TEXT,
    date TEXT,
    notes TEXT,
    rating INTEGER DEFAULT 0,
    author_name TEXT NOT NULL,
    author_color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pins_map_code ON pins(map_code);
`);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L, avoids confusing codes

function randomCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

const findMapStmt = db.prepare('SELECT code, name, created_at AS createdAt FROM maps WHERE code = ?');
const insertMapStmt = db.prepare('INSERT INTO maps (code, name, created_at) VALUES (?, ?, ?)');
const listPinsStmt = db.prepare(
  'SELECT id, lat, lng, name, country, date, notes, rating, author_name AS authorName, author_color AS authorColor, created_at AS createdAt ' +
  'FROM pins WHERE map_code = ? ORDER BY created_at ASC'
);
const insertPinStmt = db.prepare(
  'INSERT INTO pins (id, map_code, lat, lng, name, country, date, notes, rating, author_name, author_color, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const updatePinStmt = db.prepare(
  'UPDATE pins SET lat = ?, lng = ?, name = ?, country = ?, date = ?, notes = ?, rating = ?, author_name = ?, author_color = ? ' +
  'WHERE id = ? AND map_code = ?'
);
const findPinStmt = db.prepare(
  'SELECT id, lat, lng, name, country, date, notes, rating, author_name AS authorName, author_color AS authorColor, created_at AS createdAt ' +
  'FROM pins WHERE id = ? AND map_code = ?'
);
const deletePinStmt = db.prepare('DELETE FROM pins WHERE id = ? AND map_code = ?');

function createMap(name) {
  let code = randomCode();
  while (findMapStmt.get(code)) code = randomCode();
  const createdAt = Date.now();
  insertMapStmt.run(code, name, createdAt);
  return { code, name, createdAt };
}

function getMap(code) {
  return findMapStmt.get(code.toUpperCase());
}

function listPins(code) {
  return listPinsStmt.all(code.toUpperCase());
}

function createPin(code, pin) {
  const createdAt = Date.now();
  insertPinStmt.run(
    pin.id,
    code,
    pin.lat,
    pin.lng,
    pin.name,
    pin.country || '',
    pin.date || '',
    pin.notes || '',
    pin.rating || 0,
    pin.authorName,
    pin.authorColor,
    createdAt
  );
  return findPinStmt.get(pin.id, code);
}

function updatePin(code, id, pin) {
  const result = updatePinStmt.run(
    pin.lat,
    pin.lng,
    pin.name,
    pin.country || '',
    pin.date || '',
    pin.notes || '',
    pin.rating || 0,
    pin.authorName,
    pin.authorColor,
    id,
    code
  );
  if (result.changes === 0) return null;
  return findPinStmt.get(id, code);
}

function deletePin(code, id) {
  const result = deletePinStmt.run(id, code);
  return result.changes > 0;
}

module.exports = { createMap, getMap, listPins, createPin, updatePin, deletePin };
