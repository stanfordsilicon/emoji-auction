// Vercel serverless entrypoint. Vercel's Node builder accepts an exported
// Express app directly (it's a valid (req, res) request handler) — this
// just re-exports the same app used locally by server/server.js, so the two
// environments run identical route logic.
module.exports = require('../server/app');
