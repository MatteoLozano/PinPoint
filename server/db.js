'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'data', 'pinpoint.sqlite');
require('node:fs').mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

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

// --- idempotent migrations: add newer pin columns if they don't exist yet ----
// node:sqlite doesn't support "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" on all
// versions, so check PRAGMA table_info first (safe to run on every boot).
const existingPinColumns = new Set(db.prepare('PRAGMA table_info(pins)').all().map((c) => c.name));
function ensurePinColumn(name, ddl) {
  if (existingPinColumns.has(name)) return;
  db.exec(`ALTER TABLE pins ADD COLUMN ${ddl}`);
  existingPinColumns.add(name);
}
ensurePinColumn('wishlist', 'wishlist INTEGER NOT NULL DEFAULT 0');
ensurePinColumn('tags', "tags TEXT NOT NULL DEFAULT '[]'");

// --- comments & reactions on pins -------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    pin_id TEXT NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    map_code TEXT NOT NULL REFERENCES maps(code) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_color TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    pin_id TEXT NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    map_code TEXT NOT NULL REFERENCES maps(code) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_color TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(pin_id, author_name, emoji)
  );

  CREATE INDEX IF NOT EXISTS idx_comments_pin_id ON comments(pin_id);
  CREATE INDEX IF NOT EXISTS idx_comments_map_code ON comments(map_code);
  CREATE INDEX IF NOT EXISTS idx_reactions_pin_id ON reactions(pin_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_map_code ON reactions(map_code);
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
const PIN_COLUMNS =
  'id, lat, lng, name, country, date, notes, rating, author_name AS authorName, author_color AS authorColor, ' +
  'wishlist, tags, created_at AS createdAt';
const listPinsStmt = db.prepare(`SELECT ${PIN_COLUMNS} FROM pins WHERE map_code = ? ORDER BY created_at ASC`);
const insertPinStmt = db.prepare(
  'INSERT INTO pins (id, map_code, lat, lng, name, country, date, notes, rating, author_name, author_color, wishlist, tags, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const updatePinStmt = db.prepare(
  'UPDATE pins SET lat = ?, lng = ?, name = ?, country = ?, date = ?, notes = ?, rating = ?, author_name = ?, author_color = ?, ' +
  'wishlist = ?, tags = ? ' +
  'WHERE id = ? AND map_code = ?'
);
const findPinStmt = db.prepare(`SELECT ${PIN_COLUMNS} FROM pins WHERE id = ? AND map_code = ?`);
const deletePinStmt = db.prepare('DELETE FROM pins WHERE id = ? AND map_code = ?');

const listCommentsStmt = db.prepare(
  'SELECT id, pin_id AS pinId, author_name AS authorName, author_color AS authorColor, text, created_at AS createdAt ' +
  'FROM comments WHERE map_code = ? ORDER BY created_at ASC'
);
const insertCommentStmt = db.prepare(
  'INSERT INTO comments (id, pin_id, map_code, author_name, author_color, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const findCommentStmt = db.prepare(
  'SELECT id, pin_id AS pinId, author_name AS authorName, author_color AS authorColor, text, created_at AS createdAt FROM comments WHERE id = ?'
);
const deleteCommentStmt = db.prepare('DELETE FROM comments WHERE id = ? AND pin_id = ? AND map_code = ?');

const listReactionsStmt = db.prepare(
  'SELECT id, pin_id AS pinId, author_name AS authorName, author_color AS authorColor, emoji, created_at AS createdAt ' +
  'FROM reactions WHERE map_code = ? ORDER BY created_at ASC'
);
const listReactionsForPinStmt = db.prepare(
  'SELECT id, pin_id AS pinId, author_name AS authorName, author_color AS authorColor, emoji, created_at AS createdAt ' +
  'FROM reactions WHERE pin_id = ? ORDER BY created_at ASC'
);
const findReactionStmt = db.prepare('SELECT id FROM reactions WHERE pin_id = ? AND author_name = ? AND emoji = ?');
const insertReactionStmt = db.prepare(
  'INSERT INTO reactions (id, pin_id, map_code, author_name, author_color, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const deleteReactionByIdStmt = db.prepare('DELETE FROM reactions WHERE id = ?');

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

// rows come back with tags as a JSON-encoded TEXT column; expose it as a
// plain array (and wishlist as a boolean) to the rest of the app.
function hydratePin(row) {
  if (!row) return row;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  return { ...row, wishlist: !!row.wishlist, tags: Array.isArray(tags) ? tags : [] };
}

function listPins(code) {
  return listPinsStmt.all(code.toUpperCase()).map(hydratePin);
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
    pin.wishlist ? 1 : 0,
    JSON.stringify(pin.tags || []),
    createdAt
  );
  return hydratePin(findPinStmt.get(pin.id, code));
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
    pin.wishlist ? 1 : 0,
    JSON.stringify(pin.tags || []),
    id,
    code
  );
  if (result.changes === 0) return null;
  return hydratePin(findPinStmt.get(id, code));
}

function getPin(code, id) {
  return hydratePin(findPinStmt.get(id, code));
}

function deletePin(code, id) {
  const result = deletePinStmt.run(id, code);
  return result.changes > 0;
}

function listComments(code) {
  return listCommentsStmt.all(code.toUpperCase());
}

function createComment(code, comment) {
  const createdAt = Date.now();
  insertCommentStmt.run(comment.id, comment.pinId, code, comment.authorName, comment.authorColor, comment.text, createdAt);
  return findCommentStmt.get(comment.id);
}

function deleteComment(code, pinId, id) {
  const result = deleteCommentStmt.run(id, pinId, code);
  return result.changes > 0;
}

function listReactions(code) {
  return listReactionsStmt.all(code.toUpperCase());
}

// Toggles one person's reaction on a pin (adds it if absent, removes it if
// already there) and returns the pin's full, current reaction list.
function toggleReaction(code, pinId, reaction) {
  const existing = findReactionStmt.get(pinId, reaction.authorName, reaction.emoji);
  if (existing) {
    deleteReactionByIdStmt.run(existing.id);
  } else {
    insertReactionStmt.run(
      crypto.randomUUID(),
      pinId,
      code.toUpperCase(),
      reaction.authorName,
      reaction.authorColor,
      reaction.emoji,
      Date.now()
    );
  }
  return listReactionsForPinStmt.all(pinId);
}

module.exports = {
  createMap,
  getMap,
  listPins,
  createPin,
  updatePin,
  getPin,
  deletePin,
  listComments,
  createComment,
  deleteComment,
  listReactions,
  toggleReaction,
};
