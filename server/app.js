// Express app for Emoji Auction.
//
// This used to be a Socket.IO server holding a persistent WebSocket per
// player, with room state in server/game/store.js's in-memory Map and phase
// timers (writing/betting/voting) as live setTimeout handles. None of that
// survives on a serverless host (Vercel): no persistent process, no
// long-lived sockets, and no shared memory between invocations. So this is
// now plain HTTP actions + polling: every route below reads/writes a room by
// (roomCode, playerId) in the body or query string, and
// server/game/roomManager.js resolves time-driven state (phase timeouts,
// stale disconnects) lazily on every room load instead of via a background
// timer. See roomManager.js's top-of-file comment and applyLazyStateUpdates
// for the mechanism.
//
// Exported (no .listen() here) so both the local dev entrypoint
// (server/server.js) and the Vercel serverless entrypoint (api/index.js)
// can reuse the identical app.

const path = require('path');
const express = require('express');
const rooms = require('./game/roomManager');
const { connectMongo, getDb, recordPlayerResults, recordKeywordStats } = require('./data/mongo');
const { arcadeProxy } = require('./arcade-proxy');

const app = express();
app.use(express.json());
app.all('/arcade-api/v1/*', arcadeProxy); // local dev only — see arcade-proxy.js

// Best-effort — a slow or unreachable database should never affect
// gameplay, so this is fire-and-forget and swallows its own errors.
async function saveGameSessionAnalytics(room) {
  const db = getDb();
  if (!db) return;
  try {
    const record = rooms.buildGameSessionRecord(room);
    await db.collection('gamesessions').insertOne(record);
    console.log(`[mongo] Saved game session for room ${room.roomCode}`);
    await recordPlayerResults(record.players);
    await recordKeywordStats(record.keywordEntries);
    await rooms.markAnalyticsSaved(room.roomCode);
  } catch (e) {
    console.error('[mongo] Failed to save game session:', e.message);
  }
}

// A round reaching 'final' used to be the one moment the live phase timer
// fired the analytics save. Now that transition can happen lazily inside
// *any* route that loads the room (or eagerly via phase-ready's early
// advance), so every route that gets a room back checks for it here —
// guarded by room.analyticsSaved so it only actually writes once even if
// several routes/polls race right at the end.
function maybeSaveAnalytics(room) {
  if (room && room.state === 'final' && !room.analyticsSaved) {
    saveGameSessionAnalytics(room);
  }
}

function normId(value) {
  return String(value || '').trim();
}

function normCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normName(value) {
  return String(value || '').trim().slice(0, 20) || `Player${Math.floor(Math.random() * 9999)}`;
}

app.post('/api/create-room', async (req, res) => {
  try {
    const { username, playerId, code } = req.body || {};
    const id = normId(playerId);
    if (!id) return res.json({ ok: false, error: 'Missing player id.' });
    const room = await rooms.createRoom(id, normName(username), code);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/join-room', async (req, res) => {
  try {
    const { username, roomCode, playerId } = req.body || {};
    const id = normId(playerId);
    if (!id) return res.json({ ok: false, error: 'Missing player id.' });
    const room = await rooms.joinRoom(normCode(roomCode), id, normName(username));
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

// Called on page load when a device has a saved room/player in
// sessionStorage — this is what makes a refresh (or reopening the tab) land
// back in the same game, same phase, instead of bouncing to login.
app.post('/api/rejoin-room', async (req, res) => {
  try {
    const { roomCode, playerId, username } = req.body || {};
    const id = normId(playerId);
    if (!id) return res.json({ ok: false, error: 'Missing player id.' });
    const room = await rooms.reconnectPlayer(normCode(roomCode), id, username);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/set-ready', async (req, res) => {
  try {
    const { roomCode, playerId, ready } = req.body || {};
    const id = normId(playerId);
    const room = await rooms.setReady(normCode(roomCode), id, !!ready);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/start-game', async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    const id = normId(playerId);
    const room = await rooms.startGame(normCode(roomCode), id);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/submit-word', async (req, res) => {
  try {
    const { roomCode, playerId, text } = req.body || {};
    const id = normId(playerId);
    const { room, draft } = await rooms.submitWord(normCode(roomCode), id, text);
    maybeSaveAnalytics(room);
    res.json({ ok: true, draft, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/remove-word', async (req, res) => {
  try {
    const { roomCode, playerId, wordId } = req.body || {};
    const id = normId(playerId);
    const { room, draft } = await rooms.removeWord(normCode(roomCode), id, wordId);
    maybeSaveAnalytics(room);
    res.json({ ok: true, draft, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/place-bet', async (req, res) => {
  try {
    const { roomCode, playerId, entryId, amount } = req.body || {};
    const id = normId(playerId);
    const room = await rooms.placeBet(normCode(roomCode), id, entryId, amount);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/cast-vote', async (req, res) => {
  try {
    const { roomCode, playerId, entryId } = req.body || {};
    const id = normId(playerId);
    const { room, myVotes } = await rooms.castVote(normCode(roomCode), id, entryId);
    maybeSaveAnalytics(room);
    res.json({ ok: true, myVotes, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

// Shared "I'm done with this phase" toggle for writing/betting/voting —
// once everyone connected has locked in, the phase advances immediately
// (inside the same mutation, see roomManager's setPhaseReady) instead of
// waiting out the full timer.
app.post('/api/phase-ready', async (req, res) => {
  try {
    const { roomCode, playerId, phase } = req.body || {};
    const id = normId(playerId);
    const { room, allReady } = await rooms.setPhaseReady(normCode(roomCode), id, phase);
    maybeSaveAnalytics(room);
    res.json({ ok: true, allReady, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/next-round', async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    const id = normId(playerId);
    const room = await rooms.nextRound(normCode(roomCode), id);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/play-again', async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    const id = normId(playerId);
    const room = await rooms.playAgain(normCode(roomCode), id);
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

app.post('/api/leave-room', async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    await rooms.leaveRoom(normCode(roomCode), normId(playerId));
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

// Sent every few seconds by a connected client — there's no persistent
// socket left to notice a disconnect, so presence is tracked this way
// instead (see roomManager's applyLazyStateUpdates for how staleness is
// actually detected).
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { roomCode, playerId } = req.body || {};
    await rooms.heartbeat(normCode(roomCode), normId(playerId));
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code });
  }
});

// Polling endpoint — replaces the old room_update socket broadcast. Every
// response is the full authoritative room snapshot, personalized to the
// requesting player the same way room_update always was (see
// roomManager.toClientView's forPlayerId parameter).
app.get('/api/room', async (req, res) => {
  try {
    const code = normCode(req.query.code);
    const playerId = normId(req.query.playerId);
    if (!code) return res.status(400).json({ ok: false, error: 'Missing room code.' });
    const room = await rooms.getRoom(code);
    if (!room) return res.json({ ok: true, room: null });
    maybeSaveAnalytics(room);
    res.json({ ok: true, room: rooms.toClientView(room, playerId) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Local dev only in practice — on Vercel, requests under /public are served
// directly by the platform before ever reaching this function.
app.use(express.static(path.join(__dirname, '..', 'public')));

connectMongo(); // fire-and-forget — gameplay works fine before/without this resolving

module.exports = app;
