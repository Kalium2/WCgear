/**
 * WoW Gear Check — Cloudflare Worker
 * ============================================================
 * Secure server-side layer between the GitHub Pages frontend and:
 *   - Warcraft Logs API v2 (report roster + character gear, pulled
 *     from a specific report via report.playerDetails — NOT the
 *     broken "cached armory" gameData field, which doesn't support
 *     Classic/Fresh.)
 *   - Blizzard Game Data API (item name/icon enrichment only)
 *
 * Required secrets (Cloudflare Worker secrets, never in code):
 *   WARCRAFTLOGS_CLIENT_ID
 *   WARCRAFTLOGS_CLIENT_SECRET
 *   BLIZZARD_CLIENT_ID
 *   BLIZZARD_CLIENT_SECRET
 *
 * IMPORTANT — verified against a live report response (see the
 * WOW_SLOT_MAP comment below for the slot-numbering fix that came
 * out of that verification).
 * ============================================================
 */

const ALLOWED_ORIGIN = "https://kalium2.github.io"; // GitHub Pages origin (path-free, per CORS rules)

const WCL_TOKEN_URL = "https://fresh.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://fresh.warcraftlogs.com/api/v2/client";

const BLIZZARD_TOKEN_URL = "https://oauth.battle.net/token";
const BLIZZARD_API_HOST = { us: "https://us.api.blizzard.com", eu: "https://eu.api.blizzard.com" };
const BLIZZARD_STATIC_NAMESPACE = { us: "static-classic-us", eu: "static-classic-eu" };
const BLIZZARD_RETAIL_NAMESPACE = { us: "static-us", eu: "static-eu" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }), origin);
    }

    try {
      if (url.pathname === "/api/roster" && request.method === "GET") {
        return corsResponse(await handleRoster(url, env), origin);
      }
      if (url.pathname === "/api/character" && request.method === "GET") {
        return corsResponse(await handleCharacter(url, env), origin);
      }
      if (url.pathname === "/api/items" && request.method === "POST") {
        return corsResponse(await handleItems(request, env), origin);
      }
      return corsResponse(jsonError("Not found", 404), origin);
    } catch (err) {
      console.error(err);
      const status = err.status || 502;
      const message = err.status ? err.message : "We couldn't retrieve that report. Please try again.";
      return corsResponse(jsonError(message, status), origin);
    }
  },
};

/* ================================================================
   /api/roster?reportCode=&fightId=
   ================================================================
   Returns every character logged in a report/fight, so the frontend
   can offer a picker instead of requiring an exact typed name.
   ================================================================ */
