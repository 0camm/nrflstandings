"use strict";

const http  = require("http");
const https = require("https");

const PORT         = process.env.PORT                              || 3000;
const SECRET       = (process.env.RPL_SECRET   || "").trim();
const RESULTS_MAX  = 500;
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();
const UPSTASH_URL   = (process.env.UPSTASH_REDIS_REST_URL   || process.env.UPSTASH_URL   || "").trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_TOKEN || "").trim();
const GAMEFEED_WEBHOOK = (process.env.DISCORD_GAMEFEED_WEBHOOK || "").trim();
const STATLOG_WEBHOOK  = (process.env.DISCORD_STATLOG_WEBHOOK  || "").trim(); // optional; falls back to state-only logging
const STAT_LOG_MAX     = 5000;
const STATE_KEY     = "rfl-standings-state";
const ARCHIVE_KEY   = "rfl-standings-archive";
const ROBUX_PER_REF_GAME = 40;

if (!ADMIN_SECRET) {
  console.error("[RFL] FATAL: ADMIN_SECRET must be set as an environment variable. Refusing to start with no/default credentials.");
  process.exit(1);
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn("[RFL] WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — standings will NOT persist across restarts.");
}

const NFL_TEAM_INFO = {
  ARI:{name:"Arizona Cardinals",conference:"NFC"}, ATL:{name:"Atlanta Falcons",conference:"NFC"},
  BAL:{name:"Baltimore Ravens",conference:"AFC"},  BUF:{name:"Buffalo Bills",conference:"AFC"},
  CAR:{name:"Carolina Panthers",conference:"NFC"}, CHI:{name:"Chicago Bears",conference:"NFC"},
  CIN:{name:"Cincinnati Bengals",conference:"AFC"},CLE:{name:"Cleveland Browns",conference:"AFC"},
  DAL:{name:"Dallas Cowboys",conference:"NFC"},    DEN:{name:"Denver Broncos",conference:"AFC"},
  DET:{name:"Detroit Lions",conference:"NFC"},     GB:{name:"Green Bay Packers",conference:"NFC"},
  HOU:{name:"Houston Texans",conference:"AFC"},    IND:{name:"Indianapolis Colts",conference:"AFC"},
  JAX:{name:"Jacksonville Jaguars",conference:"AFC"}, KC:{name:"Kansas City Chiefs",conference:"AFC"},
  LV:{name:"Las Vegas Raiders",conference:"AFC"},  LAC:{name:"Los Angeles Chargers",conference:"AFC"},
  LAR:{name:"Los Angeles Rams",conference:"NFC"},  MIA:{name:"Miami Dolphins",conference:"AFC"},
  MIN:{name:"Minnesota Vikings",conference:"NFC"}, NE:{name:"New England Patriots",conference:"AFC"},
  NO:{name:"New Orleans Saints",conference:"NFC"}, NYG:{name:"New York Giants",conference:"NFC"},
  NYJ:{name:"New York Jets",conference:"AFC"},     PHI:{name:"Philadelphia Eagles",conference:"NFC"},
  PIT:{name:"Pittsburgh Steelers",conference:"AFC"},SF:{name:"San Francisco 49ers",conference:"NFC"},
  SEA:{name:"Seattle Seahawks",conference:"NFC"},  TB:{name:"Tampa Bay Buccaneers",conference:"NFC"},
  TEN:{name:"Tennessee Titans",conference:"AFC"},  WSH:{name:"Washington Commanders",conference:"NFC"},
};
const NFL_TEAMS = Object.keys(NFL_TEAM_INFO);
function nflLogo(abb) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${abb.toLowerCase()}.png`; }
function blankRoles() { return { owner: "", gm: "", headCoach: "" }; }
function seedRoster() {
  for (const abb of NFL_TEAMS) {
    const info = NFL_TEAM_INFO[abb];
    state.teams[abb] = {
      wins: 0, losses: 0, ties: 0, pct: "0.000", streak: "—",
      logo: nflLogo(abb),
      name: info.name,
      conference: info.conference,
      roles: blankRoles(),
    };
  }
  console.log(`[RFL] Seeded roster with ${NFL_TEAMS.length} NFL teams for Season 1 (one-time default — fully editable from here on).`);
}

let state = {
  teams:       {},
  results:     [],
  lastUpdated: null,
  auditLog:    [],
  refLog:      [],
  statLog:     [],
};

const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

function upstashRequest(method, path, rawValue) {
  return new Promise((resolve, reject) => {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return resolve({ status: 0, body: {} });
    const parsed = new URL(`${UPSTASH_URL}${path}`);
    const bodyStr = rawValue !== undefined ? String(rawValue) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Authorization": `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type":  "text/plain",
      },
    };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", e => { console.error("[RFL] Upstash request error:", e.message); reject(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let stateLoadedOk = false;

