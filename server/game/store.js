// Storage abstraction for room state.
//
// Everything the game touches goes through this module instead of a raw Map,
// and every room/player is a plain JSON-serializable object (no class instances,
// no closures). That means swapping this in-memory Map for MongoDB later is just
// a matter of reimplementing these four functions against a `rooms` collection
// (e.g. findOne/replaceOne/deleteOne by roomCode) — nothing in game/roomManager.js
// or the socket handlers needs to change.

const rooms = new Map();

async function getRoom(roomCode) {
  return rooms.get(roomCode) || null;
}

async function saveRoom(room) {
  rooms.set(room.roomCode, room);
  return room;
}

async function deleteRoom(roomCode) {
  rooms.delete(roomCode);
}

async function listRoomCodes() {
  return Array.from(rooms.keys());
}

module.exports = { getRoom, saveRoom, deleteRoom, listRoomCodes };
