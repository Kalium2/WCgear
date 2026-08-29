/**
 * probe-armory.js — does the Blizzard Profile API actually serve Anniversary
 * TBC character gear and talents?
 *
 * Run this BEFORE any armory code is written. Everything downstream depends on
 * JSON shapes none of us has seen, and this project's entire bug history is
 * "assumed the shape of someone else's data": handType was an integer not a
 * string, WCL spelled it "BeastMastery" not "Beast Mastery", "Melee weave" was
 * present and true when we assumed it was absent. Four bugs, one root cause,
 * every one silent. So: look at the bytes.
 *
 * WHAT IS KNOWN (verified 2026-08-29, not assumed):
 *   - Blizzard added an Armory covering Burning Crusade Classic on 2026-08-27,
 *     at worldofwarcraft.blizzard.com/en-us/classic/us/armory.
 *   - Anniversary realms moved off the classic1x namespace to `classicann`
 *     around Feb 2026 (community-identified; Blizzard never posted about it).
 *   - As of Feb 2026 character profile endpoints under that namespace returned
 *     404 while guild endpoints worked. The web Armory launching is a strong
 *     hint the pipeline is now populated. A hint is not a fact.
 *
 * WHY A MATRIX AND NOT ONE CALL:
 *   A 404 has at least four different meanings here and they are
 *   indistinguishable from a single request:
 *     1. wrong realm slug          -> our typo
 *     2. wrong namespace           -> our guess
 *     3. character never logged out since the pipeline started -> their data
 *     4. Classic profiles genuinely not served -> the feature doesn't exist
 *   So step 1 confirms the realm actually exists under each namespace before
 *   any character call is believed. If the realm resolves and the character
 *   still 404s, that is a real answer instead of a shrug.
 *
 * USAGE (on the VPS):
 *   node probe-armory.js Kalium dreamscythe
 *   node probe-armory.js Kalium dreamscythe eu
 *
 * CREDENTIALS: needs a Blizzard API client id/secret. You already have a pair —
 * they are the ones the Cloudflare Worker uses for item enrichment. Either
 * export them:
 *     export BLIZZARD_CLIENT_ID=...
 *     export BLIZZARD_CLIENT_SECRET=...
 * or add them to /root/wow-gear-check-server/.env as BLIZZARD_CLIENT_ID= and
 * BLIZZARD_CLIENT_SECRET= (this script reads that file if the env vars are
 * missing). If you can't find them, make a new pair at
 * https://develop.battle.net/access/clients — client-credentials only, no
 * redirect URI needed.
 *
 * Writes every 200 response to ./armory-probe/<namespace>__<endpoint>.json so
 * we can read the real shapes instead of guessing at them.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const NAME = (process.argv[2] || "").trim();
const REALM = (process.argv[3] || "").trim();
const REGION = (process.argv[4] || "us").trim().toLowerCase();

if (!NAME || !REALM) {
  console.error("Usage: node probe-armory.js <characterName> <realmSlug> [region]");
  console.error("Example: node probe-armory.js Kalium dreamscythe us");
  process.exit(1);
}

const OUT_DIR = path.join(process.cwd(), "armory-probe");

// Namespace families to try, most-likely first. `classicann` is the Anniversary
// progression line (currently TBC); `classic` is the other progression line
// (MoP Classic); `classic1x` is Classic Era. We try all of them because the
// only thing worse than not knowing is being confidently wrong about which.
const NAMESPACES = ["classicann", "classic", "classic1x"];

// Blizzard lowercases and slugifies realm names. "Dreamscythe" -> "dreamscythe",
// "Old Blanchy" -> "old-blanchy". Character names go lowercase in the path.
const charSlug = NAME.toLowerCase();
const realmSlug = REALM.toLowerCase().replace(/\s+/g, "-").replace(/'/g, "");

const HOST = `https://${REGION}.api.blizzard.com`;

function loadEnvFile() {
  const candidates = [
    "/root/wow-gear-check-server/.env",
    path.join(process.cwd(), ".env"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  }
}

async function getToken() {
  loadEnvFile();
  const id = process.env.BLIZZARD_CLIENT_ID || process.env.BNET_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET || process.env.BNET_CLIENT_SECRET;
  if (!id || !secret) {
    console.error("\nNo Blizzard credentials found.");
    console.error("Looked for BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET in the");
    console.error("environment and in /root/wow-gear-check-server/.env");
    console.error("(also accepts BNET_CLIENT_ID / BNET_CLIENT_SECRET).");
    console.error("\nSee the header comment for where to get them.");
    process.exit(1);
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    console.error(`Token request failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }
  const json = await res.json();
  console.log(`Token OK (expires in ${json.expires_in}s)\n`);
  return json.access_token;
}

async function get(token, url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON; keep the text */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: String(err && err.message) };
  }
}

function save(label, json) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, label.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