async function loadState() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) { seedRoster(); stateLoadedOk = true; return; }
  try {
    const { status, body } = await upstashRequest("GET", `/get/${STATE_KEY}`);
    if (status !== 200) {
      console.error(`[RFL] FATAL: Upstash GET /get/${STATE_KEY} returned HTTP ${status}. Refusing to start — starting anyway risks seeding a blank roster and then saving over your real data. Check UPSTASH_REDIS_REST_URL/TOKEN and Upstash status, then redeploy.`);
      process.exit(1);
    }
    const parsed = body && body.result ? JSON.parse(body.result) : null;
    if (parsed) {
      state.teams       = parsed.teams       || {};
      state.results     = parsed.results     || [];
      state.lastUpdated = parsed.lastUpdated || null;
      state.auditLog    = parsed.auditLog    || [];
      state.refLog       = parsed.refLog     || [];
      state.statLog      = parsed.statLog    || [];
      console.log("[RFL] Loaded from Upstash:", Object.keys(state.teams).length, "teams");
    }
    stateLoadedOk = true;
  } catch (e) {
    console.error("[RFL] FATAL: loadState failed —", e.message, "— refusing to start. Starting anyway risks seeding a blank roster and then saving over your real data. Redeploy once Upstash is reachable.");
    process.exit(1);
  }
  if (Object.keys(state.teams).length === 0) {
    console.warn("[RFL] Upstash's stored state has 0 teams. Seeding the default roster now. IMPORTANT: if you did not intend to clear the roster, stop and restore from a backup BEFORE any admin action triggers a save — the next save will overwrite Upstash with this fresh 0-0 seed.");
    seedRoster();
  }
}

async function saveState() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  if (!stateLoadedOk) {
    console.error("[RFL] saveState refused: this process never successfully completed loadState(). Not risking a write.");
    return;
  }
  try {
    try {
      const prev = await upstashRequest("GET", `/get/${STATE_KEY}`);
      if (prev.status === 200 && prev.body && prev.body.result) {
        await upstashRequest("POST", `/set/${STATE_KEY}-backup`, prev.body.result);
      }
    } catch (e) { console.error("[RFL] pre-save backup failed (continuing with save):", e.message); }

    const payload = {
      teams:       state.teams,
      results:     state.results,
      lastUpdated: state.lastUpdated,
      auditLog:    state.auditLog,
      refLog:      state.refLog,
      statLog:     state.statLog,
    };
    await upstashRequest("POST", `/set/${STATE_KEY}`, JSON.stringify(payload));
  } catch (e) { console.error("[RFL] saveState error:", e.message); }
}

async function handleRestoreBackup(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  try {
    const { status, body } = await upstashRequest("GET", `/get/${STATE_KEY}-backup`);
    if (status !== 200 || !body || !body.result) {
      return sendJSON(res, 404, { error: "No backup found." });
    }
    const parsed = JSON.parse(body.result);
    state.teams       = parsed.teams       || {};
    state.results     = parsed.results     || [];
    state.lastUpdated = parsed.lastUpdated || null;
    state.auditLog     = parsed.auditLog    || [];
    state.refLog       = parsed.refLog     || [];
    state.statLog      = parsed.statLog    || [];
    stateLoadedOk = true;

    await upstashRequest("POST", `/set/${STATE_KEY}`, body.result);
    broadcast("standings", buildPublicPayload());

    console.log(`[RFL] Restored from backup key: ${Object.keys(state.teams).length} teams, ${state.results.length} results.`);
    return sendJSON(res, 200, { ok: true, teams: Object.keys(state.teams).length, results: state.results.length });
  } catch (e) {
    console.error("[RFL] handleRestoreBackup error:", e.message);
    return sendJSON(res, 500, { error: e.message || "Restore failed" });
  }
}

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === SECRET;
}

function isAdminAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === ADMIN_SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === ADMIN_SECRET;
}

function rebuildStandings() {
  for (const abb of Object.keys(state.teams)) {
    state.teams[abb].wins = 0;
    state.teams[abb].losses = 0;
    state.teams[abb].ties = 0;
    state.teams[abb].pct = "0.000";
    state.teams[abb].streak = "—";
  }
  const ordered = [...state.results].reverse();
  for (const r of ordered) {
    if (r.voided) continue;
    if (!isTerminalStatus(r.status)) continue;

    if (r.status === "tie" || (r.status === "final" && r.homeScore === r.awayScore)) {
      ensureTeam(r.homeABB, r.homeLogo);
      ensureTeam(r.awayABB, r.awayLogo);
      recordTie(r.homeABB, r.awayABB);
      continue;
    }

    let winnerABB = r.winnerABB;
    if (!winnerABB && r.status === "final") {
      if (r.homeScore > r.awayScore) winnerABB = r.homeABB;
      else if (r.awayScore > r.homeScore) winnerABB = r.awayABB;
    }
    if (!winnerABB) continue;
    const loserABB = winnerABB === r.homeABB ? r.awayABB : r.homeABB;
    ensureTeam(winnerABB, winnerABB === r.homeABB ? r.homeLogo : r.awayLogo);
    ensureTeam(loserABB,  loserABB  === r.homeABB ? r.homeLogo : r.awayLogo);
    state.teams[winnerABB].wins += 1;
    state.teams[loserABB].losses += 1;
    state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, "W");
    state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, "L");
  }
  for (const abb of Object.keys(state.teams)) {
    recalcPct(state.teams[abb]);
  }
}

function ensureTeam(abb, logo) {
  if (!abb) return;
  if (!state.teams[abb]) {
    state.teams[abb] = {
      wins: 0, losses: 0, ties: 0, pct: "0.000", streak: "—",
      logo: logo || "", name: "", conference: "", roles: blankRoles(),
    };
  } else {
    if (state.teams[abb].ties === undefined) state.teams[abb].ties = 0;
    if (logo) state.teams[abb].logo = logo;
  }
}

const VALID_CONFERENCES = new Set(["AFC", "NFC"]);
function sanitizeStr(v, maxLen) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen || 60);
}
function sanitizeRoles(r) {
  const src = (r && typeof r === "object") ? r : {};
  return {
    owner:     sanitizeStr(src.owner, 60),
    gm:        sanitizeStr(src.gm, 60),
    headCoach: sanitizeStr(src.headCoach, 60),
  };
}

