// Core game rules for Emoji Auction — a Jackbox "Bidiots"-inspired
// write-keywords / bet-chips / vote / get-paid-on-the-odds party game.
//
// This module is deliberately free of any networking/transport knowledge —
// it only reads and writes plain JSON-shaped "room" objects via ./store.js.
// server/app.js is responsible for wiring these functions to HTTP routes.
// Phase timeouts and stale disconnects are resolved lazily (see
// applyLazyStateUpdates) rather than via a live timer, since there's no
// persistent process to hold one across serverless requests. Keeping the
// split this way means the persistence layer (store.js) and the transport
// layer (app.js) can each be swapped out independently of the rules below.
//
// Player identity is a client-generated id (persisted in the browser's
// sessionStorage), NOT a socket/connection id — a refresh gets a fresh HTTP
// session but keeps the same player id, which is what makes
// rejoin-after-refresh, play-again, and the frozen final leaderboard all work.
//
// ---- Round phase state machine ----
// lobby -> writing -> betting -> voting -> reveal -> (writing again | final)
//
// writing: each player privately drafts 1-4 short keyword entries for the
//   shown emoji (server-only, per-player draft — never broadcast to anyone
//   but its owner).
// betting: every drafted entry from every player is flattened into one
//   shuffled, anonymized pool. Each player places exactly one chip bet on an
//   entry that isn't their own; live pari-mutuel odds are derived from the
//   pool on demand (see poolInfo()) so they always reflect the latest bets.
// voting: same anonymized pool. Each player spends up to VOTES_PER_PLAYER
//   hearts, one per entry max, never on their own entries. Vote counts are
//   never broadcast while voting is open — only revealed once betting
//   closes and the round resolves.
// reveal: computed exactly once, at the moment voting closes. The winning
//   entry (most votes, ties share the win) pays its backers out of the full
//   chip pool pari-mutuel-style; every author earns a small bonus per vote
//   their entries received, plus a flat bonus if one of their entries won.
//   The "one card at a time" reveal from the reference screenshot is treated
//   as a purely client-side animation over this already-computed, already
//   public result set — the server has nothing left to hide at this point.

const { EMOJIS } = require('../data/emojiData');
const store = require('./store');

const TOTAL_ROUNDS = Number(process.env.EA_TOTAL_ROUNDS) || 3;
const WRITING_SECONDS = Number(process.env.EA_WRITING_SECONDS) || 30;
const BETTING_SECONDS = Number(process.env.EA_BETTING_SECONDS) || 20;
const VOTING_SECONDS = Number(process.env.EA_VOTING_SECONDS) || 15;
const MAX_PLAYERS = 8;
const MAX_WORDS_PER_PLAYER = 4;
const VOTES_PER_PLAYER = 3;
const STARTING_CHIPS = 500;
const MIN_BET = 10;
const AUTHOR_VOTE_BONUS = 10; // chips per vote an author's entry receives
const WINNER_BONUS = 100; // flat chips split among the winning entry's author(s)
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — avoids look-alike mixups
const MAX_WORD_LENGTH = 40;

// How long a disconnected player's seat stays warm before they're actually
// removed from the room — long enough to survive a page refresh or a closed
// tab right after the final results, without leaving stale seats forever.
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

// A player is considered disconnected once their heartbeat goes quiet for
// this long — comfortably above the client's ~4s heartbeat interval so a
// couple of missed beats (a slow network tick, a backgrounded tab) don't
// falsely flag someone as gone. There's no more live socket "disconnect"
// event to notice this instantly, so it's detected lazily instead (see
// applyLazyStateUpdates), same as Munchers/Scramble.
const HEARTBEAT_TIMEOUT_MS = 15 * 1000;

// How many times mutateRoom() retries a save that lost an optimistic-
// concurrency race (or a read that transiently missed an existing room)
// before giving up. A handful is plenty -- each retry means another
// request genuinely raced this one against the same room.
const MAX_MUTATE_RETRIES = 6;

