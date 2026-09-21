'use strict';

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_NAME_LEN = 60;
const MAX_TEXT_LEN = 500;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;
const MAX_COMMENT_LEN = 300;
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🎉']);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- rooms: map code -> Set<ws> -------------------------------------------
const rooms = new Map();

function roomFor(code) {
  let set = rooms.get(code);
  if (!set) {
    set = new Set();
    rooms.set(code, set);
  }
  return set;
}

function broadcast(code, message, exceptClientId) {
  const payload = JSON.stringify(message);
  for (const ws of roomFor(code)) {
    if (ws.readyState === ws.OPEN && ws.clientId !== exceptClientId) {
      ws.send(payload);
    }
  }
}

// Sends to every open socket in the room, including the sender — used for
// presence, since everyone (the joiner included) needs the same live roster.
function sendToRoom(code, message) {
  const payload = JSON.stringify(message);
  for (const ws of roomFor(code)) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// One entry per connected socket (not per person — the same name can have
// multiple tabs open), so participant lists reflect real connection state.
function presenceList(code) {
  const list = [];
  for (const ws of roomFor(code)) {
    if (ws.readyState === ws.OPEN && ws.name) {
      list.push({ clientId: ws.clientId, name: ws.name, color: ws.color, isViewer: !!ws.isViewer });
    }
  }
  return list;
}

function broadcastPresence(code) {
  sendToRoom(code, { type: 'presence', participants: presenceList(code) });
}

// --- validation helpers -----------------------------------------------------
function clean(str, maxLen) {
  return typeof str === 'string' ? str.trim().slice(0, maxLen) : '';
}

function cleanTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  for (const raw of input) {
    const tag = clean(raw, MAX_TAG_LEN).toLowerCase();
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

function validatePinBody(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const name = clean(body.name, MAX_NAME_LEN);
  if (!name) return null;
  const authorName = clean(body.authorName, MAX_NAME_LEN) || 'Someone';
  const authorColor = /^#[0-9a-fA-F]{6}$/.test(body.authorColor) ? body.authorColor : '#ff6b81';
  const rating = Math.max(0, Math.min(5, Number(body.rating) || 0));
  return {
    lat,
    lng,
    name,
    country: clean(body.country, MAX_NAME_LEN),
    date: clean(body.date, 20),
    notes: clean(body.notes, MAX_TEXT_LEN),
    rating,
    authorName,
    authorColor,
    wishlist: !!body.wishlist,
    tags: cleanTags(body.tags),
  };
}

function validateCommentBody(body) {
  const text = clean(body.text, MAX_COMMENT_LEN);
  if (!text) return null;
  const authorName = clean(body.authorName, MAX_NAME_LEN) || 'Someone';
  const authorColor = /^#[0-9a-fA-F]{6}$/.test(body.authorColor) ? body.authorColor : '#64748b';
  return { text, authorName, authorColor };
}

function validateReactionBody(body) {
  if (typeof body.emoji !== 'string' || !ALLOWED_REACTIONS.has(body.emoji)) return null;
  const authorName = clean(body.authorName, MAX_NAME_LEN) || 'Someone';
  const authorColor = /^#[0-9a-fA-F]{6}$/.test(body.authorColor) ? body.authorColor : '#64748b';
  return { emoji: body.emoji, authorName, authorColor };
}

// --- REST API ----------------------------------------------------------------
app.post('/api/maps', (req, res) => {
  const name = clean(req.body?.name, MAX_NAME_LEN) || 'Our map';
  const map = db.createMap(name);
  res.status(201).json(map);
});

app.get('/api/maps/:code', (req, res) => {
  const map = db.getMap(req.params.code);
  if (!map) return res.status(404).json({ error: 'Map not found' });
  const pins = db.listPins(req.params.code);
  const comments = db.listComments(req.params.code);
  const reactions = db.listReactions(req.params.code);
  res.json({ ...map, pins, comments, reactions });
});

app.post('/api/maps/:code/pins', (req, res) => {
  const code = req.params.code.toUpperCase();
  const map = db.getMap(code);
  if (!map) return res.status(404).json({ error: 'Map not found' });

  const pinData = validatePinBody(req.body || {});
  if (!pinData) return res.status(400).json({ error: 'Invalid pin data' });

  const pin = db.createPin(code, { id: crypto.randomUUID(), ...pinData });
  broadcast(code, { type: 'pin:created', pin }, req.body?.clientId);
  res.status(201).json(pin);
});

app.put('/api/maps/:code/pins/:id', (req, res) => {
  const code = req.params.code.toUpperCase();
  const map = db.getMap(code);
  if (!map) return res.status(404).json({ error: 'Map not found' });

  const pinData = validatePinBody(req.body || {});
  if (!pinData) return res.status(400).json({ error: 'Invalid pin data' });

  const pin = db.updatePin(code, req.params.id, pinData);
  if (!pin) return res.status(404).json({ error: 'Pin not found' });
  broadcast(code, { type: 'pin:updated', pin }, req.body?.clientId);
  res.json(pin);
});

app.delete('/api/maps/:code/pins/:id', (req, res) => {
  const code = req.params.code.toUpperCase();
  const ok = db.deletePin(code, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Pin not found' });
  broadcast(code, { type: 'pin:deleted', id: req.params.id }, req.query.clientId);
  res.status(204).end();
});

// --- comments ------------------------------------------------------------------
app.post('/api/maps/:code/pins/:id/comments', (req, res) => {
  const code = req.params.code.toUpperCase();
  const pin = db.getPin(code, req.params.id);
  if (!pin) return res.status(404).json({ error: 'Pin not found' });

  const data = validateCommentBody(req.body || {});
  if (!data) return res.status(400).json({ error: 'Invalid comment' });

  const comment = db.createComment(code, { id: crypto.randomUUID(), pinId: req.params.id, ...data });
  broadcast(code, { type: 'comment:created', pinId: req.params.id, comment }, req.body?.clientId);
  res.status(201).json(comment);
});

app.delete('/api/maps/:code/pins/:id/comments/:commentId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const ok = db.deleteComment(code, req.params.id, req.params.commentId);
  if (!ok) return res.status(404).json({ error: 'Comment not found' });
  broadcast(code, { type: 'comment:deleted', pinId: req.params.id, commentId: req.params.commentId }, req.query.clientId);
  res.status(204).end();
});

// --- reactions -----------------------------------------------------------------
app.post('/api/maps/:code/pins/:id/reactions', (req, res) => {
  const code = req.params.code.toUpperCase();
  const pin = db.getPin(code, req.params.id);
  if (!pin) return res.status(404).json({ error: 'Pin not found' });

  const data = validateReactionBody(req.body || {});
  if (!data) return res.status(400).json({ error: 'Invalid reaction' });

  const reactions = db.toggleReaction(code, req.params.id, data);
  broadcast(code, { type: 'reaction:updated', pinId: req.params.id, reactions }, req.body?.clientId);
  res.json({ reactions });
});

// SPA-style deep links: /m/ABC123 serves the app shell; client reads the code from the URL.
app.get('/m/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- WebSocket server ---------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'join' && typeof msg.code === 'string') {
      const code = msg.code.toUpperCase();
      ws.code = code;
      ws.clientId = msg.clientId;
      ws.name = clean(msg.name, MAX_NAME_LEN) || 'Someone';
      ws.color = /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : '#64748b';
      ws.isViewer = !!msg.viewOnly;
      roomFor(code).add(ws);
      broadcastPresence(code);
    }
  });

  ws.on('close', () => {
    if (ws.code) {
      roomFor(ws.code).delete(ws);
      broadcastPresence(ws.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`PinPoint running at http://localhost:${PORT}`);
});
