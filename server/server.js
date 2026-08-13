// Local dev entrypoint. On Vercel, api/index.js re-exports server/app.js
// directly instead — see that file's top comment for why there's no
// http.createServer/Socket.IO here anymore.

const app = require('./app');

const PORT = process.env.PORT || 4336;

// Last-resort safety net: a bug in one room's game loop should never take
// down every other room's live game. Log it and keep serving instead of
// letting Node's default crash-the-process behavior wipe everyone out.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

app.listen(PORT, () => {
  console.log(`Emoji Auction listening on http://localhost:${PORT}`);
});