// Assigned to players in join order so each one gets a stable badge color
// that never shifts when the leaderboard re-sorts by chip balance.
const PLAYER_COLORS = ['#FF5C8A', '#4B3F72', '#35B06D', '#FFD166', '#3AA6FF', '#FF8C42', '#9B5DE5', '#00BBF9'];

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalizeWord(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isSoleAuthor(entry, playerId) {
  return entry.authorIds.length === 1 && entry.authorIds[0] === playerId;
}

function randomRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

async function generateUniqueRoomCode() {
  let code;
  do {
    code = randomRoomCode();
  } while (await store.getRoom(code));
  return code;
}

function shuffled(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makePlayer(id, username, colorIndex) {
  return {
    id,
    username,
    chips: STARTING_CHIPS,
    connected: true,
    ready: false, // lobby ready-up only; per-phase readiness lives on the round
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    lastSeenAt: Date.now(),
    disconnectedAt: null,
  };
}

function pickRoundEmojiPlan() {
  const indices = shuffled(EMOJIS.map((_, i) => i)).slice(0, TOTAL_ROUNDS);
  return indices.map((emojiIndex, i) => ({
    roundNumber: i + 1,
    emojiIndex,
    emoji: EMOJIS[emojiIndex],
  }));
}

function newRound(plan) {
  const now = Date.now();
  return {
    roundNumber: plan.roundNumber,
    emoji: plan.emoji,
    drafts: {}, // playerId -> [{ id, text, normalized, submittedAt }]
    entries: [], // populated when writing ends: [{ id, authorIds, text, normalized }]
    bets: {}, // playerId -> { entryId, amount, placedAt }
    votes: {}, // playerId -> [entryId, ...]
    results: null, // populated when voting ends: sorted entries w/ votes/pool/payout/author
    bettorPayouts: null, // populated alongside results: playerId -> chips paid out from bets
    authorBonuses: null, // populated alongside results: playerId -> chips earned from authorship
    phaseEndsAt: null,
    startedAt: now, // == writingStartedAt, kept for backwards-compatible callers
    writingStartedAt: now,
    bettingStartedAt: null,
    votingStartedAt: null,
    revealStartedAt: null,
    // Every significant player action this round, timestamped, in order — the
    // raw timeline analytics (buildGameSessionRecord) derives "decision time"
    // and "time to first input" style Global metrics from, and that lets a
    // full game get reconstructed action-by-action after the fact.
    actionLog: [],
  };
}

// Phase timeouts and stale disconnects used to be resolved by live
// setTimeout handles kept in server.js's process memory -- those can't
// survive across serverless invocations (each request may land on a
// different, isolated instance), so instead every room load "catches up"
// any state that should have already changed by wall-clock time. Mutates
// `room` in place; returns true if anything changed, so the caller knows
// whether to persist it. resolveEndWriting/resolveEndBetting/resolveEndVoting
// are defined further down (pure mutations, no store access) -- this is the
// only place they're called lazily; setPhaseReady() below calls them
// directly too, for the "everyone locked in early" shortcut.
function applyLazyStateUpdates(room) {
  let changed = false;
  const now = Date.now();

  const round = currentRound(room);
  if (round && round.phaseEndsAt && now >= round.phaseEndsAt) {
    if (room.state === 'writing') resolveEndWriting(room);
    else if (room.state === 'betting') resolveEndBetting(room);
    else if (room.state === 'voting') resolveEndVoting(room);
    changed = true;
  }

  // Players who've gone quiet longer than the heartbeat timeout are treated
  // as disconnected -- mirrors what a live socket "disconnect" event used
  // to do immediately.
  for (const id of room.playerOrder) {
    const player = room.players[id];
    if (player && player.connected && now - (player.lastSeenAt || 0) > HEARTBEAT_TIMEOUT_MS) {
      player.connected = false;
      player.disconnectedAt = now;
      changed = true;
    }
  }

  // A seat that's stayed disconnected past the grace period is freed up for
  // real, same as an explicit leave.
  const stale = room.playerOrder.filter((id) => {
    const player = room.players[id];
    return player && !player.connected && player.disconnectedAt && now - player.disconnectedAt > DISCONNECT_GRACE_MS;
  });
  if (stale.length) {
    for (const id of stale) {
      if (room.hostId === id) {
        room.hostId = room.playerOrder.find((pid) => pid !== id && room.players[pid] && room.players[pid].connected) || room.hostId;
      }
      delete room.players[id];
    }
    room.playerOrder = room.playerOrder.filter((id) => !stale.includes(id));
    changed = true;
  }

  return changed;
}

// Every function below reads a room through this instead of calling
// store.getRoom directly, so time-driven state (phase timeouts, stale
// disconnects) is always caught up first. Returns null both when the room
// truly doesn't exist and when resolving staleness just emptied it out.
async function loadRoom(roomCode) {
  for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
    const room = await store.getRoom(roomCode);
    if (!room) return null;
    const changed = applyLazyStateUpdates(room);
    if (room.playerOrder.length === 0) {
      await store.deleteRoom(roomCode);
      return null;
    }
    if (!changed) return room;
    const saved = await store.saveRoom(room, room.version);
    if (saved) return saved;
    // Someone else (another action, a poll-triggered lazy transition) saved
    // first -- loop and retry the transition against the now-current room.
  }
  return store.getRoom(roomCode);
}

// Every *action* (join, start, submit word, place bet, cast vote, ...) goes
// through this instead of a plain read-mutate-save, so two requests racing
// to modify the *same* room can't silently clobber each other. On Vercel
// two concurrent requests for the same room can land on two entirely
// different serverless instances, so an in-process lock can't help here;
// this instead uses the room's version field as an optimistic-concurrency
// token -- the store only accepts a save if the version hasn't moved since
// this read, and if it has, the whole read-mutate-save cycle retries
// against the now-current room instead of overwriting it.
//
// A store.getRoom miss on the very first attempt is retried here too,
// rather than treated as an instant "room not found" -- a cold serverless
// instance's freshly opened Mongo connection can transiently miss a
// document that genuinely exists, and retrying within the same request is
// what actually rides that out instead of failing a real action with no
// recourse.
//
// mutateFn may throw (e.g. "Only the host can start the game") -- that
// propagates immediately, uncaught here, since it's a validation failure
// the caller needs to see, not a concurrency conflict to retry past.
// mutateFn's return value, if any, is threaded back out alongside the saved
// room -- some actions (setPhaseReady, castVote) need to report more than
// just the room's new shape.
async function mutateRoom(roomCode, mutateFn) {
  let everFoundRoom = false;
  for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
    const room = await store.getRoom(roomCode);
    if (!room) continue;
    everFoundRoom = true;
    applyLazyStateUpdates(room);
    if (room.playerOrder.length === 0) {
      await store.deleteRoom(roomCode);
      return { room: null, result: undefined };
    }
    const expectedVersion = room.version;
    const result = mutateFn(room);
    if (room.playerOrder.length === 0) {
      await store.deleteRoom(roomCode);
      return { room: null, result };
    }
    const saved = await store.saveRoom(room, expectedVersion);
    if (saved) return { room: saved, result };
    // Someone else saved first -- loop and retry the mutation against
    // whatever the room actually looks like now.
  }
  if (!everFoundRoom) return { room: null, result: undefined };
  throw err('ROOM_BUSY', 'Room is busy — try again.');
}

