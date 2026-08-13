// Storage abstraction for room state.
//
// Everything the game touches goes through this module instead of a raw Map,
// and every room/player is a plain JSON-serializable object (no class
// instances, no closures) — that's what makes both backends below
// interchangeable without game/roomManager.js knowing which one is live.
//
// Locally (no MONGODB_URI set) rooms live in an in-memory Map, same as
// always -- zero setup needed to run the game. On a serverless host like
// Vercel, every request can land on a different, isolated instance with its
// own empty Map, so room state has to live somewhere shared: MongoDB, reusing
// the connection already used for gamesession/keyword/player analytics
// (../data/mongo.js's connectMongo/getDb), just a different collection
// ("rooms" vs. "gamesessions"/"players"/"keywordstats").
//
// saveRoom(room, expectedVersion) is optimistic-concurrency-aware: pass the
// version the room was at when you read it, and the save only succeeds if
// nothing else has saved a newer version since -- returning null instead of
// silently overwriting a concurrent change. This is what protects two
// requests for the *same* room (e.g. two players' actions landing less than
// one round-trip apart) from racing each other -- an in-process lock can't
// do that on Vercel, where the two requests can land on two entirely
// different serverless instances that know nothing about each other. Pass
// no expectedVersion for an unconditional save (new rooms only).

const { connectMongo, getDb } = require('../data/mongo');

class InMemoryRoomStore {
  constructor() {
    this._rooms = new Map();
  }

  async getRoom(roomCode) {
    return this._rooms.get(roomCode) || null;
  }

  async saveRoom(room, expectedVersion) {
    if (expectedVersion !== undefined) {
      const current = this._rooms.get(room.roomCode);
      if (!current || current.version !== expectedVersion) return null;
    }
    room.version = (room.version || 0) + 1;
    this._rooms.set(room.roomCode, room);
    return room;
  }

  async deleteRoom(roomCode) {
    this._rooms.delete(roomCode);
  }

  async listRoomCodes() {
    return Array.from(this._rooms.keys());
  }
}

class MongoRoomStore {
  async _col() {
    await connectMongo();
    const db = getDb();
    if (!db) throw new Error('MongoDB is not connected — cannot store room state.');
    if (!MongoRoomStore._indexed) {
      MongoRoomStore._indexed = true;
      // Best-effort, fire-and-forget: abandoned rooms self-clean after a
      // day of no activity rather than accumulating forever.
      db.collection('rooms')
        .createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 })
        .catch((e) => console.error('[rooms] Index creation failed:', e.message));
    }
    return db.collection('rooms');
  }

  async getRoom(roomCode) {
    const col = await this._col();
    const doc = await col.findOne({ _id: roomCode });
    if (!doc) return null;
    const { _id, updatedAt, ...room } = doc;
    return room;
  }

  async saveRoom(room, expectedVersion) {
    const col = await this._col();
    const newVersion = (room.version || 0) + 1;
    const filter = expectedVersion === undefined
      ? { _id: room.roomCode }
      : { _id: room.roomCode, version: expectedVersion };
    const result = await col.updateOne(
      filter,
      { $set: { ...room, version: newVersion, updatedAt: new Date() } },
      { upsert: expectedVersion === undefined }
    );
    if (expectedVersion !== undefined && result.matchedCount === 0) return null;
    room.version = newVersion;
    return room;
  }

  async deleteRoom(roomCode) {
    const col = await this._col();
    await col.deleteOne({ _id: roomCode });
  }

  async listRoomCodes() {
    const col = await this._col();
    const docs = await col.find({}, { projection: { _id: 1 } }).toArray();
    return docs.map((d) => d._id);
  }
}

// Same DATA_BACKEND resolution already fixed in emoji-muncher-rebuild:
// inferring "mongo" whenever MONGODB_URI is present (even if DATA_BACKEND
// itself isn't explicitly set) closes the exact gap that caused
// intermittent "Room not found" errors there — a serverless instance that
// resolved to the in-memory backend because a second, easy-to-forget env
// var wasn't also set, despite MONGODB_URI being configured correctly.
const DATA_BACKEND = process.env.DATA_BACKEND || (process.env.MONGODB_URI ? 'mongo' : 'memory');

function createRoomStore() {
  return DATA_BACKEND === 'mongo' ? new MongoRoomStore() : new InMemoryRoomStore();
}

module.exports = createRoomStore();
