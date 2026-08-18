/**
 * WoW Gear Check — Cloudflare Worker
 * ============================================================
 * Secure server-side layer between the GitHub Pages frontend and
 * the Blizzard Game Data / Profile API. Handles:
 *   - Character equipment lookup (which slots into which items)
 *   - Item enrichment (name, icon, quality)
 *
 * Warcraft Logs is no longer used — its gear/armory data doesn't
 * reliably cover Classic/Fresh realms. Blizzard's own Armory API
 * (the same source tools like wowaudit use) is the gear source now.
 *
 * Required secrets (set as Cloudflare Worker secrets, never in code):
 *   BLIZZARD_CLIENT_ID
 *   BLIZZARD_CLIENT_SECRET
 *
 * IMPORTANT — verify before relying on this long-term:
 * The Classic namespace below (profile-classic-{region}) is a
 * strong best guess based on Blizzard's namespace conventions
 * (it mirrors static-classic-{region}, which is already confirmed
 * working for item data). If character/equipment lookups 404,
 * the first thing to try is swapping it for profile-classic1x-{region}
 * — Blizzard splits "Classic Era"-style realms and "Classic
 * progression" (through TBC/Wrath/etc.) realms into different
 * namespaces, and which one Dreamscythe/Nightslayer use hasn't
 * been confirmed against a live response yet.
 * ============================================================
 */

const ALLOWED_ORIGIN = "https://kalium2.github.io"; // GitHub Pages origin (path-free, per CORS rules)

const BLIZZARD_TOKEN_URL = "https://oauth.battle.net/token";
const BLIZZARD_API_HOST = { us: "https://us.api.blizzard.com", eu: "https://eu.api.blizzard.com" };
const BLIZZARD_STATIC_NAMESPACE = { us: "static-classic-us", eu: "static-classic-eu" };
const BLIZZARD_PROFILE_NAMESPACE = { us: "profile-classic-us", eu: "profile-classic-eu" };

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
   ================================================================
   Pulls the character's equipped gear straight from Blizzard's
   Armory (Profile API) — the same source tools like wowaudit use.
   ================================================================ */
async function handleCharacter(url, env) {
  const name = url.searchParams.get("name");
  const realm = url.searchParams.get("realm");
  const region = (url.searchParams.get("region") || "US").toLowerCase();

  if (!name || !realm) return jsonError("Missing character name or realm.", 400);

  const token = await getBlizzardToken(env);
  const host = BLIZZARD_API_HOST[region] || BLIZZARD_API_HOST.us;
  const namespace = BLIZZARD_PROFILE_NAMESPACE[region] || BLIZZARD_PROFILE_NAMESPACE.us;
  const realmSlug = slugifyRealm(realm);
  const characterSlug = name.trim().toLowerCase(); // Blizzard requires lowercase in the URL path

  const headers = { Authorization: `Bearer ${token}` };

  const [summaryRes, equipmentRes] = await Promise.all([
    fetch(`${host}/profile/wow/character/${realmSlug}/${characterSlug}?namespace=${namespace}&locale=en_US`, { headers }),
    fetch(`${host}/profile/wow/character/${realmSlug}/${characterSlug}/equipment?namespace=${namespace}&locale=en_US`, { headers }),
  ]);

  if (summaryRes.status === 404 || equipmentRes.status === 404) {
    return jsonError("Character not found. Check the character name, realm, and region.", 404);
  }
  if (!summaryRes.ok || !equipmentRes.ok) {
    return jsonError("We couldn't retrieve this character. Please try again.", 502);
  }

  const summary = await summaryRes.json();
  const equipmentData = await equipmentRes.json();

  // TEMPORARY DIAGNOSTIC — remove once the equipment mapping is confirmed working.
  console.log("RAW EQUIPMENT PAYLOAD:", JSON.stringify(equipmentData));

  const gear = mapBlizzardEquipmentToGear(equipmentData);

  if (!gear || Object.keys(gear).length === 0) {
    return jsonError("No gear data is available for this character.", 200);
  }

  return jsonOk({
    name: summary.name,
    class: summary.character_class?.name ?? "Unknown",
    spec: null, // Classic's talent trees aren't exposed as a "specialization" the way retail is
    gear,
  });
}

/** Blizzard equipment slot type -> our internal slot key. */
const SLOT_TYPE_MAP = {
  HEAD: "head", NECK: "neck", SHOULDER: "shoulder", BACK: "back", CHEST: "chest",
  WRIST: "wrist", HANDS: "hands", WAIST: "waist", LEGS: "legs", FEET: "feet",
  FINGER_1: "finger", FINGER_2: "finger", TRINKET_1: "trinket", TRINKET_2: "trinket",
  MAIN_HAND: "mainhand", OFF_HAND: "offhand", RANGED: "ranged", RANGEDRIGHT: "ranged",
};

/** Maps Blizzard's equipped_items array into { slot: [itemId, ...], weaponConfig }. */
function mapBlizzardEquipmentToGear(equipmentData) {
  const gear = {};
  const items = Array.isArray(equipmentData?.equipped_items) ? equipmentData.equipped_items : [];

  for (const piece of items) {
    const key = SLOT_TYPE_MAP[piece.slot?.type];
    if (!key) continue;
    if (!gear[key]) gear[key] = [];
    gear[key].push(piece.item?.id);
  }

  // Infer weapon configuration from what's actually equipped.
  if (gear.mainhand && gear.offhand) {
    gear.weaponConfig = "mainhand_offhand";
  } else if (gear.mainhand) {
    gear.weaponConfig = "twohand";
    gear.twohand = gear.mainhand;
    delete gear.mainhand;
  }

  return gear;
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
   OAUTH — Blizzard client credentials flow
   ================================================================
   Token is cached in memory for the life of the Worker isolate.
   ================================================================ */
let blizzardTokenCache = null; // { token, expiresAt }

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
    // TEMPORARY DIAGNOSTIC — remove once auth is confirmed working.
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