function recalcPct(t) {
  const total = t.wins + t.losses + (t.ties || 0);
  t.pct = total > 0 ? ((t.wins + 0.5 * (t.ties || 0)) / total).toFixed(3) : "0.000";
}

function updateRecord(winnerABB, loserABB) {
  if (!winnerABB || !loserABB) return;
  ensureTeam(winnerABB);
  ensureTeam(loserABB);
  state.teams[winnerABB].wins  += 1;
  state.teams[loserABB].losses += 1;
  state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, "W");
  state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, "L");
  recalcPct(state.teams[winnerABB]);
  recalcPct(state.teams[loserABB]);
}

function recordTie(aABB, bABB) {
  if (!aABB || !bABB) return;
  ensureTeam(aABB);
  ensureTeam(bABB);
  state.teams[aABB].ties += 1;
  state.teams[bABB].ties += 1;
  state.teams[aABB].streak = updateStreak(state.teams[aABB].streak, "T");
  state.teams[bABB].streak = updateStreak(state.teams[bABB].streak, "T");
  recalcPct(state.teams[aABB]);
  recalcPct(state.teams[bABB]);
}

function updateStreak(current, letter) {
  if (!current || current === "—") return `${letter}1`;
  const curLetter = current[0];
  const curNum    = parseInt(current.slice(1), 10) || 0;
  if (curLetter === letter) return `${letter}${curNum + 1}`;
  return `${letter}1`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 8e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_HITS  = 20;
const rateBuckets = new Map();

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const ip  = getClientIP(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) { if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k); }
  }
  return bucket.count > RATE_LIMIT_MAX_HITS;
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJSON(res, status, data) {
  setCORS(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const GAME_SESSION_WINDOW = 5 * 60 * 1000;
const recentTerminalGames = new Map();

function makeMatchupKey(homeABB, awayABB) { return [homeABB, awayABB].sort().join("|"); }
function isTerminalStatus(status) { return status === "final" || status === "forfeit" || status === "tie"; }

function isDuplicateTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return false;
  const key = makeMatchupKey(homeABB, awayABB);
  const last = recentTerminalGames.get(key);
  if (!last) return false;
  return (Date.now() - last) < GAME_SESSION_WINDOW;
}

function markTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return;
  const key = makeMatchupKey(homeABB, awayABB);
  recentTerminalGames.set(key, Date.now());
  setTimeout(() => recentTerminalGames.delete(key), GAME_SESSION_WINDOW);
}

function parseRefs(refString) {
  if (!refString || refString === "None" || refString === "") return [];
  return refString.split(/[,;\/]/).map(r => r.trim()).filter(r => {
    if (!r) return false;
    if (r.includes(":"))   return false;
    if (r.length > 40)     return false;
    return true;
  });
}

function logRefActivity(refString, gameId, homeABB, awayABB, timestamp) {
  const names = parseRefs(refString);
  const ts = timestamp || new Date().toISOString();
  for (const name of names) {
    state.refLog.unshift({ name, gameId, homeABB, awayABB, timestamp: ts });
  }
  if (state.refLog.length > 5000) state.refLog.length = 5000;
}

function buildRefStats() {
  const map = {};
  for (const result of [...state.results].reverse()) {
    const names = parseRefs(result.referees);
    for (const name of names) {
      if (!map[name]) map[name] = { name, games: 0, lastActive: null, recentGames: [] };
      const r = map[name];
      r.games += 1;
      if (!r.lastActive || result.timestamp > r.lastActive) r.lastActive = result.timestamp;
      if (r.recentGames.length < 5) r.recentGames.push({ gameId: result.id, homeABB: result.homeABB, awayABB: result.awayABB, timestamp: result.timestamp });
    }
  }
  const list = Object.values(map).map(r => ({ ...r, robux: r.games * ROBUX_PER_REF_GAME }));
  return list.sort((a, b) => b.games - a.games || b.lastActive.localeCompare(a.lastActive));
}

function handleGetRefs(req, res) {
  const refs = buildRefStats();
  const totalRobux = refs.reduce((sum, r) => sum + r.robux, 0);
  return sendJSON(res, 200, { refs, robuxPerGame: ROBUX_PER_REF_GAME, totalRobux, lastUpdated: state.lastUpdated });
}

function handleAuth(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { ok: true });
}

function handleAutoReportDisabled(req, res) {
  return sendJSON(res, 410, {
    error: "Automatic score reporting has been disabled for NRFL Season 1. Use the admin panel to add games manually.",
  });
}

async function handleVoidResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id, voided } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const result = state.results.find(r => r.id === id);
  if (!result) return sendJSON(res, 404, { error: "Result not found" });

  result.voided = !!voided;
  state.lastUpdated = new Date().toISOString();

  const action = voided ? "voided" : "unvoided";
  state.auditLog.unshift({
    action,
    gameId:    result.id,
    matchup:   `${result.awayABB} @ ${result.homeABB}`,
    score:     `${result.awayScore}–${result.homeScore}`,
    status:    result.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] Result ${action}: ${result.awayABB} @ ${result.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, action, result });
}

async function handleRemoveResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const idx = state.results.findIndex(r => r.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: "Result not found" });

  const removed = state.results.splice(idx, 1)[0];
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "removed",
    gameId:    removed.id,
    matchup:   `${removed.awayABB} @ ${removed.homeABB}`,
    score:     `${removed.awayScore}–${removed.homeScore}`,
    status:    removed.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] Result removed: ${removed.awayABB} @ ${removed.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, removed });
}