async function handleRoster(url, env) {
  const reportCode = url.searchParams.get("reportCode");
  const fightIdParam = url.searchParams.get("fightId");

  if (!reportCode) return jsonError("Missing report code.", 400);

  const { fightId, allPlayers } = await resolveFightAndPlayers(reportCode, fightIdParam, env);

  if (!allPlayers.length) {
    return jsonError("No player data found in that report.", 404);
  }

  const roster = allPlayers
    .map((p) => ({ name: p.name, class: p.type || "Unknown", spec: p.specs?.[0]?.spec || null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return jsonOk({ fightId, roster });
}

/* ================================================================
   /api/character?name=&reportCode=&fightId=
   ================================================================
   Pulls one character's gear as logged in a specific report/fight.
   ================================================================ */
async function handleCharacter(url, env) {
  const name = url.searchParams.get("name");
  const reportCode = url.searchParams.get("reportCode");
  const fightIdParam = url.searchParams.get("fightId");

  if (!name || !reportCode) return jsonError("Missing character name or report code.", 400);

  const { allPlayers, zone, startTime } = await resolveFightAndPlayers(reportCode, fightIdParam, env);
  const player = allPlayers.find((p) => (p.name || "").toLowerCase() === name.trim().toLowerCase());

  if (!player) return jsonError("Character not found in that report. Check the character name and report URL.", 404);

  const gear = mapCombatantGearToSlots(player.combatantInfo?.gear);

  if (!gear || Object.keys(gear).length === 0) {
    return jsonError("No gear data is available for this character in that report.", 200);
  }

  const { bestPerfAvg, medPerfAvg } = await fetchPerformanceMetrics(player.name, zone, reportCode, env);

  return jsonOk({
    name: player.name,
    class: player.type || "Unknown",
    spec: player.specs?.[0]?.spec || null,
    gear,
    bestPerfAvg,
    medPerfAvg,
    zoneName: zone?.name ?? null,
    autoPhase: detectPhaseFromZone(zone?.name),
    raidDate: startTime ? formatRaidDate(startTime) : null,
  });
}

/** Maps a Warcraft Logs raid zone name to the app's internal phase
 *  key, so a fetched character can auto-select the matching BiS list
 *  (requirement 4). Warcraft Logs has no literal "TBC Phase" field —
 *  this is our own mapping of which zone belongs to which phase.
 *  Returns null (no auto-selection, user picks manually) for zones
 *  outside Phase 3/4, or if the zone name is unrecognized. */
const ZONE_PHASE_MAP = [
  { match: /black temple/i, phase: "phase3" },
  { match: /mount hyjal|hyjal summit/i, phase: "phase3" },
  { match: /zul'?aman/i, phase: "phase4" },
];
function detectPhaseFromZone(zoneName) {
  if (!zoneName) return null;
  return ZONE_PHASE_MAP.find((z) => z.match.test(zoneName))?.phase ?? null;
}

/** Warcraft Logs report startTime is epoch milliseconds. Formats as
 *  e.g. "Aug 15, 2026" for display on the character card. */
function formatRaidDate(startTimeMs) {
  try {
    return new Date(startTimeMs).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

/** Shared by /api/roster and /api/character: resolves which fight to
 *  read (defaulting to the most recent one in the report if not
 *  specified) and returns every player logged in it, with gear info. */
/** Turns a failed Warcraft Logs response status into an accurate,
 *  user-facing error — specifically calling out rate limiting (429)
 *  rather than the generic "please try again", since retrying
 *  immediately against an active rate limit won't help and looks
 *  like a fresh bug otherwise. */
function wclError(status) {
  const err = status === 429
    ? new Error("Warcraft Logs is rate-limiting requests right now. Please wait a few minutes and try again.")
    : new Error("Warcraft Logs request failed. Please try again.");
  err.status = status === 429 ? 429 : 502;
  return err;
}

async function resolveFightAndPlayers(reportCode, fightIdParam, env) {
  const token = await getWclToken(env);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let fightId = fightIdParam;

  if (!fightId) {
    const fightsQuery = `
      query ReportFights($code: String!) {
        reportData { report(code: $code) { fights { id } } }
      }
    `;
    const fightsRes = await fetch(WCL_GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: fightsQuery, variables: { code: reportCode } }),
    });
    if (!fightsRes.ok) {
      const bodyText = await fightsRes.text();
      console.error(`WCL fights request failed: status ${fightsRes.status}, body: ${bodyText}`);
      throw wclError(fightsRes.status);
    }
    const fightsJson = await fightsRes.json();
    const fights = fightsJson?.data?.reportData?.report?.fights;
    if (!fights || fights.length === 0) {
      // TEMPORARY DIAGNOSTIC — remove once confirmed working.
      console.error("Empty/missing fights list. Raw response:", JSON.stringify(fightsJson));
      const err = new Error("That report doesn't have any fights to read gear from.");
      err.status = 404;
      throw err;
    }
    fightId = fights[fights.length - 1].id;
  }

  const detailsQuery = `
    query PlayerDetails($code: String!, $fightIDs: [Int]) {
      rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }
      reportData {
        report(code: $code) {
          zone { id name }
          startTime
          playerDetails(fightIDs: $fightIDs, includeCombatantInfo: true)
        }
      }
    }
  `;
  const detailsRes = await fetch(WCL_GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: detailsQuery, variables: { code: reportCode, fightIDs: [Number(fightId)] } }),
  });
  if (!detailsRes.ok) {
    const bodyText = await detailsRes.text();
    console.error(`WCL playerDetails request failed: status ${detailsRes.status}, body: ${bodyText}`);
    throw wclError(detailsRes.status);
  }

  const detailsJson = await detailsRes.json();
  if (detailsJson.errors) {
    console.error(`WCL playerDetails GraphQL errors: ${JSON.stringify(detailsJson.errors)}`);
  }

  const rl = detailsJson?.data?.rateLimitData;
  if (rl) {
    console.log(`WCL rate limit: ${rl.pointsSpentThisHour}/${rl.limitPerHour} points used, resets in ${rl.pointsResetIn}s`);
  }

  const playerDetails = detailsJson?.data?.reportData?.report?.playerDetails?.data?.playerDetails
    ?? detailsJson?.data?.reportData?.report?.playerDetails; // handle either wrapped or unwrapped shape

  const allPlayers = playerDetails
    ? [...(playerDetails.dps || []), ...(playerDetails.healers || []), ...(playerDetails.tanks || [])]
    : [];

  const zone = detailsJson?.data?.reportData?.report?.zone ?? null;
  const startTime = detailsJson?.data?.reportData?.report?.startTime ?? null;

  return { fightId, allPlayers, zone, startTime };
}

