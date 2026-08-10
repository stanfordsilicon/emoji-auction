"use strict";

// Server-side proxy for the arcade API, used only by local dev servers.
// Browser calls to the real API from a localhost origin are blocked by its
// CORS allowlist (*.vercel.app / listed onrender.com origins only), so each
// local dev server forwards /arcade-api/v1/* itself — a server-to-server
// request isn't subject to browser CORS at all. Production deploys talk to
// the real API directly and never mount this.
const ARCADE_API_ORIGIN = "https://qmoji-arcade-api.vercel.app";

function arcadeProxy(req, res) {
  const targetPath = req.originalUrl.replace(/^\/arcade-api/, "/api");
  const init = { method: req.method, headers: { "Content-Type": "application/json" } };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = JSON.stringify(req.body || {});
  }
  fetch(ARCADE_API_ORIGIN + targetPath, init)
    .then((upstream) =>
      upstream.text().then((text) => {
        res.status(upstream.status);
        res.type(upstream.headers.get("content-type") || "application/json");
        res.send(text);
      })
    )
    .catch((err) => {
      res.status(502).json({ error: "arcade_proxy_failed", message: err.message });
    });
}

module.exports = { arcadeProxy };