function auditPush(entry) {
  state.auditLog.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (state.auditLog.length > 200) state.auditLog.length = 200;
}

function normIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(x => x !== undefined && x !== null && x !== "").map(String))];
}

async function handleBulkVoid(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const ids = normIds(body.ids);
  if (!ids.length) return sendJSON(res, 422, { error: "No game ids provided" });
  const voided = !!body.voided;
  const idSet = new Set(ids);

  let changed = 0;
  const missing = ids.filter(id => !state.results.some(r => String(r.id) === id));
  for (const r of state.results) {
    if (!idSet.has(String(r.id))) continue;
    if (!!r.voided === voided) continue;
    r.voided = voided;
    changed++;
    auditPush({
      action: voided ? "voided" : "unvoided", gameId: r.id,
      matchup: `${r.awayABB} @ ${r.homeABB}`, score: `${r.awayScore}–${r.homeScore}`, status: r.status,
    });
  }

  state.lastUpdated = new Date().toISOString();
  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());
  console.log(`[RFL] Bulk ${voided ? "void" : "unvoid"}: ${changed} game(s)`);
  return sendJSON(res, 200, { ok: true, changed, missing });
}

async function handleBulkRemove(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const ids = normIds(body.ids);
  if (!ids.length) return sendJSON(res, 422, { error: "No game ids provided" });
  const idSet = new Set(ids);

  const removed = state.results.filter(r => idSet.has(String(r.id)));
  state.results = state.results.filter(r => !idSet.has(String(r.id)));
  for (const r of removed) {
    auditPush({
      action: "removed", gameId: r.id,
      matchup: `${r.awayABB} @ ${r.homeABB}`, score: `${r.awayScore}–${r.homeScore}`, status: r.status,
    });
  }

  state.lastUpdated = new Date().toISOString();
  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());
  console.log(`[RFL] Bulk remove: ${removed.length} game(s)`);
  return sendJSON(res, 200, { ok: true, removed: removed.length });
}