// desiredCode, when given, adopts an externally-sourced code (the arcade
// party's room code) instead of generating a random one — "one code,
// sourced from the URL when it's there," per the arcade contract. If a
// room under that code already exists here (e.g. two arcade players both
// landed on this game first), that existing room is joined instead so
// there's still only ever one room per code.
async function createRoom(playerId, username, desiredCode) {
  if (desiredCode) {
    const normalized = String(desiredCode).trim().toUpperCase();
    const existing = await loadRoom(normalized);
    if (existing) return joinRoom(normalized, playerId, username);
  }
  const roomCode = desiredCode ? String(desiredCode).trim().toUpperCase() : await generateUniqueRoomCode();
  const room = {
    roomCode,
    hostId: playerId,
    state: 'lobby', // lobby | writing | betting | voting | reveal | final
    players: {
      [playerId]: makePlayer(playerId, username, 0),
    },
    playerOrder: [playerId],
    totalRounds: TOTAL_ROUNDS,
    roundIndex: -1,
    roundEmojiPlan: [],
    rounds: [],
    phaseReady: {}, // playerId -> true, reset every phase transition
    finalLeaderboard: null,
    createdAt: Date.now(),
    version: 0,
  };
  await store.saveRoom(room); // brand-new room -- nothing to conflict with yet
  return room;
}

// Shared by joinRoom (when the joiner turns out to already be a member) and
// reconnectPlayer, so both go through the exact same mutation.
function applyReconnect(room, playerId, username) {
  const player = room.players[playerId];
  if (!player) throw err('NOT_IN_ROOM', 'You are not in this room.');
  player.connected = true;
  player.disconnectedAt = null;
  player.lastSeenAt = Date.now();
  if (username) player.username = username;
  if (!room.playerOrder.includes(playerId)) room.playerOrder.push(playerId);
}

async function joinRoom(roomCode, playerId, username) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.players[playerId]) {
      applyReconnect(r, playerId, username);
      return;
    }
    if (r.state !== 'lobby') throw err('GAME_IN_PROGRESS', 'That game has already started.');
    if (r.playerOrder.length >= MAX_PLAYERS) throw err('ROOM_FULL', 'That room is full.');
    r.players[playerId] = makePlayer(playerId, username, r.playerOrder.length);
    r.playerOrder.push(playerId);
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

// Used for an explicit rejoin_room call (after a refresh).
async function reconnectPlayer(roomCode, playerId, username) {
  const { room } = await mutateRoom(roomCode, (r) => applyReconnect(r, playerId, username));
  if (!room) throw err('ROOM_NOT_FOUND', 'That room no longer exists.');
  return room;
}

// Called every few seconds by a connected client (there's no persistent
// socket to notice a disconnect anymore) -- keeps a player's presence fresh
// and transparently resumes them if a brief blip had already flagged them
// disconnected. Actual staleness detection happens lazily in
// applyLazyStateUpdates on the next room load, not here.
async function heartbeat(roomCode, playerId) {
  const { room } = await mutateRoom(roomCode, (r) => {
    const player = r.players[playerId];
    if (!player) throw err('NOT_IN_ROOM', 'You are not in this room.');
    player.lastSeenAt = Date.now();
    if (!player.connected) {
      player.connected = true;
      player.disconnectedAt = null;
    }
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room no longer exists.');
  return room;
}

async function getRoom(roomCode) {
  return loadRoom(roomCode);
}

async function setReady(roomCode, playerId, ready) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.state !== 'lobby') throw err('GAME_IN_PROGRESS', 'That game has already started.');
    const player = r.players[playerId];
    if (!player) throw err('NOT_IN_ROOM', 'You are not in this room.');
    player.ready = !!ready;
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

function currentRound(room) {
  return room.roundIndex >= 0 ? room.rounds[room.roundIndex] : null;
}

function allConnectedReady(room) {
  return room.playerOrder.every((id) => {
    const p = room.players[id];
    return !p || !p.connected || room.phaseReady[id];
  });
}

function beginPhase(room, state, seconds) {
  room.state = state;
  room.phaseReady = {};
  const round = currentRound(room);
  const now = Date.now();
  round.phaseEndsAt = now + seconds * 1000;
  if (state === 'betting') round.bettingStartedAt = now;
  else if (state === 'voting') round.votingStartedAt = now;
}

async function startGame(roomCode, requesterId) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.hostId !== requesterId) throw err('NOT_HOST', 'Only the host can start the game.');
    if (r.state !== 'lobby') throw err('GAME_IN_PROGRESS', 'The game has already started.');
    if (r.playerOrder.length < 1) throw err('NOT_ENOUGH_PLAYERS', 'Need at least one player.');
    const allReady = r.playerOrder.every((id) => {
      const player = r.players[id];
      return player && (!player.connected || player.ready);
    });
    if (!allReady) throw err('NOT_ALL_READY', 'Everyone needs to be ready before starting.');

    r.roundEmojiPlan = pickRoundEmojiPlan();
    r.roundIndex = 0;
    r.rounds = [newRound(r.roundEmojiPlan[0])];
    r.finalLeaderboard = null;
    for (const id of r.playerOrder) {
      r.players[id].chips = STARTING_CHIPS;
    }
    beginPhase(r, 'writing', WRITING_SECONDS);
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

// ---------- WRITING ----------

