"use strict";
/*
 * QMoji Arcade client.
 *
 * Shared across qmoji-2 (the homescreen) and every game repo. Talks only to
 * the arcade API's three things: room code, roster, language — never
 * gameplay data, which stays in each game's own Mongo cluster untouched.
 *
 * Locally, requests go through this app's own dev server at
 * /arcade-api/v1/* (proxied server-side to the real API) because the real
 * API's CORS allowlist covers *.vercel.app and specific onrender.com
 * origins, not localhost. In production, requests go straight to the API.
 */
(function (global) {
  var PROD_API = "https://qmoji-arcade-api.vercel.app/api/v1";
  var PROD_HOMESCREEN = "https://qmoji-2.vercel.app";
  var LOCAL_HOMESCREEN = "http://localhost:5500";

  function isLocal() {
    return location.hostname === "localhost" || location.hostname === "127.0.0.1";
  }

  var API_BASE = isLocal() ? "/arcade-api/v1" : PROD_API;

  function homescreenUrl() {
    return isLocal() ? LOCAL_HOMESCREEN : PROD_HOMESCREEN;
  }

  // ---------------------------------------------------------------
  // Local player identity — a stable UUID cached in localStorage so
  // reloads and repeat visits reuse the same party member instead of
  // cloning them (the API already dedupes join calls on playerId).
  // ---------------------------------------------------------------
  var ID_KEY = "qmoji.arcade.playerId";
  var NAME_KEY = "qmoji.arcade.playerName";

  function getSavedPlayerId() {
    try { return localStorage.getItem(ID_KEY) || null; } catch (e) { return null; }
  }
  function savePlayerId(id) {
    if (!id) return;
    try { localStorage.setItem(ID_KEY, id); } catch (e) {}
  }
  function getSavedPlayerName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; }
  }
  function savePlayerName(name) {
    if (!name) return;
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  }
  function newUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function ensurePlayerId() {
    var id = getSavedPlayerId();
    if (!id) {
      id = newUuid();
      savePlayerId(id);
    }
    return id;
  }

  // ---------------------------------------------------------------
  // API calls — mirrors the contract's §2/§6 endpoints exactly.
  // ---------------------------------------------------------------
  function ArcadeError(code, message) {
    this.name = "ArcadeError";
    this.code = code;
    this.message = message;
  }
  ArcadeError.prototype = Object.create(Error.prototype);

  async function apiFetch(path, options) {
    return fetch(API_BASE + path, options);
  }

  async function createRoom(hostName, language) {
    var res = await apiFetch("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostName: hostName, language: language || "en" }),
    });
    if (!res.ok) throw new ArcadeError("unknown", "Could not create room");
    var room = await res.json();
    savePlayerId(room.playerId);
    savePlayerName(hostName);
    return room;
  }

  async function joinRoom(code, name, playerId) {
    var body = { name: name };
    var existingId = playerId || getSavedPlayerId();
    if (existingId) body.playerId = existingId;
    var res = await apiFetch("/rooms/" + encodeURIComponent(String(code).toUpperCase()) + "/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 404) throw new ArcadeError("not_found", "No room with that code");
    if (res.status === 409) throw new ArcadeError("conflict", "Room is full, or that name is taken");
    if (!res.ok) throw new ArcadeError("unknown", "Could not join room");
    var room = await res.json();
    savePlayerId(room.playerId);
    savePlayerName(name);
    return room;
  }

  async function getRoom(code) {
    if (!code) return null;
    var res = await apiFetch("/rooms/" + encodeURIComponent(String(code).toUpperCase()));
    if (!res.ok) return null;
    return res.json();
  }

  async function setLanguage(code, language) {
    var res = await apiFetch("/rooms/" + encodeURIComponent(String(code).toUpperCase()) + "/language", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: language }),
    });
    if (!res.ok) throw new ArcadeError("unknown", "Could not set language");
    return res.json();
  }

  // ---------------------------------------------------------------
  // Roster polling — lobby-only. Games fetch the room once on load
  // and never poll, per the contract's explicit "don't poll from
  // inside a game."
  // ---------------------------------------------------------------
  function createPoller(code, onUpdate, intervalMs) {
    var timer = null;
    return {
      start: function () {
        if (timer) return;
        timer = setInterval(async function () {
          var fresh = await getRoom(code);
          if (fresh) onUpdate(fresh);
        }, intervalMs || 3000);
      },
      stop: function () {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  }

  // ---------------------------------------------------------------
  // URL params in/out
  // ---------------------------------------------------------------
  function readParams() {
    var params = new URLSearchParams(location.search);
    return {
      room: params.get("room"),
      lang: params.get("lang"),
      player: params.get("player"),
    };
  }

  // Called once on load by every game. Returns null (never throws) when
  // there's no room param or the lookup fails — the caller's existing
  // standalone start screen is always the fallback, per the contract:
  // "the arcade layer is an enhancement, not a dependency."
  async function initArcade() {
    var params = readParams();
    if (!params.room) return null;
    var room = await getRoom(params.room);
    if (!room) return null;
    if (params.player) savePlayerId(params.player);
    if (params.lang) {
      // Plumbing only for now: receive/store the ISO code so it round-trips
      // correctly. On-screen translation wiring lands in a later pass.
      try { localStorage.setItem("qmoji.lang", params.lang); } catch (e) {}
      document.documentElement.lang = params.lang;
    }
    return { room: room, roomCode: params.room, lang: params.lang || room.language, playerId: params.player };
  }

  function launchUrl(baseUrl, roomCode, lang, playerId) {
    var url = new URL(baseUrl);
    if (roomCode) url.searchParams.set("room", roomCode);
    if (lang) url.searchParams.set("lang", lang);
    if (playerId) url.searchParams.set("player", playerId);
    return url.toString();
  }

  function backToHomescreenUrl(roomCode, lang, playerId) {
    return launchUrl(homescreenUrl(), roomCode, lang, playerId);
  }

  global.QMojiArcade = {
    ArcadeError: ArcadeError,
    isLocal: isLocal,
    API_BASE: API_BASE,
    homescreenUrl: homescreenUrl,
    ensurePlayerId: ensurePlayerId,
    getSavedPlayerId: getSavedPlayerId,
    savePlayerId: savePlayerId,
    getSavedPlayerName: getSavedPlayerName,
    savePlayerName: savePlayerName,
    createRoom: createRoom,
    joinRoom: joinRoom,
    getRoom: getRoom,
    setLanguage: setLanguage,
    createPoller: createPoller,
    readParams: readParams,
    initArcade: initArcade,
    launchUrl: launchUrl,
    backToHomescreenUrl: backToHomescreenUrl,
  };
})(window);