async function handleZeroRecords(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  const teamCount = Object.keys(state.teams).length;
  for (const abb of Object.keys(state.teams)) {
    state.teams[abb].wins   = 0;
    state.teams[abb].losses = 0;
    state.teams[abb].ties   = 0;
    state.teams[abb].pct    = "0.000";
    state.teams[abb].streak = "—";
  }
  state.results     = [];
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "zeroed",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    "zeroed (roster kept)",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] All ${teamCount} team records zeroed to 0-0 (roster/logos kept, match history cleared).`);
  return sendJSON(res, 200, { ok: true, teamsZeroed: teamCount });
}

async function resetState(auditAction) {
  state.teams       = {};
  state.results     = [];
  state.lastUpdated = new Date().toISOString();
  state.auditLog.unshift({
    action:    auditAction || "reset",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    "reset",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();
  broadcast("standings", buildPublicPayload());
}

async function handleReset(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  await resetState("reset");

  console.log("[RFL] Full standings reset.");
  return sendJSON(res, 200, { ok: true });
}

async function handleArchiveAndAdvance(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { archive, label } = body;
  if (archive === undefined) return sendJSON(res, 422, { error: "Missing archive payload" });

  try {
    await upstashRequest("POST", `/set/${ARCHIVE_KEY}`, JSON.stringify(archive));
  } catch (e) {
    console.error("[RFL] Archive save to Upstash failed — aborting reset:", e.message);
    return sendJSON(res, 500, { error: "Archive save failed — standings were NOT reset." });
  }

  state.auditLog.unshift({
    action:    "archived",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    label ? `archived: ${label}` : "archived",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await resetState("season-advance");

  console.log(`[RFL] Season archived${label ? ` ("${label}")` : ""} and standings reset for new season.`);
  return sendJSON(res, 200, { ok: true });
}

function handleGetStandings(req, res) {
  setCORS(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildPublicPayload()));
}

function handleSSE(req, res) {
  setCORS(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: standings\ndata: ${JSON.stringify(buildPublicPayload())}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); }
    catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
}

async function handleTeamOverride(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { abb: rawAbb, wins, losses, ties, streak, logo, name, conference, roles } = body;
  const abb = sanitizeStr(rawAbb, 8).toUpperCase();
  if (!abb) return sendJSON(res, 422, { error: "Missing abb" });
  if (conference !== undefined && conference !== "" && !VALID_CONFERENCES.has(conference)) {
    return sendJSON(res, 422, { error: "conference must be AFC or NFC" });
  }

  ensureTeam(abb, logo);
  const t = state.teams[abb];
  if (wins       !== undefined) t.wins       = Math.max(0, parseInt(wins, 10) || 0);
  if (losses     !== undefined) t.losses     = Math.max(0, parseInt(losses, 10) || 0);
  if (ties       !== undefined) t.ties       = Math.max(0, parseInt(ties, 10) || 0);
  if (streak     !== undefined) t.streak     = sanitizeStr(streak, 10) || "—";
  if (logo       !== undefined) t.logo       = sanitizeStr(logo, 500);
  if (name       !== undefined) t.name       = sanitizeStr(name, 80);
  if (conference !== undefined) t.conference = conference;
  if (roles      !== undefined) t.roles      = sanitizeRoles(roles);
  if (!t.roles) t.roles = blankRoles();
  if (t.ties === undefined) t.ties = 0;

  recalcPct(t);
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());

  state.auditLog.unshift({
    action: "team_edited", gameId: null, matchup: abb,
    score: `${t.wins}W-${t.losses}L-${t.ties || 0}T`, status: t.conference || "",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  console.log(`[RFL] Team edited: ${abb} → ${t.wins}W-${t.losses}L name="${t.name || ""}" conf=${t.conference || "—"} logo=${t.logo ? "✓" : "—"}`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...t } });
}

async function handleAddTeam(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const abb  = sanitizeStr(body.abb, 8).toUpperCase();
  const name = sanitizeStr(body.name, 80);
  const conference = body.conference;

  if (!abb)  return sendJSON(res, 422, { error: "Team abbreviation is required." });
  if (!name) return sendJSON(res, 422, { error: "Team name is required." });
  if (!VALID_CONFERENCES.has(conference)) return sendJSON(res, 422, { error: "Conference must be AFC or NFC." });
  if (state.teams[abb]) return sendJSON(res, 409, { error: `Team "${abb}" already exists — edit it instead of adding it again.` });

  state.teams[abb] = {
    wins: 0, losses: 0, ties: 0, pct: "0.000", streak: "—",
    logo: sanitizeStr(body.logo, 500),
    name, conference,
    roles: sanitizeRoles(body.roles),
  };
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());

  state.auditLog.unshift({
    action: "team_added", gameId: null, matchup: `${abb} — ${name}`,
    score: "0W-0L", status: conference, timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  console.log(`[RFL] Team added manually: ${abb} (${name}, ${conference})`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...state.teams[abb] } });
}

// Remove one or more teams. Because rebuildStandings() re-creates any team that still
// appears in a non-voided result, games involving a removed team are voided (default,
// reversible) or deleted, otherwise the team would reappear on the next rebuild.
async function handleRemoveTeam(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const rawList = Array.isArray(body.abbs) ? body.abbs : (body.abb !== undefined ? [body.abb] : []);
  const abbs = [...new Set(rawList.map(a => sanitizeStr(a, 8).toUpperCase()).filter(Boolean))];
  if (!abbs.length) return sendJSON(res, 422, { error: "Missing abb" });

  const existing = abbs.filter(a => state.teams[a]);
  const missing  = abbs.filter(a => !state.teams[a]);
  if (!existing.length) return sendJSON(res, 404, { error: `Team${abbs.length > 1 ? "s" : ""} not found: ${abbs.join(", ")}` });

  const gameAction = ["void", "delete", "keep"].includes(body.gameAction) ? body.gameAction : "void";
  const gone = new Set(existing);
  const involves = r => gone.has(r.homeABB) || gone.has(r.awayABB);

  let gamesVoided = 0, gamesDeleted = 0;
  if (gameAction === "delete") {
    const before = state.results.length;
    state.results = state.results.filter(r => !involves(r));
    gamesDeleted = before - state.results.length;
  } else if (gameAction === "void") {
    for (const r of state.results) {
      if (involves(r) && !r.voided) { r.voided = true; gamesVoided++; }
    }
  }

  for (const abb of existing) {
    const removedName = state.teams[abb].name || abb;
    delete state.teams[abb];
    auditPush({ action: "team_removed", gameId: null, matchup: `${abb} — ${removedName}`, score: "—", status: "" });
  }

  state.lastUpdated = new Date().toISOString();
  // "keep" leaves games untouched and skips rebuild so the removal sticks until the next rebuild.
  if (gameAction !== "keep") rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] Team(s) removed: ${existing.join(", ")} | games voided=${gamesVoided} deleted=${gamesDeleted}`);
  return sendJSON(res, 200, { ok: true, abb: existing[0], removed: existing, missing, gamesVoided, gamesDeleted });
}

function buildPublicPayload() {
  const sorted = Object.entries(state.teams)
    .map(([abb, data]) => ({ abb, ...data }))
    .sort((a, b) => {
      const pctA = parseFloat(a.pct) || 0;
      const pctB = parseFloat(b.pct) || 0;
      if (pctB !== pctA) return pctB - pctA;
      const gpA = a.wins + a.losses + (a.ties || 0);
      const gpB = b.wins + b.losses + (b.ties || 0);
      if (gpB !== gpA) return gpB - gpA;
      return b.wins - a.wins;
    });
  return { standings: sorted, results: state.results, lastUpdated: state.lastUpdated };
}

async function handleAddGame(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { homeABB, awayABB, homeScore, awayScore, status, quarter, note, season, timestamp } = body;
  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields: homeABB, awayABB, status" });

  let safeStatus = ["final", "forfeit", "tie", "incomplete"].includes(status) ? status : "final";
  const hs  = parseInt(homeScore, 10) || 0;
  const as_ = parseInt(awayScore, 10) || 0;

  // A tie is defined by equal scores. Reject a "tie" whose scores differ, and store an
  // equal-score "final" as a "tie" so the saved result matches how the standings count it.
  if (safeStatus === "tie" && hs !== as_)
    return sendJSON(res, 422, { error: "A tie requires equal scores." });
  if (safeStatus === "final" && hs === as_) safeStatus = "tie";

  ensureTeam(homeABB);
  ensureTeam(awayABB);

  let winnerABB = null;
  if (isTerminalStatus(safeStatus)) {
    if (safeStatus === "tie" || (safeStatus === "final" && hs === as_)) {
      recordTie(homeABB, awayABB);
    } else {
      if (hs > as_)       winnerABB = homeABB;
      else if (as_ > hs)  winnerABB = awayABB;
      if (winnerABB) {
        const loserABB = winnerABB === homeABB ? awayABB : homeABB;
        updateRecord(winnerABB, loserABB);
      }
    }
  }

  const result = {
    id:           Date.now(),
    timestamp:    timestamp || new Date().toISOString(),
    season:       season || "Season 1",
    status:       safeStatus,
    quarter:      quarter || "---",
    note:         note || "",
    homeABB,      awayABB,
    homeLogo:     "",
    awayLogo:     "",
    homeScore:    hs,
    awayScore:    as_,
    winnerABB,
    playerOfGame: null,
    referees:     "None",
    homeStats:    [],
    awayStats:    [],
    manualEntry:  true,
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "added",
    gameId:    result.id,
    matchup:   `${awayABB} @ ${homeABB}`,
    score:     `${as_}–${hs}`,
    status:    safeStatus,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  logRefActivity(result.referees, result.id, homeABB, awayABB, result.timestamp);

  await saveState();
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  console.log(`[RFL] Manual game added: ${awayABB} @ ${homeABB} | ${safeStatus} | ${as_}–${hs}`);
  return sendJSON(res, 200, { ok: true, result });
}

function handleGetAuditLog(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { auditLog: state.auditLog || [] });
}