async function submitWord(roomCode, playerId, text) {
  const { room, result: draft } = await mutateRoom(roomCode, (r) => {
    if (r.state !== 'writing') throw err('WRONG_PHASE', 'Writing is not open right now.');
    const player = r.players[playerId];
    if (!player) throw err('NOT_IN_ROOM', 'You are not in this room.');

    const round = currentRound(r);
    const draft = round.drafts[playerId] || (round.drafts[playerId] = []);
    if (draft.length >= MAX_WORDS_PER_PLAYER) throw err('WORD_LIMIT', `You can only submit ${MAX_WORDS_PER_PLAYER} words.`);

    const clean = String(text || '').trim().slice(0, MAX_WORD_LENGTH);
    if (!clean) throw err('EMPTY_WORD', 'Type something first.');
    const normalized = normalizeWord(clean);
    if (draft.some((w) => w.normalized === normalized)) throw err('DUPLICATE_WORD', "You've already written that one.");

    const now = Date.now();
    const word = { id: `w_${playerId}_${draft.length}_${now.toString(36)}`, text: clean, normalized, submittedAt: now };
    draft.push(word);
    round.actionLog.push({ type: 'submit_word', playerId, text: clean, timestamp: now });
    return draft;
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return { room, draft };
}

async function removeWord(roomCode, playerId, wordId) {
  const { room, result: draft } = await mutateRoom(roomCode, (r) => {
    if (r.state !== 'writing') throw err('WRONG_PHASE', 'Writing is not open right now.');
    const round = currentRound(r);
    const draft = round.drafts[playerId] || [];
    round.drafts[playerId] = draft.filter((w) => w.id !== wordId);
    round.actionLog.push({ type: 'remove_word', playerId, wordId, timestamp: Date.now() });
    return round.drafts[playerId];
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return { room, draft };
}

// Flattens every player's private draft into one shuffled, anonymized entry
// pool. Called either when the writing timer expires or once every
// connected player has locked in early.
//
// Entries are merged by normalized text first: if two (or more) players
// independently write "perfect" for the same emoji, that's one pooled entry
// with multiple authorIds — not two competing copies of the same word. They
// split authorship (and any bonus chips it earns) rather than splitting the
// vote against each other.
function flattenEntries(round, playerOrder) {
  const byNormalized = new Map(); // normalized -> entry
  let counter = 0;
  for (const playerId of playerOrder) {
    const draft = round.drafts[playerId] || [];
    for (const word of draft) {
      let entry = byNormalized.get(word.normalized);
      if (!entry) {
        entry = { id: `e${counter++}`, text: word.text, normalized: word.normalized, authorIds: [] };
        byNormalized.set(word.normalized, entry);
      }
      if (!entry.authorIds.includes(playerId)) entry.authorIds.push(playerId);
    }
  }
  return shuffled(Array.from(byNormalized.values()));
}

// Pure mutation -- no store access -- so it can run both lazily (writing's
// clock ran out with nobody around to trigger it) and eagerly (everyone
// connected locked in early via setPhaseReady), both from inside a single
// mutateRoom/loadRoom transaction rather than as a separate DB round-trip.
function resolveEndWriting(room) {
  const round = currentRound(room);
  round.entries = flattenEntries(round, room.playerOrder);

  if (round.entries.length === 0) {
    // Nobody wrote anything this round — nothing to bet or vote on, so skip
    // straight to an empty reveal rather than stalling on empty phases.
    round.results = [];
    finishRoundState(room);
  } else {
    beginPhase(room, 'betting', BETTING_SECONDS);
  }
}

// ---------- BETTING ----------

function poolInfo(round) {
  const poolByEntry = {};
  let totalPool = 0;
  for (const bet of Object.values(round.bets)) {
    poolByEntry[bet.entryId] = (poolByEntry[bet.entryId] || 0) + bet.amount;
    totalPool += bet.amount;
  }
  return { poolByEntry, totalPool };
}

async function placeBet(roomCode, playerId, entryId, amount) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.state !== 'betting') throw err('WRONG_PHASE', 'Betting is not open right now.');
    const player = r.players[playerId];
    if (!player) throw err('NOT_IN_ROOM', 'You are not in this room.');

    const round = currentRound(r);

    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt)) throw err('BAD_AMOUNT', 'Enter a valid chip amount.');
    const now = Date.now();

    if (amt === 0) {
      delete round.bets[playerId];
      round.actionLog.push({ type: 'clear_bet', playerId, timestamp: now });
      return;
    }

    const entry = round.entries.find((e) => e.id === entryId);
    if (!entry) throw err('BAD_ENTRY', 'That entry no longer exists.');
    // Betting is only off-limits when you're the *sole* author — if someone
    // else independently wrote the same word too, the entry isn't purely
    // yours anymore and you can back it like anyone else's entry.
    if (isSoleAuthor(entry, playerId)) throw err('OWN_ENTRY', "You can't bet on your own entry.");
    if (amt < MIN_BET) throw err('BET_TOO_LOW', `Minimum bet is ${MIN_BET} chips.`);
    if (amt > player.chips) throw err('BET_TOO_HIGH', "You don't have that many chips.");

    round.bets[playerId] = { entryId, amount: amt, placedAt: now };
    round.actionLog.push({ type: 'place_bet', playerId, entryId, amount: amt, timestamp: now });
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

// Pure mutation -- see resolveEndWriting's comment for why.
function resolveEndBetting(room) {
  beginPhase(room, 'voting', VOTING_SECONDS);
}

// ---------- VOTING ----------

async function castVote(roomCode, playerId, entryId) {
  const { room, result: myVotes } = await mutateRoom(roomCode, (r) => {
    if (r.state !== 'voting') throw err('WRONG_PHASE', 'Voting is not open right now.');
    if (!r.players[playerId]) throw err('NOT_IN_ROOM', 'You are not in this room.');

    const round = currentRound(r);
    const entry = round.entries.find((e) => e.id === entryId);
    if (!entry) throw err('BAD_ENTRY', 'That entry no longer exists.');
    if (entry.authorIds.includes(playerId)) throw err('OWN_ENTRY', "You can't vote for your own entry.");

    const myVotes = round.votes[playerId] || (round.votes[playerId] = []);
    const existingIndex = myVotes.indexOf(entryId);
    const now = Date.now();
    if (existingIndex >= 0) {
      // Toggle off — tapping a heart you've already spent gives it back.
      myVotes.splice(existingIndex, 1);
      round.actionLog.push({ type: 'unvote', playerId, entryId, timestamp: now });
    } else {
      if (myVotes.length >= VOTES_PER_PLAYER) throw err('NO_VOTES_LEFT', "You're out of votes.");
      myVotes.push(entryId);
      round.actionLog.push({ type: 'cast_vote', playerId, entryId, timestamp: now });
    }
    return myVotes;
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return { room, myVotes };
}

function voteCounts(round) {
  const counts = {};
  for (const entry of round.entries) counts[entry.id] = 0;
  for (const votes of Object.values(round.votes)) {
    for (const entryId of votes) counts[entryId] = (counts[entryId] || 0) + 1;
  }
  return counts;
}

// Computes the full, from-here-on-public result set for the round: vote
// counts, pari-mutuel payouts for anyone who backed a winning entry, and the
// small per-vote / winner-bonus chips every author earns. Mutates player
// chip balances directly since this only ever runs once per round, right as
// betting/voting close for good.
function resolveRound(room) {
  const round = currentRound(room);
  const counts = voteCounts(round);
  const { poolByEntry, totalPool } = poolInfo(round);

  const maxVotes = round.entries.length ? Math.max(0, ...round.entries.map((e) => counts[e.id] || 0)) : 0;
  const winnerIds = maxVotes > 0 ? round.entries.filter((e) => counts[e.id] === maxVotes).map((e) => e.id) : [];
  const winningPool = winnerIds.reduce((sum, id) => sum + (poolByEntry[id] || 0), 0);

  const payouts = {}; // playerId -> chips paid out this round (bet winnings)
  if (winningPool > 0) {
    for (const [playerId, bet] of Object.entries(round.bets)) {
      const player = room.players[playerId];
      if (!player) continue;
      player.chips = Math.max(0, player.chips - bet.amount);
      if (winnerIds.includes(bet.entryId)) {
        const payout = Math.floor((bet.amount / winningPool) * totalPool);
        player.chips += payout;
        payouts[playerId] = (payouts[playerId] || 0) + payout;
      }
    }
  }
  // If nobody backed the winner (or nobody voted at all), bets are left
  // untouched — a wash rather than chips vanishing into nowhere.

  // playerId -> bonus chips earned this round. When an entry has more than
  // one author (two players independently wrote the same word), its bonus
  // chips are split evenly between them rather than paid out twice.
  const authorBonuses = {};
  const entryBonusTotals = {}; // entryId -> total bonus chips awarded to that entry's author(s), for display

  function awardEntryBonus(entry, amount) {
    if (amount <= 0) return;
    entryBonusTotals[entry.id] = (entryBonusTotals[entry.id] || 0) + amount;
    const share = Math.floor(amount / entry.authorIds.length);
    for (const authorId of entry.authorIds) {
      authorBonuses[authorId] = (authorBonuses[authorId] || 0) + share;
    }
  }

  for (const entry of round.entries) {
    const votes = counts[entry.id] || 0;
    awardEntryBonus(entry, votes * AUTHOR_VOTE_BONUS);
  }
  if (winnerIds.length > 0) {
    const share = Math.floor(WINNER_BONUS / winnerIds.length);
    for (const entryId of winnerIds) {
      awardEntryBonus(round.entries.find((e) => e.id === entryId), share);
    }
  }
  for (const [playerId, bonus] of Object.entries(authorBonuses)) {
    const player = room.players[playerId];
    if (player) player.chips += bonus;
  }

  round.results = round.entries
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      authorIds: entry.authorIds,
      authors: entry.authorIds.map((id) => ({
        id,
        username: (room.players[id] || {}).username || 'Unknown',
        color: (room.players[id] || {}).color || '#999',
      })),
      votes: counts[entry.id] || 0,
      pool: poolByEntry[entry.id] || 0,
      isWinner: winnerIds.includes(entry.id),
      payoutTotal: Object.entries(round.bets)
        .filter(([, bet]) => bet.entryId === entry.id)
        .reduce((sum, [playerId]) => sum + (payouts[playerId] || 0), 0),
      authorBonus: entryBonusTotals[entry.id] || 0,
    }))
    .sort((a, b) => b.votes - a.votes);

  round.bettorPayouts = payouts;
  round.authorBonuses = authorBonuses;
}

