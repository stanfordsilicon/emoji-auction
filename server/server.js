const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const rooms = require('./game/roomManager');
const { connectMongo, getDb, recordPlayerResults, recordKeywordStats } = require('./data/mongo');

const PORT = process.env.PORT || 4336;

// How long a disconnected player's seat stays warm before they're actually
// removed from the room — long enough to survive a page refresh or a closed
// tab right after the final results, without leaving stale seats forever.
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

// Timeout handles for auto-ending the current phase (writing/betting/voting)
// when its clock runs out. Kept out of the room document itself since a
// timer handle can't be serialized to a future MongoDB document.
const phaseTimers = new Map();

function clearPhaseTimer(roomCode) {
  const handle = phaseTimers.get(roomCode);
  if (handle) {
    clearTimeout(handle);
    phaseTimers.delete(roomCode);
  }
}

function schedulePhaseEnd(roomCode, endsAt) {
  clearPhaseTimer(roomCode);
  const delay = Math.max(0, endsAt - Date.now());
  const handle = setTimeout(() => advancePhase(roomCode), delay);
  phaseTimers.set(roomCode, handle);
}

// Pending "actually remove this player" timers, keyed by `${roomCode}:${playerId}`.
const pendingRemovals = new Map();

function pendingKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function clearPendingRemoval(roomCode, playerId) {
  const key = pendingKey(roomCode, playerId);
  const handle = pendingRemovals.get(key);
  if (handle) {
    clearTimeout(handle);
    pendingRemovals.delete(key);
  }
}

function scheduleRemoval(roomCode, playerId) {
  clearPendingRemoval(roomCode, playerId);
  const handle = setTimeout(async () => {
    pendingRemovals.delete(pendingKey(roomCode, playerId));
    try {
      const room = await rooms.leaveRoom(roomCode, playerId);
      if (room) {
        broadcastRoom(roomCode, room);
      } else {
        clearPhaseTimer(roomCode);
      }
    } catch (e) {
      console.error('Error removing disconnected player:', e);
    }
  }, DISCONNECT_GRACE_MS);
  pendingRemovals.set(pendingKey(roomCode, playerId), handle);
}

// Every player in a room needs to know which pooled entries are their own
// (to gray out self-betting/self-voting) without that leaking to anyone
// else — so unlike a single-shot io.to(room).emit, this sends one
// personalized payload per connected socket in the room.
function broadcastRoom(roomCode, room) {
  const socketIds = io.sockets.adapter.rooms.get(roomCode);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.emit('room_update', rooms.toClientView(room, socket.data.playerId));
  }
}

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
  } catch (e) {
    console.error('[mongo] Failed to save game session:', e.message);
  }
}

