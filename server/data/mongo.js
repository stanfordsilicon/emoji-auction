// MongoDB connection for gameplay analytics — completely separate from the
// in-memory room store in ../game/store.js, which holds *live* game state.
// This module only persists finished game sessions plus rolling per-player
// and per-keyword aggregates. Deliberately best-effort: if it's unset or
// unreachable, the game keeps working exactly as before, just without
// analytics.
//
// Configuration (set these on the host, e.g. Render's Environment tab):
//   MONGODB_URI            - full connection string (required)
//   MONGODB_TLS_CERT_PATH  - path to a client .pem cert, only needed when
//                            the URI uses MONGODB-X509 auth
//   MONGODB_DB_NAME        - defaults to "emojiauction_data"

const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let connecting = null;

async function connectMongo() {
  if (db) return db;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[mongo] MONGODB_URI not set — game session analytics are disabled.');
    return null;
  }

  const options = {};
  if (process.env.MONGODB_TLS_CERT_PATH) {
    options.tlsCertificateKeyFile = process.env.MONGODB_TLS_CERT_PATH;
  }

  connecting = (async () => {
    try {
      client = new MongoClient(uri, options);
      await client.connect();
      db = client.db(process.env.MONGODB_DB_NAME || 'emojiauction_data');
      console.log('[mongo] Connected — game session analytics enabled.');

      db.collection('gamesessions')
        .createIndexes([{ key: { roomCode: 1 } }, { key: { gameStartedAt: -1 } }])
        .catch((e) => console.error('[mongo] Index creation failed:', e.message));

      db.collection('players')
        .createIndexes([{ key: { username: 1 }, unique: true }])
        .catch((e) => console.error('[mongo] Player index creation failed:', e.message));

      // Unique per (emoji, normalizedKeyword) pair — this is the collection
      // that answers "is this a fluke or a pattern": one document per word
      // ever submitted for a given emoji, incremented every time it recurs
      // across any game, by any group.
      db.collection('keywordstats')
        .createIndexes([{ key: { emoji: 1, normalizedKeyword: 1 }, unique: true }, { key: { timesSubmitted: -1 } }])
        .catch((e) => console.error('[mongo] Keyword index creation failed:', e.message));

      return db;
    } catch (e) {
      console.error('[mongo] Connection failed — analytics disabled:', e.message);
      client = null;
      db = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

function getDb() {
  return db;
}

// Rolling per-player stats across every game ever played, keyed by username.
// `players` here is the packaged per-game array built in
// roomManager.buildGameSessionRecord() — each entry already carries a full
// breakdown (words written, votes cast/received, chips bet vs. won from
// bets vs. won from authorship), so this is a straight $inc rollup of that.
async function recordPlayerResults(players) {
  if (!db || !players || !players.length) return;
  const collection = db.collection('players');
  const now = new Date();

  await Promise.all(
    players.map((p) =>
      collection
        .updateOne(
          { username: p.username },
          {
            $inc: {
              gamesPlayed: 1,
              totalChipsWon: p.finalChips,
              totalWordsSubmitted: p.wordsSubmitted,
              totalVotesCast: p.votesCast,
              totalVotesReceived: p.votesReceived,
              totalEntriesWon: p.entriesWon,
              totalChipsBet: p.chipsBetTotal,
              totalChipsWonFromBets: p.chipsWonFromBets,
              totalChipsWonFromAuthoring: p.chipsWonFromAuthoring,
            },
            $max: { bestChipBalance: p.finalChips },
            $set: { lastPlayedAt: now },
          },
          { upsert: true }
        )
        .catch((e) => console.error(`[mongo] Failed to update player stats for "${p.username}":`, e.message))
    )
  );
}

// Rolling per-(emoji, keyword) stats across every game ever played — the
// piece that turns "one group wrote 'cool' for 😎" into "N groups
// independently wrote 'cool' for 😎, M of which won the vote."
async function recordKeywordStats(entries) {
  if (!db || !entries || !entries.length) return;
  const collection = db.collection('keywordstats');
  const now = new Date();

  await Promise.all(
    entries.map((e) =>
      collection
        .updateOne(
          { emoji: e.emoji, normalizedKeyword: e.normalizedKeyword },
          {
            $inc: { timesSubmitted: e.independentAuthors || 1, timesWon: e.won ? 1 : 0, totalVotes: e.votes },
            $set: { lastSeenAt: now, displayText: e.text },
          },
          { upsert: true }
        )
        .catch((err) => console.error(`[mongo] Failed to update keyword stats for "${e.normalizedKeyword}" (${e.emoji}):`, err.message))
    )
  );
}

module.exports = { connectMongo, getDb, recordPlayerResults, recordKeywordStats };