function finishRoundState(room) {
  const isFinalRound = room.roundIndex >= room.totalRounds - 1;
  if (isFinalRound) {
    room.state = 'final';
    room.finalLeaderboard = buildLeaderboard(room);
  } else {
    room.state = 'reveal';
  }
  room.phaseReady = {};
}

// Pure mutation -- see resolveEndWriting's comment for why.
function resolveEndVoting(room) {
  currentRound(room).revealStartedAt = Date.now();
  resolveRound(room);
  finishRoundState(room);
}

// ---------- PHASE READY-UP (early advance) ----------
// Mirrors the lobby's ready-up pattern for each timed phase — lets a room
// move on the moment everyone's done instead of always burning the full
// clock. When toggling ready makes everyone connected ready, the matching
// resolveEnd* runs immediately inside this same mutateRoom transaction --
// there's no live timer left to separately fire, and doing it in the same
// atomic step (rather than as a second read-mutate-save right after) is
// actually more correct than the old two-step Socket.IO version was.
async function setPhaseReady(roomCode, playerId, phase) {
  const { room, result: allReady } = await mutateRoom(roomCode, (r) => {
    if (r.state !== phase) throw err('WRONG_PHASE', 'That phase is not active right now.');
    if (!r.players[playerId]) throw err('NOT_IN_ROOM', 'You are not in this room.');

    r.phaseReady[playerId] = !r.phaseReady[playerId];
    const round = currentRound(r);
    if (round) {
      round.actionLog.push({ type: 'phase_ready', playerId, phase, ready: r.phaseReady[playerId], timestamp: Date.now() });
    }
    const ready = allConnectedReady(r);
    if (ready) {
      if (r.state === 'writing') resolveEndWriting(r);
      else if (r.state === 'betting') resolveEndBetting(r);
      else if (r.state === 'voting') resolveEndVoting(r);
    }
    return ready;
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return { room, allReady };
}

// ---------- ROUND / GAME ADVANCE ----------

async function nextRound(roomCode, requesterId) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.hostId !== requesterId) throw err('NOT_HOST', 'Only the host can advance the round.');
    if (r.state !== 'reveal') throw err('WRONG_STATE', 'The round has not finished yet.');
    if (r.roundIndex >= r.totalRounds - 1) throw err('NO_MORE_ROUNDS', 'That was the final round.');

    r.roundIndex += 1;
    r.rounds.push(newRound(r.roundEmojiPlan[r.roundIndex]));
    beginPhase(r, 'writing', WRITING_SECONDS);
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

async function playAgain(roomCode, requesterId) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.hostId !== requesterId) throw err('NOT_HOST', 'Only the host can start a new game.');
    if (r.state !== 'final') throw err('WRONG_STATE', 'The game has not finished yet.');

    r.state = 'lobby';
    r.roundIndex = -1;
    r.rounds = [];
    r.roundEmojiPlan = [];
    r.phaseReady = {};
    r.finalLeaderboard = null;
    for (const id of r.playerOrder) {
      const player = r.players[id];
      if (player) {
        player.chips = STARTING_CHIPS;
        player.ready = false;
      }
    }
  });
  if (!room) throw err('ROOM_NOT_FOUND', 'That room code does not exist.');
  return room;
}