// A one-line description of what came back, so the console output is readable
// without opening the files. Deliberately reports TYPES for the fields we will
// depend on later, not just whether they exist.
function describe(kind, json) {
  if (!json) return "(no JSON body)";
  try {
    if (kind === "summary") {
      return [
        `level=${json.level}`,
        `class=${json.character_class && json.character_class.name}`,
        `spec=${json.active_spec ? json.active_spec.name : "(none)"}`,
        `faction=${json.faction && json.faction.name}`,
        `race=${json.race && json.race.name}`,
        `lastLogin=${json.last_login_timestamp ? new Date(json.last_login_timestamp).toISOString() : "(absent)"}`,
      ].join("  ");
    }
    if (kind === "equipment") {
      const items = json.equipped_items || [];
      const withGems = items.filter((i) => (i.sockets || []).length).length;
      const withEnch = items.filter((i) => (i.enchantments || []).length).length;
      const sample = items[0];
      return [
        `${items.length} items`,
        `${withGems} socketed`,
        `${withEnch} enchanted`,
        sample ? `first: slot=${sample.slot && sample.slot.type} id=${sample.item && sample.item.id} (${typeof (sample.item && sample.item.id)})` : "",
      ].join("  ");
    }
    if (kind === "specializations") {
      // Shape is the whole question. Report the top-level keys and dig one
      // level so we can see whether TBC talents come back as trees, as a flat
      // spell list, or as something else entirely.
      const keys = Object.keys(json);
      let detail = "";
      const arr = json.specializations || json.specialization_groups || null;
      if (Array.isArray(arr) && arr.length) {
        detail = `  first entry keys: [${Object.keys(arr[0]).join(", ")}]`;
      }
      return `keys: [${keys.join(", ")}]${detail}`;
    }
  } catch (err) {
    return `(could not summarise: ${err.message})`;
  }
  return "";
}

(async () => {
  console.log(`Probing ${NAME} @ ${realmSlug} (${REGION})`);
  console.log(`Host: ${HOST}\n`);

  const token = await getToken();
  const findings = [];

  for (const ns of NAMESPACES) {
    console.log(`=== namespace family: ${ns}-${REGION} ===`);

    // STEP 1 — does the realm exist under this namespace? Without this, every
    // 404 below is ambiguous between "our slug is wrong" and "no data".
    const realmRes = await get(
      token,
      `${HOST}/data/wow/realm/${realmSlug}?namespace=dynamic-${ns}-${REGION}&locale=en_US`
    );
    const realmOk = realmRes.status === 200;
    console.log(
      `  realm lookup           ${realmRes.status}  ${
        realmOk ? `-> "${realmRes.json && realmRes.json.name}" id=${realmRes.json && realmRes.json.id}` : "realm not found under this namespace"
      }`
    );
    if (realmOk) save(`${ns}__realm`, realmRes.json);

    const base = `${HOST}/profile/wow/character/${realmSlug}/${encodeURIComponent(charSlug)}`;
    const nsq = `namespace=profile-${ns}-${REGION}&locale=en_US`;

    const endpoints = [
      ["summary", `${base}?${nsq}`],
      ["equipment", `${base}/equipment?${nsq}`],
      ["specializations", `${base}/specializations?${nsq}`],
      ["statistics", `${base}/statistics?${nsq}`],
    ];

    for (const [kind, url] of endpoints) {
      const res = await get(token, url);
      const pad = kind.padEnd(22);
      if (res.status === 200) {
        const file = save(`${ns}__${kind}`, res.json);
        console.log(`  ${pad} 200  ${describe(kind, res.json)}`);
        console.log(`  ${" ".repeat(22)}      saved -> ${path.relative(process.cwd(), file)}`);
        findings.push({ ns, kind, ok: true });
      } else {
        const why =
          res.status === 404
            ? realmOk
              ? "404 (realm exists, so: no profile data for this character)"
              : "404 (realm not found either — slug or namespace is wrong)"
            : `${res.status}`;
        console.log(`  ${pad} ${why}`);
        findings.push({ ns, kind, ok: false, status: res.status });
      }
    }
    console.log("");
  }

  // ---- verdict -----------------------------------------------------------
  const gotEquip = findings.find((f) => f.kind === "equipment" && f.ok);
  const gotTalents = findings.find((f) => f.kind === "specializations" && f.ok);

  console.log("=".repeat(66));
  if (gotEquip && gotTalents) {
    console.log(`GREEN: equipment AND talents both served under ${gotEquip.ns}.`);
    console.log("Send me the two JSON files from ./armory-probe/ and I'll build against the real shapes.");
  } else if (gotEquip) {
    console.log(`AMBER: equipment works (${gotEquip.ns}) but talents do not.`);
    console.log("Gear can move to the armory now; talents stay on the wowsims presets");
    console.log("until Blizzard serves them. Send me the equipment JSON.");
  } else if (findings.some((f) => f.ok)) {
    console.log("AMBER: some profile data is served, but not equipment.");
    console.log("Send me the console output — the pattern tells us what is missing.");
  } else {
    console.log("RED: no character profile data under any Classic namespace.");
    console.log("The web Armory is then rendering from something the public API");
    console.log("does not expose yet. We keep WCL as the gear source and revisit.");
    console.log("Before believing this: check the realm lookup lines above. If the");
    console.log("realm also 404'd, the slug is wrong and this verdict is worthless.");
  }
  console.log("=".repeat(66));
})();