async function handleGetArchive(req, res) {
  try {
    const { body } = await upstashRequest("GET", `/get/${ARCHIVE_KEY}`);
    const data = body && body.result ? JSON.parse(body.result) : null;
    return sendJSON(res, 200, { data });
  } catch (e) {
    return sendJSON(res, 500, { error: "Archive fetch failed" });
  }
}

async function handleSetArchive(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  try {
    const payload = await readBody(req);
    await upstashRequest("POST", `/set/${ARCHIVE_KEY}`, JSON.stringify(payload));
    return sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error("[RFL] handleSetArchive error:", e.message);
    return sendJSON(res, 400, { error: e.message || "Invalid request" });
  }
}


// ───────────────────────── Discord + stat audit helpers ─────────────────────────
// Stat keys come from the Roblox game (ReplicatedStorage.FootballStats.Config.Stats). Yard stats may be negative.
const FB_STATS = {
  Passing:   [["Comp","CMP"],["Att","ATT"],["PassYds","YDS"],["PassTD","TD"],["INT","INT"]],
  Rushing:   [["RushAtt","ATT"],["RushYds","YDS"],["RushTD","TD"]],
  Receiving: [["Rec","REC"],["RecYds","YDS"],["RecTD","TD"]],
  Defense:   [["Tackles","TKL"],["Sacks","SCK"],["DefINT","INT"],["PBU","PBU"],["FF","FF"]],
  Misc:      [["Fumbles","FUM"]],
};
const FB_KEYS = Object.values(FB_STATS).flat().map(x => x[0]);
const YARD_KEYS = new Set(["PassYds","RushYds","RecYds"]);

function postWebhook(url, payload) {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, error: "webhook not configured" });
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve({ ok: false, error: "invalid webhook url" }); }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => { d += c; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: d, retryAfter: res.headers["retry-after"] }));
    });
    req.on("error", e => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}
async function postWebhookRetry(url, payload) {
  let res = await postWebhook(url, payload);
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, Math.min(10, parseFloat(res.retryAfter) || 2) * 1000));
    res = await postWebhook(url, payload);
  }
  return res;
}

function statTables(players) {
  // One small table per stat category, only players who have a non-zero stat in it.
  const out = [];
  for (const [group, cols] of Object.entries(FB_STATS)) {
    const rows = players.filter(p => cols.some(([k]) => (p.stats[k] || 0) !== 0));
    if (!rows.length) continue;
    const head = "Player".padEnd(16) + cols.map(([, l]) => l.padStart(5)).join("");
    const lines = rows.map(p => String(p.name).slice(0, 15).padEnd(16) + cols.map(([k]) => String(p.stats[k] || 0).padStart(5)).join(""));
    out.push({ group, text: [head, ...lines].join("\n") });
  }
  return out;
}