// Full removal — used immediately for an explicit "leave" (Go Home). A
// missed heartbeat instead just flips connected=false via
// applyLazyStateUpdates and keeps the seat warm until its grace period
// actually expires (also handled there).
async function leaveRoom(roomCode, playerId) {
  const { room } = await mutateRoom(roomCode, (r) => {
    if (r.players[playerId]) {
      r.players[playerId].connected = false;
    }
    r.playerOrder = r.playerOrder.filter((id) => id !== playerId);

    const anyoneLeft = r.playerOrder.some((id) => r.players[id] && r.players[id].connected);
    if (!anyoneLeft) {
      // Nobody left connected (some may still be listed mid-grace-period) —
      // tear the room down now rather than leaving zombie seats warm for the
      // full grace period. Emptying playerOrder triggers mutateRoom's own
      // empty-room deletion instead of duplicating that logic here.
      r.playerOrder = [];
      return;
    }

    if (r.hostId === playerId) {
      r.hostId = r.playerOrder.find((id) => r.players[id] && r.players[id].connected) || r.hostId;
    }
  });
  return room;
}

function buildLeaderboard(room) {
  return room.playerOrder
    .map((id) => room.players[id])
    .filter(Boolean)
    .map((p) => ({ id: p.id, username: p.username, chips: p.chips, connected: p.connected, ready: p.ready, color: p.color }))
    .sort((a, b) => b.chips - a.chips);
}

// Shapes a room for the wire, personalized to the requesting player so they
// can see their own private draft/bet/votes and know which pooled entries
// are their own (to greay those out client-side) without that leaking to
// anyone else. Author identity stays out of the payload entirely until the
// round reaches 'reveal'/'final', where round.results already carries it.
function toClientView(room, forPlayerId) {
  const round = currentRound(room);
  const phaseReadyCount = Object.keys(room.phaseReady || {}).filter((id) => room.phaseReady[id]).length;

  let roundView = null;
  if (round) {
    const { poolByEntry, totalPool } = poolInfo(round);
    const publicEntries = round.entries.map((e) => {
      const pool = poolByEntry[e.id] || 0;
      return {
        id: e.id,
        text: e.text,
        pool,
        odds: pool > 0 ? Math.max(1, totalPool / pool) : null,
      };
    });

    roundView = {
      roundNumber: round.roundNumber,
      emoji: round.emoji,
      phaseEndsAt: round.phaseEndsAt,
      entryCount: round.entries.length,
      entries: room.state === 'betting' || room.state === 'voting' ? publicEntries : [],
      totalPool,
      results: round.results || null,
      readyCount: phaseReadyCount,
      totalConnected: room.playerOrder.filter((id) => room.players[id] && room.players[id].connected).length,
    };

    if (forPlayerId && room.players[forPlayerId]) {
      const draft = (round.drafts && round.drafts[forPlayerId]) || [];
      const myBet = round.bets[forPlayerId] || null;
      const myVotes = round.votes[forPlayerId] || [];
      // Any entry you contributed to is off-limits to vote for. Betting is
      // stricter only in the other direction — off-limits solely when
      // you're the entry's *only* author (see isSoleAuthor).
      const myEntryIds = round.entries.filter((e) => e.authorIds.includes(forPlayerId)).map((e) => e.id);
      const myBetExcludedIds = round.entries.filter((e) => isSoleAuthor(e, forPlayerId)).map((e) => e.id);
      roundView.myDraft = draft.map((w) => ({ id: w.id, text: w.text }));
      roundView.myBet = myBet;
      roundView.myVotes = myVotes;
      roundView.myEntryIds = myEntryIds;
      roundView.myBetExcludedIds = myBetExcludedIds;
      roundView.myReady = !!room.phaseReady[forPlayerId];
      roundView.myChips = room.players[forPlayerId].chips;
    }
  }

  return {
    roomCode: room.roomCode,
    hostId: room.hostId,
    state: room.state,
    totalRounds: room.totalRounds,
    maxWordsPerPlayer: MAX_WORDS_PER_PLAYER,
    votesPerPlayer: VOTES_PER_PLAYER,
    minBet: MIN_BET,
    players: buildLeaderboard(room),
    round: roundView,
    finalLeaderboard: room.finalLeaderboard || null,
  };
}

