/**
 * WoW Gear Check — Cloudflare Worker
 * ============================================================
 * Secure server-side layer between the GitHub Pages frontend and:
 *   - Warcraft Logs API v2 (character gear, pulled from a specific
 *     report — NOT the broken "cached armory" gameData field, which
 *     doesn't support Classic/Fresh. This uses report.playerDetails,
 *     which is a documented, working field for pulling the gear a
 *     character actually logged with in a given raid.)
 *   - Blizzard Game Data API (item name/icon enrichment only)
 *
 * Required secrets (Cloudflare Worker secrets, never in code):
 *   WARCRAFTLOGS_CLIENT_ID
 *   WARCRAFTLOGS_CLIENT_SECRET
 *   BLIZZARD_CLIENT_ID
 *   BLIZZARD_CLIENT_SECRET
 *
 * IMPORTANT — verify before relying on this long-term:
 * The exact field names inside each combatantInfo.gear entry (item
 * id, slot number, etc.) are written to the best available public
 * documentation and community references, but haven't been confirmed
 * against a live response yet. A temporary diagnostic log is left in
 * place below (search "TEMPORARY DIAGNOSTIC") — check the Worker's
 * live logs after the first real test and remove it once confirmed.
 * ============================================================
 */

const ALLOWED_ORIGIN = "https://kalium2.github.io"; // GitHub Pages origin (path-free, per CORS rules)

const WCL_TOKEN_URL = "https://fresh.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://fresh.warcraftlogs.com/api/v2/client";

const BLIZZARD_TOKEN_URL = "https://oauth.battle.net/token";
const BLIZZARD_API_HOST = { us: "https://us.api.blizzard.com", eu: "https://eu.api.blizzard.com" };
const BLIZZARD_STATIC_NAMESPACE = { us: "static-classic-us", eu: "static-classic-eu" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }), origin);
    }

    try {
      if (url.pathname === "/api/character" && request.method === "GET") {
        return corsResponse(await handleCharacter(url, env), origin);
      }
      if (url.pathname === "/api/items" && request.method === "POST") {
        return corsResponse(await handleItems(request, env), origin);
      }
      return corsResponse(jsonError("Not found", 404), origin);
    } catch (err) {
      console.error(err);
      return corsResponse(jsonError("We couldn't retrieve this character. Please try again.", 502), origin);
    }
  },
};

/* ================================================================
   /api/character?name=&reportCode=&fightId=
   ================================================================
   Pulls the character's gear as logged in a specific Warcraft Logs
   report — optionally a specific fight, otherwise the most recent
   fight in the report.
   ================================================================ */
async function handleCharacter(url, env) {
  const name = url.searchParams.get("name");
  const reportCode = url.searchParams.get("reportCode");
  let fightId = url.searchParams.get("fightId");

  if (!name || !reportCode) return jsonError("Missing character name or report code.", 400);

  const token = await getWclToken(env);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // If no specific fight was given, default to the most recent fight in the report.
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
    if (!fightsRes.ok) return jsonError("We couldn't retrieve this character. Please try again.", 502);
    const fightsJson = await fightsRes.json();
    const fights = fightsJson?.data?.reportData?.report?.fights;
    if (!fights || fights.length === 0) {
      return jsonError("That report doesn't have any fights to read gear from.", 404);
    }
    fightId = fights[fights.length - 1].id;
  }

  const detailsQuery = `
    query PlayerDetails($code: String!, $fightIDs: [Int]) {
      reportData {
        report(code: $code) {
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
  if (!detailsRes.ok) return jsonError("We couldn't retrieve this character. Please try again.", 502);

  const detailsJson = await detailsRes.json();
  const playerDetails = detailsJson?.data?.reportData?.report?.playerDetails?.data?.playerDetails
    ?? detailsJson?.data?.reportData?.report?.playerDetails; // handle either wrapped or unwrapped shape

  if (!playerDetails) return jsonError("That report doesn't have readable player data.", 404);

  const allPlayers = [
    ...(playerDetails.dps || []),
    ...(playerDetails.healers || []),
    ...(playerDetails.tanks || []),
  ];
  const player = allPlayers.find((p) => (p.name || "").toLowerCase() === name.trim().toLowerCase());

  if (!player) return jsonError("Character not found in that report. Check the character name and report URL.", 404);

  // TEMPORARY DIAGNOSTIC — remove once the gear mapping is confirmed working.
  console.log("RAW PLAYER PAYLOAD:", JSON.stringify(player));

  const gear = mapCombatantGearToSlots(player.combatantInfo?.gear);

  if (!gear || Object.keys(gear).length === 0) {
    return jsonError("No gear data is available for this character in that report.", 200);
  }

  return jsonOk({
    name: player.name,
    class: player.type || "Unknown",
    spec: player.specs?.[0]?.spec || null,
    gear,
  });
}

/** Standard WoW inventory slot numbers -> our internal slot keys. */
const WOW_SLOT_MAP = {
  1: "head", 2: "neck", 3: "shoulder", 5: "chest", 6: "waist", 7: "legs",
  8: "feet", 9: "wrist", 10: "hands", 11: "finger", 12: "finger",
  13: "trinket", 14: "trinket", 15: "back", 16: "mainhand", 17: "offhand", 18: "ranged",
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
  const namespace = BLIZZARD_STATIC_NAMESPACE[region] || BLIZZARD_STATIC_NAMESPACE.us;
  const headers = { Authorization: `Bearer ${token}` };

  const results = {};
  await Promise.all(
    itemIds.map(async (id) => {
      try {
        const [itemRes, mediaRes] = await Promise.all([
          fetch(`${host}/data/wow/item/${id}?namespace=${namespace}&locale=en_US`, { headers }),
          fetch(`${host}/data/wow/media/item/${id}?namespace=${namespace}&locale=en_US`, { headers }),
        ]);
        if (!itemRes.ok) return;
        const item = await itemRes.json();

        let icon = null;
        if (mediaRes.ok) {
          const media = await mediaRes.json();
          icon = media.assets?.find((a) => a.key === "icon")?.value || null;
        }

        results[id] = {
          name: item.name,
          icon,
          quality: item.quality?.type || null,
          itemLevel: item.level || null,
        };
      } catch {
        // Missing item metadata is surfaced as "Unable to Check" upstream,
        // not as a hard failure — skip silently here.
      }
    })
  );

  return jsonOk({ items: results });
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