// Reads the room's current phase and calls the matching roomManager
// "end this phase" function — used both by the phase timer firing and by
// setPhaseReady() once every connected player has locked in early.
async function advancePhase(roomCode) {
  clearPhaseTimer(roomCode);
  try {
    const before = await rooms.getRoom(roomCode);
    if (!before) return;

    let room;
    if (before.state === 'writing') room = await rooms.endWriting(roomCode);
    else if (before.state === 'betting') room = await rooms.endBetting(roomCode);
    else if (before.state === 'voting') room = await rooms.endVoting(roomCode);
    else return;

    if (!room) return;
    broadcastRoom(roomCode, room);

    if (room.state === 'betting' || room.state === 'voting' || room.state === 'writing') {
      const round = room.rounds[room.roundIndex];
      schedulePhaseEnd(roomCode, round.phaseEndsAt);
    } else if (room.state === 'final') {
      saveGameSessionAnalytics(room);
    }
  } catch (e) {
    console.error('Error advancing phase:', e);
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', async ({ username, playerId } = {}, cb) => {
    try {
      const id = String(playerId || '').trim() || socket.id;
      const name = String(username || '').trim().slice(0, 20) || `Player${Math.floor(Math.random() * 9999)}`;
      const room = await rooms.createRoom(id, name);
      socket.join(room.roomCode);
      socket.data.roomCode = room.roomCode;
      socket.data.playerId = id;
      cb && cb({ ok: true, room: rooms.toClientView(room, id) });
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('join_room', async ({ username, roomCode, playerId } = {}, cb) => {
    try {
      const code = String(roomCode || '').trim().toUpperCase();
      const id = String(playerId || '').trim() || socket.id;
      const name = String(username || '').trim().slice(0, 20) || `Player${Math.floor(Math.random() * 9999)}`;
      const room = await rooms.joinRoom(code, id, name);
      clearPendingRemoval(code, id);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = id;
      cb && cb({ ok: true, room: rooms.toClientView(room, id) });
      broadcastRoom(code, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  // Fired on page load when a device has a saved room/player in
  // sessionStorage — this is what makes a refresh (or a mid-phase reload)
  // land back in the same game, same phase, instead of bouncing to login.
  socket.on('rejoin_room', async ({ roomCode, playerId, username } = {}, cb) => {
    try {
      const code = String(roomCode || '').trim().toUpperCase();
      const id = String(playerId || '').trim();
      if (!id) throw new Error('Missing player id.');
      const room = await rooms.reconnectPlayer(code, id, username);
      clearPendingRemoval(code, id);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = id;
      cb && cb({ ok: true, room: rooms.toClientView(room, id) });
      broadcastRoom(code, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('set_ready', async ({ ready } = {}, cb) => {
    try {
      const room = await rooms.setReady(socket.data.roomCode, socket.data.playerId, !!ready);
      cb && cb({ ok: true });
      broadcastRoom(socket.data.roomCode, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('start_game', async (_payload, cb) => {
    try {
      const roomCode = socket.data.roomCode;
      const room = await rooms.startGame(roomCode, socket.data.playerId);
      const round = room.rounds[room.roundIndex];
      schedulePhaseEnd(roomCode, round.phaseEndsAt);
      cb && cb({ ok: true });
      broadcastRoom(roomCode, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('submit_word', async ({ text } = {}, cb) => {
    try {
      const { room, draft } = await rooms.submitWord(socket.data.roomCode, socket.data.playerId, text);
      cb && cb({ ok: true, draft });
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('remove_word', async ({ wordId } = {}, cb) => {
    try {
      const { room, draft } = await rooms.removeWord(socket.data.roomCode, socket.data.playerId, wordId);
      cb && cb({ ok: true, draft });
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('place_bet', async ({ entryId, amount } = {}, cb) => {
    try {
      const room = await rooms.placeBet(socket.data.roomCode, socket.data.playerId, entryId, amount);
      cb && cb({ ok: true });
      broadcastRoom(socket.data.roomCode, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('cast_vote', async ({ entryId } = {}, cb) => {
    try {
      const { room, myVotes } = await rooms.castVote(socket.data.roomCode, socket.data.playerId, entryId);
      cb && cb({ ok: true, myVotes });
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  // Shared "I'm done with this phase" toggle for writing/betting/voting —
  // once everyone connected has locked in, the phase advances immediately
  // instead of waiting out the full timer.
  socket.on('phase_ready', async ({ phase } = {}, cb) => {
    try {
      const roomCode = socket.data.roomCode;
      const { room, allReady } = await rooms.setPhaseReady(roomCode, socket.data.playerId, phase);
      cb && cb({ ok: true });
      broadcastRoom(roomCode, room);
      if (allReady) advancePhase(roomCode);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('next_round', async (_payload, cb) => {
    try {
      const roomCode = socket.data.roomCode;
      const room = await rooms.nextRound(roomCode, socket.data.playerId);
      const round = room.rounds[room.roundIndex];
      schedulePhaseEnd(roomCode, round.phaseEndsAt);
      cb && cb({ ok: true });
      broadcastRoom(roomCode, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('play_again', async (_payload, cb) => {
    try {
      const roomCode = socket.data.roomCode;
      const room = await rooms.playAgain(roomCode, socket.data.playerId);
      cb && cb({ ok: true });
      broadcastRoom(roomCode, room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('leave_room', async (_payload, cb) => {
    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (roomCode && playerId) {
      clearPendingRemoval(roomCode, playerId);
      socket.leave(roomCode);
      const room = await rooms.leaveRoom(roomCode, playerId);
      if (room) {
        broadcastRoom(roomCode, room);
      } else {
        clearPhaseTimer(roomCode);
      }
    }
    socket.data.roomCode = null;
    socket.data.playerId = null;
    cb && cb({ ok: true });
  });

  // A disconnect (refresh, closed tab, dropped wifi) doesn't immediately
  // evict the player — it just marks them disconnected and starts the grace
  // timer, so a quick rejoin_room picks up exactly where they left off.
  socket.on('disconnect', async () => {
    try {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.playerId;
      if (!roomCode || !playerId) return;
      const room = await rooms.markDisconnected(roomCode, playerId);
      if (room) broadcastRoom(roomCode, room);
      scheduleRemoval(roomCode, playerId);
    } catch (e) {
      console.error('Error handling disconnect:', e);
    }
  });
});

// Last-resort safety net: a bug in one room's game loop should never take
// down every other room's live game. Log it and keep serving instead of
// letting Node's default crash-the-process behavior wipe everyone out.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

connectMongo(); // fire-and-forget — gameplay works fine before/without this resolving

server.listen(PORT, () => {
  console.log(`Emoji Auction listening on http://localhost:${PORT}`);
});