// Finds a player's earliest actionLog entry of a given type this round —
// the raw material "Decision Time" / "Time to First Input" are computed
// from (elapsed time from the relevant phase's start to this timestamp).
function firstAction(actionLog, type, playerId) {
  return actionLog.find((a) => a.type === type && a.playerId === playerId) || null;
}

function msSince(fromTimestamp, toTimestamp) {
  return fromTimestamp && toTimestamp ? toTimestamp - fromTimestamp : null;
}

// Per-round, per-player Global timing metrics (see the CSV's "Global"
// category: Action Timestamp / Decision Time / Time to First Input / Time to
// Correct Answer). This game has no single "correct answer" to time against,
// so that slot is filled by "time to lock in" for each phase instead — the
// closest analogous measure of decision speed this game produces.
function buildPlayerTiming(room, round) {
  const log = round.actionLog || [];
  return room.playerOrder.map((playerId) => {
    const player = room.players[playerId];
    const firstWord = firstAction(log, 'submit_word', playerId);
    const firstBet = firstAction(log, 'place_bet', playerId);
    const firstVote = firstAction(log, 'cast_vote', playerId);
    const writingLockIn = log.find((a) => a.type === 'phase_ready' && a.playerId === playerId && a.phase === 'writing' && a.ready);
    const bettingLockIn = log.find((a) => a.type === 'phase_ready' && a.playerId === playerId && a.phase === 'betting' && a.ready);
    const votingLockIn = log.find((a) => a.type === 'phase_ready' && a.playerId === playerId && a.phase === 'voting' && a.ready);

    return {
      playerId,
      username: player ? player.username : 'Unknown',
      timeToFirstInputMs: msSince(round.writingStartedAt, firstWord && firstWord.timestamp),
      wordsSubmittedCount: log.filter((a) => a.type === 'submit_word' && a.playerId === playerId).length,
      timeToWritingLockInMs: msSince(round.writingStartedAt, writingLockIn && writingLockIn.timestamp),
      timeToFirstBetMs: msSince(round.bettingStartedAt, firstBet && firstBet.timestamp),
      betAmount: (round.bets[playerId] && round.bets[playerId].amount) || 0,
      timeToBettingLockInMs: msSince(round.bettingStartedAt, bettingLockIn && bettingLockIn.timestamp),
      timeToFirstVoteMs: msSince(round.votingStartedAt, firstVote && firstVote.timestamp),
      votesCastCount: (round.votes[playerId] || []).length,
      timeToVotingLockInMs: msSince(round.votingStartedAt, votingLockIn && votingLockIn.timestamp),
    };
  });
}

// Full detail per pooled keyword entry: who wrote it (and how many
// independently converged on it — the "overlap" signal), who bet on it and
// for how much, who voted for it, and how it paid out.
function buildEntryDetail(room, round) {
  return round.entries.map((entry) => {
    const resultRow = (round.results || []).find((r) => r.id === entry.id) || {};
    const voterIds = Object.entries(round.votes)
      .filter(([, entryIds]) => entryIds.includes(entry.id))
      .map(([playerId]) => playerId);
    const bets = Object.entries(round.bets)
      .filter(([, bet]) => bet.entryId === entry.id)
      .map(([playerId, bet]) => ({
        playerId,
        username: (room.players[playerId] || {}).username || 'Unknown',
        amount: bet.amount,
        placedAt: bet.placedAt ? new Date(bet.placedAt) : null,
      }));

    return {
      entryId: entry.id,
      text: entry.text,
      normalizedKeyword: entry.normalized,
      authorIds: entry.authorIds,
      authorUsernames: entry.authorIds.map((id) => (room.players[id] || {}).username || 'Unknown'),
      independentAuthors: entry.authorIds.length, // how many players independently typed this exact keyword this round
      votes: resultRow.votes || 0,
      voterIds,
      voterUsernames: voterIds.map((id) => (room.players[id] || {}).username || 'Unknown'),
      pool: resultRow.pool || 0,
      bets,
      isWinner: resultRow.isWinner || false,
      payoutTotal: resultRow.payoutTotal || 0,
      authorBonus: resultRow.authorBonus || 0,
    };
  });
}