/** Best-effort Warcraft Logs performance metrics (Best/Median
 *  Performance Average) for the matched player, scoped to the raid
 *  zone this report belongs to.
 *
 *  Deliberately a fully separate GraphQL request from the core
 *  gear/roster query — an earlier version embedded this in the same
 *  query, and a schema mistake here (masterData.actors.server is a
 *  plain string, not an object) took down gear fetching along with
 *  it. Never again: this lives entirely on its own, wrapped in
 *  try/catch, so any failure here only means the metrics show
 *  "Unavailable" (requirement 3.3) — gear is never affected.
 *
 *  Region isn't available from the report data, so it's hardcoded to
 *  "us" — reasonable for this app's scope (Dreamscythe/Nightslayer
 *  are both US realms). The realm slug is derived from the actor's
 *  plain server name string. Still unverified end-to-end; check the
 *  diagnostic log below after a real test. */
async function fetchPerformanceMetrics(playerName, zone, reportCode, env) {
  try {
    if (!zone?.id) return { bestPerfAvg: null, medPerfAvg: null };

    const token = await getWclToken(env);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const actorsQuery = `
      query ReportActors($code: String!) {
        reportData { report(code: $code) { masterData { actors(type: "Player") { name server } } } }
      }
    `;
    const actorsRes = await fetch(WCL_GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: actorsQuery, variables: { code: reportCode } }),
    });
    const actorsJson = await actorsRes.json();
    if (actorsJson.errors) {
      console.error("Perf metrics: actors query errors:", JSON.stringify(actorsJson.errors));
      return { bestPerfAvg: null, medPerfAvg: null };
    }

    const actors = actorsJson?.data?.reportData?.report?.masterData?.actors ?? [];
    const actor = actors.find((a) => (a.name || "").toLowerCase() === playerName.toLowerCase());
    if (!actor?.server) {
      console.error(`Perf metrics: no server found for ${playerName} in report actors.`);
      return { bestPerfAvg: null, medPerfAvg: null };
    }
    const serverSlug = actor.server.toLowerCase().replace(/[\s']+/g, "-");

    const perfQuery = `
      query PerfMetrics($name: String!, $serverSlug: String!, $zoneID: Int!) {
        characterData {
          character(name: $name, serverSlug: $serverSlug, serverRegion: "US") {
            zoneRankings(zoneID: $zoneID)
          }
        }
      }
    `;
    const perfRes = await fetch(WCL_GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: perfQuery, variables: { name: playerName, serverSlug, zoneID: zone.id } }),
    });
    const perfJson = await perfRes.json();

    // TEMPORARY DIAGNOSTIC — unverified end-to-end; check this log after
    // a real test, then remove once the field names are confirmed.
    console.log("PERF METRICS RAW RESPONSE:", JSON.stringify(perfJson));

    if (perfJson.errors) {
      console.error("Perf metrics: zoneRankings query errors:", JSON.stringify(perfJson.errors));
      return { bestPerfAvg: null, medPerfAvg: null };
    }

    const zr = perfJson?.data?.characterData?.character?.zoneRankings;
    return {
      bestPerfAvg: zr?.bestPerformanceAverage ?? null,
      medPerfAvg: zr?.medianPerformanceAverage ?? null,
    };
  } catch (err) {
    console.error("Perf metrics fetch failed (non-fatal):", err.message);
    return { bestPerfAvg: null, medPerfAvg: null };
  }
}

/** WoW inventory slot numbers -> our internal slot keys. Warcraft
 *  Logs' combatantInfo.gear array numbers slots starting at 0
 *  (Head=0, Neck=1, Shoulder=2, Shirt=3, ...) — NOT Blizzard's older
 *  1-indexed client enum. Confirmed against a live report where every
 *  item was landing exactly one slot label off before this fix. */
const WOW_SLOT_MAP = {
  0: "head", 1: "neck", 2: "shoulder", 4: "chest", 5: "waist", 6: "legs",
  7: "feet", 8: "wrist", 9: "hands", 10: "finger", 11: "finger",
  12: "trinket", 13: "trinket", 14: "back", 15: "mainhand", 16: "offhand", 17: "ranged",
  // 3 = Shirt, 18 = Tabard — intentionally not mapped, not relevant to BiS comparison.
};

/** Maps a combatantInfo.gear array into { slot: [itemId, ...], weaponConfig }. */
function mapCombatantGearToSlots(gearArray) {
  const gear = {};
  const items = Array.isArray(gearArray) ? gearArray : [];

  for (const piece of items) {
    const key = WOW_SLOT_MAP[piece.slot];
    if (!key) continue;
    const itemId = piece.id ?? piece.itemID ?? piece.itemId;
    if (itemId == null) continue;
    if (!gear[key]) gear[key] = [];
    gear[key].push(itemId);
  }

  if (gear.mainhand && gear.offhand) {
    gear.weaponConfig = "mainhand_offhand";
  } else if (gear.mainhand) {
    gear.weaponConfig = "twohand";
    gear.twohand = gear.mainhand;
    delete gear.mainhand;
  }

  return gear;
}

