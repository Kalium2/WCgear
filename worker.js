/**
 * WoW Gear Check — Cloudflare Worker
 * ============================================================
 * Secure server-side layer between the GitHub Pages frontend and:
 *   - Warcraft Logs API v2 (GraphQL, OAuth 2.0 client credentials)
 *   - Blizzard Game Data API (item enrichment)
 *
 * Required secrets (set with `wrangler secret put NAME`):
 *   WARCRAFTLOGS_CLIENT_ID
 *   WARCRAFTLOGS_CLIENT_SECRET
 *   BLIZZARD_CLIENT_ID
 *   BLIZZARD_CLIENT_SECRET
 *
 * Set your deployed GitHub Pages origin below (or as an
 * ALLOWED_ORIGIN environment variable) to lock down CORS in
 * production — see spec section 38.
 *
 * IMPORTANT — verify before shipping:
 * The exact Warcraft Logs OAuth token endpoint, GraphQL schema
 * fields, and Blizzard OAuth/namespace details below are written
 * to the documented v2 API shape as of this writing, but WoW APIs
 * change. Confirm each endpoint/query against current docs:
 *   https://www.warcraftlogs.com/api/docs
 *   https://develop.battle.net/documentation
 * ============================================================
 */

const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io"; // TODO: set to your Pages origin

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const BLIZZARD_TOKEN_URL_TEMPLATE = "https://oauth.battle.net/token"; // region-agnostic OAuth host
const BLIZZARD_API_HOST = { us: "https://us.api.blizzard.com", eu: "https://eu.api.blizzard.com" };
const BLIZZARD_NAMESPACE = { us: "static-classic-us", eu: "static-classic-eu" };

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
   /api/character?name=&realm=&region=
   ================================================================ */
async function handleCharacter(url, env) {
  const name = url.searchParams.get("name");
  const realm = url.searchParams.get("realm");
  const region = (url.searchParams.get("region") || "US").toLowerCase();

  if (!name || !realm) return jsonError("Missing character name or realm.", 400);

  const token = await getWclToken(env);

  // NOTE: verify exact field names/casing against the current WCL v2 schema.
  const query = `
    query CharacterGear($name: String!, $serverSlug: String!, $serverRegion: String!) {
      characterData {
        character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
          name
          classID
          gameData
        }
      }
    }
  `;

  const gqlRes = await fetch(WCL_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { name, serverSlug: slugifyRealm(realm), serverRegion: region },
    }),
  });

  if (!gqlRes.ok) return jsonError("We couldn't retrieve this character. Please try again.", 502);

  const gqlJson = await gqlRes.json();
  const character = gqlJson?.data?.characterData?.character;

  if (!character) return jsonError("Character not found. Check the character name, realm, and region.", 404);

  // gameData shape depends on what WCL returns for equipped gear — adapt
  // this mapping once you've inspected a real response during Phase 2.
  const gear = mapWclGearToSlots(character.gameData);

  if (!gear || Object.keys(gear).length === 0) {
    return jsonError("No Warcraft Logs gear data is available for this character.", 200);
  }

  return jsonOk({
    name: character.name,
    class: mapClassIdToName(character.classID),
    spec: character.gameData?.spec || null,
    gear,
  });
}

/** Placeholder mapper — WCL's `gameData` payload structure should be
 *  confirmed against a live response and translated into:
 *  { head: [itemId], trinket: [itemId, itemId], weaponConfig, ... } */
function mapWclGearToSlots(gameData) {
  if (!gameData || !Array.isArray(gameData.gear)) return null;

  const SLOT_ID_MAP = {
    0: "head", 1: "neck", 2: "shoulder", 14: "back", 4: "chest",
    8: "wrist", 9: "hands", 5: "waist", 6: "legs", 7: "feet",
    10: "finger", 11: "finger", 12: "trinket", 13: "trinket",
    15: "mainhand", 16: "offhand", 17: "ranged",
  };

  const gear = {};
  for (const piece of gameData.gear) {
    const slot = SLOT_ID_MAP[piece.slot];
    if (!slot) continue;
    if (!gear[slot]) gear[slot] = [];
    gear[slot].push(piece.id);
  }
  return gear;
}

function mapClassIdToName(classId) {
  const CLASS_MAP = { 1: "Warrior", 9: "Warlock", 3: "Hunter" }; // extend as classes are added
  return CLASS_MAP[classId] || "Unknown";
}

function slugifyRealm(realm) {
  return realm.trim().toLowerCase().replace(/[\s']+/g, "-");
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
  const namespace = BLIZZARD_NAMESPACE[region] || BLIZZARD_NAMESPACE.us;

  const results = {};
  await Promise.all(
    itemIds.map(async (id) => {
      try {
        const res = await fetch(
          `${host}/data/wow/item/${id}?namespace=${namespace}&locale=en_US`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) return;
        const item = await res.json();
        results[id] = {
          name: item.name,
          icon: item.preview_item?.icon || null, // adapt to actual media field/media endpoint
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
   For production traffic, consider caching in KV with the token's
   expires_in to avoid repeated auth calls across isolates.
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
  if (!res.ok) throw new Error("Warcraft Logs authentication failed.");

  const data = await res.json();
  wclTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return wclTokenCache.token;
}

async function getBlizzardToken(env) {
  if (blizzardTokenCache && blizzardTokenCache.expiresAt > Date.now()) return blizzardTokenCache.token;

  const res = await fetch(BLIZZARD_TOKEN_URL_TEMPLATE, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("Blizzard authentication failed.");

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
    headers: { "Content-Type": "application/json" },
  });
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function corsResponse(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