// Shapes a completed game into the document written to the `gamesessions`
// collection, plus the flat entry list `recordKeywordStats` upserts from.
function buildGameSessionRecord(room) {
  const playedRounds = room.rounds.filter((r) => r.results);
  const gameStartedAt = playedRounds.length ? playedRounds[0].writingStartedAt : room.createdAt;
  const gameEndedAt = Date.now();

  const rounds = playedRounds.map((round) => {
    const entries = buildEntryDetail(room, round);
    const overlappingEntries = entries.filter((e) => e.independentAuthors > 1);
    return {
      roundNumber: round.roundNumber,
      emoji: round.emoji,
      roundStartedAt: new Date(round.writingStartedAt),
      // Global: phase-by-phase timestamps this round moved through.
      writingStartedAt: new Date(round.writingStartedAt),
      bettingStartedAt: round.bettingStartedAt ? new Date(round.bettingStartedAt) : null,
      votingStartedAt: round.votingStartedAt ? new Date(round.votingStartedAt) : null,
      revealStartedAt: round.revealStartedAt ? new Date(round.revealStartedAt) : null,
      entries,
      // Keyword-overlap summary: did two+ players independently type the same
      // word this round, and how often across the whole round.
      overlapSummary: {
        uniqueEntryCount: entries.length,
        overlappingEntryCount: overlappingEntries.length,
        maxIndependentAuthors: entries.length ? Math.max(...entries.map((e) => e.independentAuthors)) : 0,
        totalIndependentSubmissions: entries.reduce((sum, e) => sum + e.independentAuthors, 0),
      },
      // Global: per-player decision-time / time-to-first-input / lock-in timing.
      playerTiming: buildPlayerTiming(room, round),
      // Global: the full, timestamped action-by-action timeline for this
      // round — every write/remove/bet/vote/lock-in, in order.
      actionLog: (round.actionLog || []).map((a) => ({ ...a, timestamp: new Date(a.timestamp) })),
    };
  });

  const finalPlayers = room.finalLeaderboard || buildLeaderboard(room);

  // Per-player packaged stats for this game, aggregated across every round —
  // this is what both the embedded `players` array below and the rolling
  // `players` collection (see recordPlayerResults in ../data/mongo.js) are
  // built from.
  const players = finalPlayers.map((p) => {
    let wordsSubmitted = 0;
    let votesCast = 0;
    let votesReceived = 0;
    let entriesWon = 0;
    let chipsBetTotal = 0;
    let chipsWonFromBets = 0;
    let chipsWonFromAuthoring = 0;

    for (const round of playedRounds) {
      for (const entry of round.entries) {
        if (!entry.authorIds.includes(p.id)) continue;
        wordsSubmitted += 1;
        const resultRow = (round.results || []).find((r) => r.id === entry.id);
        if (resultRow) {
          votesReceived += resultRow.votes;
          if (resultRow.isWinner) entriesWon += 1;
        }
      }
      votesCast += (round.votes[p.id] || []).length;
      if (round.bets[p.id]) chipsBetTotal += round.bets[p.id].amount;
      chipsWonFromBets += (round.bettorPayouts && round.bettorPayouts[p.id]) || 0;
      chipsWonFromAuthoring += (round.authorBonuses && round.authorBonuses[p.id]) || 0;
    }

    return {
      playerId: p.id,
      username: p.username,
      color: p.color,
      finalChips: p.chips,
      startingChips: STARTING_CHIPS,
      netChipChange: p.chips - STARTING_CHIPS,
      wordsSubmitted,
      votesCast,
      votesReceived,
      entriesWon,
      chipsBetTotal,
      chipsWonFromBets,
      chipsWonFromAuthoring,
    };
  });

  // One row per pooled (already-deduplicated) entry — `independentAuthors`
  // preserves the signal that N players in this single game independently
  // converged on the same word, which recordKeywordStats folds into
  // timesSubmitted so that convergence still counts toward the cross-game
  // pattern it's meant to surface.
  const keywordEntries = [];
  for (const round of playedRounds) {
    for (const entry of round.entries) {
      const resultRow = (round.results || []).find((r) => r.id === entry.id);
      keywordEntries.push({
        emoji: round.emoji,
        text: entry.text,
        normalizedKeyword: entry.normalized,
        votes: resultRow ? resultRow.votes : 0,
        won: resultRow ? resultRow.isWinner : false,
        independentAuthors: entry.authorIds.length,
      });
    }
  }

  return {
    game: 'Emoji Auction',
    roomCode: room.roomCode,
    language: 'en',
    // Global: session start/end/duration.
    gameStartedAt: new Date(gameStartedAt),
    gameEndedAt: new Date(gameEndedAt),
    totalDurationMs: gameEndedAt - gameStartedAt,
    totalRounds: room.totalRounds,
    players,
    rounds,
    keywordEntries,
  };
}

// Marks a finished room's analytics as already recorded, so a concurrent or
// repeated poll doesn't write a duplicate gamesession document. Best-effort
// like the rest of the analytics path -- app.js calls this right after
// saveGameSessionAnalytics() succeeds. Needed now that reaching 'final' can
// happen from more than one concurrent code path (a lazy poll-triggered
// transition racing an eager setPhaseReady early-advance), where before
// there was only ever one live timer firing it once.
async function markAnalyticsSaved(roomCode) {
  const room = await store.getRoom(roomCode);
  if (!room) return;
  room.analyticsSaved = true;
  await store.saveRoom(room);
}

module.exports = {
  TOTAL_ROUNDS,
  WRITING_SECONDS,
  BETTING_SECONDS,
  VOTING_SECONDS,
  MAX_WORDS_PER_PLAYER,
  VOTES_PER_PLAYER,
  STARTING_CHIPS,
  MIN_BET,
  createRoom,
  joinRoom,
  reconnectPlayer,
  heartbeat,
  getRoom,
  setReady,
  startGame,
  submitWord,
  removeWord,
  placeBet,
  castVote,
  setPhaseReady,
  nextRound,
  playAgain,
  leaveRoom,
  buildLeaderboard,
  buildGameSessionRecord,
  toClientView,
};