async function sendFinalToGameFeed(r) {
  const label = r.status === "incomplete" ? "INCOMPLETE (standings NOT updated)"
    : r.status === "tie" ? "FINAL — TIE" : (r.quarter === "OT" ? "FINAL/OT" : "FINAL");
  const homeName = r.homeName || r.homeABB, awayName = r.awayName || r.awayABB;
  const embeds = [{
    title: `${label}: ${awayName} ${r.awayScore} @ ${homeName} ${r.homeScore}`,
    description: [
      r.status === "tie" ? "Result: **Tie**" : (r.winnerABB ? `Winner: **${r.winnerABB}**` : null),
      `Away: ${r.awayABB} (${awayName}) — ${r.awayScore}`,
      `Home: ${r.homeABB} (${homeName}) — ${r.homeScore}`,
      `Ended: ${r.endReason || "—"}`, `Game ID: ${r.gameKey}`,
    ].filter(Boolean).join("\n"),
    timestamp: r.timestamp,
  }];
  for (const [abb, name, players] of [[r.awayABB, awayName, r.awayStats], [r.homeABB, homeName, r.homeStats]]) {
    if (!players.length) { embeds.push({ title: `${abb} — ${name}`, description: "No player stats recorded" }); continue; }
    for (const [i, t] of statTables(players).entries()) {
      embeds.push({ title: i === 0 ? `${abb} — ${name} · ${t.group}` : `${abb} · ${t.group}`, description: "```\n" + t.text.slice(0, 3800) + "\n```" });
    }
  }
  // Discord limits: 10 embeds and 6000 characters per message.
  const messages = []; let cur = [], curLen = 0;
  for (const e of embeds) {
    const len = (e.title || "").length + (e.description || "").length;
    if (cur.length >= 10 || curLen + len > 5500) { messages.push(cur); cur = []; curLen = 0; }
    cur.push(e); curLen += len;
  }
  if (cur.length) messages.push(cur);
  for (const m of messages) {
    const res = await postWebhookRetry(GAMEFEED_WEBHOOK, { embeds: m, allowed_mentions: { parse: [] } });
    if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` };
  }
  return { ok: true };
}

// POST /rpl/game/report — called by StatsReporter in the Roblox game when a game ends. Auth: Bearer RPL_SECRET.
async function handleGameReport(req, res) {
  if (!SECRET) return sendJSON(res, 503, { error: "RPL_SECRET is not set on the server." });
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let b;
  try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const gameKey = sanitizeStr(String(b.gameId ?? ""), 100);
  const homeABB = sanitizeStr(b.homeABB, 8).toUpperCase();
  const awayABB = sanitizeStr(b.awayABB, 8).toUpperCase();
  if (!gameKey) return sendJSON(res, 422, { error: "gameId is required (used to make sure a game is only counted/sent once)." });
  if (!homeABB || !awayABB || homeABB === awayABB) return sendJSON(res, 422, { error: `Need two different team abbreviations (got home="${homeABB}", away="${awayABB}").` });
  if (!Number.isFinite(Number(b.homeScore)) || !Number.isFinite(Number(b.awayScore))) return sendJSON(res, 422, { error: "homeScore and awayScore must be numbers." });

  // Send-once. The gameId is stored on the saved result, so this also holds across server restarts.
  const existing = state.results.find(r => r.gameKey === gameKey);
  if (existing) {
    if (!existing.webhookSentAt && GAMEFEED_WEBHOOK) { // saved earlier but Discord failed → retry; never double-counts standings
      const sent = await sendFinalToGameFeed(existing);
      if (sent.ok) { existing.webhookSentAt = new Date().toISOString(); await saveState(); }
      return sendJSON(res, 200, { ok: true, duplicate: true, webhookRetried: true, webhookSent: sent.ok });
    }
    return sendJSON(res, 200, { ok: true, duplicate: true, webhookSent: !!existing.webhookSentAt });
  }

  const isFinal = b.status === "final";
  if (isFinal) {
    // Don't invent teams from a typo — an unknown abbreviation must be fixed by an admin.
    for (const abb of [homeABB, awayABB]) {
      if (!state.teams[abb]) return sendJSON(res, 422, { error: `Unknown team abbreviation "${abb}" — it isn't in the standings. Add/fix it in the admin Teams tab, then add this game manually.` });
    }
  }

  const hs = Math.max(0, parseInt(b.homeScore, 10) || 0), as_ = Math.max(0, parseInt(b.awayScore, 10) || 0);
  let status = isFinal ? "final" : "incomplete";
  if (status === "final" && hs === as_) status = "tie";

  const cleanPlayers = side => (Array.isArray(b.players) ? b.players : []).filter(p => p && p.side === side).slice(0, 80).map(p => {
    const stats = {};
    for (const k of FB_KEYS) {
      let v = parseInt(p.stats && p.stats[k], 10);
      if (!Number.isFinite(v)) v = 0;
      stats[k] = YARD_KEYS.has(k) ? Math.max(-9999, Math.min(9999, v)) : Math.max(0, Math.min(9999, v));
    }
    return { name: sanitizeStr(p.name, 40) || "?", userId: Number.isFinite(Number(p.userId)) ? Number(p.userId) : null, stats };
  });

  let winnerABB = null;
  if (status === "tie") recordTie(homeABB, awayABB);
  else if (status === "final") { winnerABB = hs > as_ ? homeABB : awayABB; updateRecord(winnerABB, winnerABB === homeABB ? awayABB : homeABB); }

  const result = {
    id: Date.now(), gameKey, timestamp: new Date().toISOString(),
    season: "Season 1", status, quarter: sanitizeStr(b.quarter, 10) || "F", note: "",
    homeABB, awayABB, homeName: sanitizeStr(b.homeName, 60), awayName: sanitizeStr(b.awayName, 60),
    homeLogo: "", awayLogo: "", homeScore: hs, awayScore: as_, winnerABB,
    endReason: sanitizeStr(b.endReason, 80), playerOfGame: null, referees: "None",
    homeStats: cleanPlayers("home"), awayStats: cleanPlayers("away"),
    manualEntry: false, webhookSentAt: null,
  };
  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();
  state.auditLog.unshift({ action: "auto_" + status, gameId: result.id, matchup: `${awayABB} @ ${homeABB}`, score: `${as_}–${hs}`, status, timestamp: state.lastUpdated });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();                       // save FIRST so a crash can never double-count the game
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  let webhookSent = false;
  if (GAMEFEED_WEBHOOK) {
    const sent = await sendFinalToGameFeed(result);
    if (sent.ok) { result.webhookSentAt = new Date().toISOString(); webhookSent = true; await saveState(); }
    else console.error("[RFL] game-feed webhook failed:", sent.error);
  } else console.warn("[RFL] DISCORD_GAMEFEED_WEBHOOK not set — final stats NOT sent to Discord.");
  console.log(`[RFL] Game reported: ${awayABB} @ ${homeABB} ${as_}-${hs} (${status}) gameId=${gameKey} webhook=${webhookSent}`);
  return sendJSON(res, 200, { ok: true, status, webhookSent });
}