/* ================================================================
   /api/items  { itemIds: number[], region: "us"|"eu" }
   ================================================================
   Enriches raw item IDs with Blizzard's name/icon/quality data.
   ================================================================ */
async function handleItems(request, env) {
  const body = await request.json();
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  const region = (body.region || "us").toLowerCase();

  if (itemIds.length === 0) return jsonOk({ items: {} });

  const token = await getBlizzardToken(env);
  const host = BLIZZARD_API_HOST[region] || BLIZZARD_API_HOST.us;
  const headers = { Authorization: `Bearer ${token}` };

  // Try the Classic namespace first; some items have gaps there, so
  // fall back to retail's much more complete item database — Blizzard's
  // item IDs are shared across game versions, so old TBC items usually
  // still resolve fine against the current retail data.
  const namespaces = [
    BLIZZARD_STATIC_NAMESPACE[region] || BLIZZARD_STATIC_NAMESPACE.us,
    BLIZZARD_RETAIL_NAMESPACE[region] || BLIZZARD_RETAIL_NAMESPACE.us,
  ];

  // Cloudflare caps total subrequests per Worker invocation. Track a
  // budget so a large batch degrades gracefully (names without icons,
  // rather than whole items silently vanishing from the results).
  const budget = { remaining: 40 };

  const results = {};
  await Promise.all(
    itemIds.map(async (id) => {
      const item = await fetchItemAcrossNamespaces(host, namespaces, headers, id, budget);
      if (item) results[id] = item;
    })
  );

  return jsonOk({ items: results });
}

/** Tries each namespace in order (Classic, then retail as fallback)
 *  and returns the first successful result. No retries — Cloudflare
 *  Workers cap total subrequests per invocation, so the budget is
 *  spent on covering more items rather than re-attempting failures. */
async function fetchItemAcrossNamespaces(host, namespaces, headers, id, budget) {
  for (const namespace of namespaces) {
    const item = await fetchItemFromNamespace(host, namespace, headers, id, budget);
    if (item) return item;
  }
  return null;
}

/** Fetches a single item's name (and its icon, budget permitting) from
 *  one namespace. The name request is always prioritized over the icon
 *  request, so if we're running low on subrequest budget we still show
 *  a real item name instead of a bare ID. */
async function fetchItemFromNamespace(host, namespace, headers, id, budget) {
  if (budget.remaining <= 0) return null;

  try {
    budget.remaining--;
    const itemRes = await fetch(`${host}/data/wow/item/${id}?namespace=${namespace}&locale=en_US`, { headers });

    if (!itemRes.ok) {
      console.error(`Item ${id} [${namespace}] fetch failed: status ${itemRes.status}`);
      return null;
    }
    const item = await itemRes.json();

    let icon = null;
    if (budget.remaining > 0) {
      budget.remaining--;
      try {
        const mediaRes = await fetch(`${host}/data/wow/media/item/${id}?namespace=${namespace}&locale=en_US`, { headers });
        if (mediaRes.ok) {
          const media = await mediaRes.json();
          icon = media.assets?.find((a) => a.key === "icon")?.value || null;
        }
      } catch {
        // Icon is optional — a missing icon still leaves a usable named item.
      }
    }

    return {
      name: item.name,
      icon,
      quality: item.quality?.type || null,
      itemLevel: item.level || null,
    };
  } catch (err) {
    console.error(`Item ${id} [${namespace}] fetch threw:`, err.message);
    return null;
  }
}

/* ================================================================
   OAUTH — client credentials flow, both APIs
   ================================================================
   Tokens are cached in memory for the life of the Worker isolate.
   ================================================================ */
let wclTokenCache = null; // { token, expiresAt }
let blizzardTokenCache = null;

async function getWclToken(env) {
  if (wclTokenCache && wclTokenCache.expiresAt > Date.now()) return wclTokenCache.token;

  const res = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.WARCRAFTLOGS_CLIENT_ID}:${env.WARCRAFTLOGS_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`Warcraft Logs token request failed: status ${res.status}, body: ${bodyText}`);
    throw new Error(`Warcraft Logs authentication failed (status ${res.status}).`);
  }

  const data = await res.json();
  wclTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return wclTokenCache.token;
}

async function getBlizzardToken(env) {
  if (blizzardTokenCache && blizzardTokenCache.expiresAt > Date.now()) return blizzardTokenCache.token;

  const res = await fetch(BLIZZARD_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`Blizzard token request failed: status ${res.status}, body: ${bodyText}`);
    throw new Error(`Blizzard authentication failed (status ${res.status}).`);
  }

  const data = await res.json();
  blizzardTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return blizzardTokenCache.token;
}

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */
function jsonOk(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function corsResponse(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