// POST /rpl/game/statlog — the Roblox game reports EVERY manual stat edit / attempt here. Auth: Bearer RPL_SECRET.
async function handleStatLogPost(req, res) {
  if (!SECRET) return sendJSON(res, 503, { error: "RPL_SECRET is not set on the server." });
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let b;
  try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }
  const entries = (Array.isArray(b.entries) ? b.entries : [b]).slice(0, 50);
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    const rec = {
      receivedAt: new Date().toISOString(),
      time: sanitizeStr(e.time, 40) || null,                 // when it happened in the game server (ISO, UTC)
      gameId: sanitizeStr(String(e.gameId ?? ""), 100) || null,
      outcome: ["applied","denied","rejected"].includes(e.outcome) ? e.outcome : "unknown",
      action: sanitizeStr(e.action, 20),                     // edit | play | undo | ...
      actorName: sanitizeStr(e.actorName, 40), actorUserId: num(e.actorUserId),
      playerName: sanitizeStr(e.playerName, 40), playerUserId: num(e.playerUserId), team: sanitizeStr(e.team, 60),
      stat: sanitizeStr(e.stat, 20), from: num(e.from), to: num(e.to),
      detail: sanitizeStr(e.detail, 300),
    };
    state.statLog.unshift(rec); n++;
    console.log("[RFL][STATLOG]", JSON.stringify(rec));
    if (STATLOG_WEBHOOK) {
      const icon = rec.outcome === "applied" ? "✅" : (rec.outcome === "denied" ? "🚫" : "⚠️");
      const change = rec.stat ? `${rec.stat}: ${rec.from ?? "—"} → ${rec.to ?? "—"}` : "—";
      postWebhook(STATLOG_WEBHOOK, { allowed_mentions: { parse: [] }, embeds: [{
        title: `${icon} Stat ${rec.action || "change"} — ${rec.outcome}`,
        description: [`**By:** ${rec.actorName || "?"} (${rec.actorUserId ?? "?"})`, `**Player affected:** ${rec.playerName || "—"} (${rec.playerUserId ?? "—"}) · ${rec.team || "—"}`,
          `**Change:** ${change}`, rec.detail ? `**Detail:** ${rec.detail}` : null, `**Game:** ${rec.gameId || "—"}`].filter(Boolean).join("\n"),
        timestamp: rec.time || rec.receivedAt,
      }] });
    }
  }
  if (state.statLog.length > STAT_LOG_MAX) state.statLog.length = STAT_LOG_MAX;
  await saveState();
  return sendJSON(res, 200, { ok: true, logged: n });
}

function handleGetStatLog(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { statLog: state.statLog });
}

const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") { setCORS(res); res.writeHead(204); return res.end(); }
  if (url === "/" || url === "/health")
    return sendJSON(res, 200, { status: "ok", clients: sseClients.size, teams: Object.keys(state.teams).length });

  if (method === "POST" && isRateLimited(req)) {
    return sendJSON(res, 429, { error: "Too many requests — please slow down." });
  }

  if (url === "/rpl/standings") {
    if (method === "POST") return handleAutoReportDisabled(req, res);
    if (method === "GET")  return handleGetStandings(req, res);
  }
  if (url === "/rpl/standings/events"   && method === "GET")  return handleSSE(req, res);
  if (url === "/rpl/standings/auth"     && method === "POST") return handleAuth(req, res);
  if (url === "/rpl/game/report"        && method === "POST") return handleGameReport(req, res);
  if (url === "/rpl/game/statlog"       && method === "POST") return handleStatLogPost(req, res);
  if (url === "/rpl/standings/statlog"  && method === "GET")  return handleGetStatLog(req, res);
  if (url === "/rpl/standings/void"     && method === "POST") return handleVoidResult(req, res);
  if (url === "/rpl/standings/remove"   && method === "POST") return handleRemoveResult(req, res);
  if (url === "/rpl/standings/void/bulk"   && method === "POST") return handleBulkVoid(req, res);
  if (url === "/rpl/standings/remove/bulk" && method === "POST") return handleBulkRemove(req, res);
  if (url === "/rpl/standings/reset"    && method === "POST") return handleReset(req, res);
  if (url === "/rpl/standings/add"      && method === "POST") return handleAddGame(req, res);
  if (url === "/rpl/standings/auditlog" && method === "GET")  return handleGetAuditLog(req, res);
  if (url === "/rpl/standings/team"     && method === "POST") return handleTeamOverride(req, res);
  if (url === "/rpl/standings/team/add"    && method === "POST") return handleAddTeam(req, res);
  if (url === "/rpl/standings/team/remove" && method === "POST") return handleRemoveTeam(req, res);
  if (url === "/rpl/refs"               && method === "GET")  return handleGetRefs(req, res);
  if (url === "/rpl/archive"            && method === "GET")  return handleGetArchive(req, res);
  if (url === "/rpl/archive"            && method === "POST") return handleSetArchive(req, res);
  if (url === "/rpl/standings/archive-advance" && method === "POST") return handleArchiveAndAdvance(req, res);
  if (url === "/rpl/standings/zero-records"    && method === "POST") return handleZeroRecords(req, res);
  if (url === "/rpl/standings/restore-backup"  && method === "POST") return handleRestoreBackup(req, res);

  sendJSON(res, 404, { error: "Not found" });
});

loadState().then(() => {
  server.listen(PORT, () => {
    console.log(`[RFL] Server running on port ${PORT}`);
    console.log(`[RFL] Upstash: ${UPSTASH_URL ? "connected" : "NOT configured"}`);
  });
});

server.on("error", err => { console.error("[RFL] Server error:", err.message); process.exit(1); });
