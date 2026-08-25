/**
 * patch-lootcheck.js - wires the loot check into gamedb.js and server.js.
 *
 * Throwaway. Run once, confirm the output, delete it.
 * Aborts before writing anything if any anchor is missing, so a partial
 * application is not possible.
 */

const fs = require("fs");
const path = require("path");

const DIR = "/root/wow-gear-check-server/";
const changes = [];

function read(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) throw new Error(`ABORT: ${file} not found at ${p}`);
  return fs.readFileSync(p, "utf8");
}

function backupOnce(file) {
  const src = path.join(DIR, file);
  const bak = src + ".bak-lootcheck";
  // Existence guard: a re-run must NOT overwrite a pristine backup with an
  // already-patched file. This exact mistake destroyed a good .bak before.
  if (fs.existsSync(bak)) {
    console.log(`  backup already exists, leaving it alone: ${path.basename(bak)}`);
  } else {
    fs.copyFileSync(src, bak);
    console.log(`  backed up to ${path.basename(bak)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. gamedb.js - expose the item map so the search can iterate it.
// ---------------------------------------------------------------------------

const GAMEDB_ANCHOR = "module.exports = { loadGameDatabase, buildPlayerDatabase, buildDatabaseForItemSpecs, getItem };";
const GAMEDB_REPLACEMENT =
  "// The whole item map, for name search. Callers must await loadGameDatabase()\n" +
  "// first - the database is lazy and this returns an empty Map until it has.\n" +
  "function allItems() { return loaded ? loaded.items : new Map(); }\n" +
  "\n" +
  "module.exports = { loadGameDatabase, buildPlayerDatabase, buildDatabaseForItemSpecs, getItem, allItems };";

let gamedb = read("gamedb.js");
if (gamedb.includes("allItems")) {
  console.log("gamedb.js: already patched, skipping.");
} else if (!gamedb.includes(GAMEDB_ANCHOR)) {
  throw new Error("ABORT: gamedb.js module.exports line does not match the expected text.\nExpected:\n" + GAMEDB_ANCHOR);
} else {
  gamedb = gamedb.replace(GAMEDB_ANCHOR, GAMEDB_REPLACEMENT);
  changes.push(["gamedb.js", gamedb]);
}

// ---------------------------------------------------------------------------
// 2. server.js - register the routes.
//
// Appended at the end of the file. Express does not care about registration
// order for distinct paths, and appending cannot disturb anything above it.
// Every dependency is a hoisted function declaration or a const that is
// initialised long before this line runs.
// ---------------------------------------------------------------------------

const SERVER_ANCHORS = [
  "function resolveFightAndPlayers(",
  "function mapCombatantGearToSlots(",
  "function buildSweepTargets(",
  "const PRESET_BY_CLASS_PHASE = {",
];

const SERVER_ADDITION = `
// --- Item-centric loot check (added 2026-08-25) -----------------------------
// Registered last; Express does not care about order for distinct paths.
// Dependencies are passed in rather than re-implemented so gem/enchant
// resolution stays in buildSweepTargets alone and cannot drift between the
// upgrade sweep and the loot check.
const { registerLootRoutes } = require("./lootroutes");
const { allItems: allItemsMap } = require("./gamedb");

registerLootRoutes(app, {
  resolveFightAndPlayers,
  mapCombatantGearToSlots,
  buildSweepTargets,
  PRESET_BY_CLASS_PHASE,
  allItemsMap,
});
console.log("lootcheck: routes registered (/api/item-search, /api/loot-candidates, /api/loot-check)");
`;

let server = read("server.js");
if (server.includes("registerLootRoutes")) {
  console.log("server.js: already patched, skipping.");
} else {
  const missing = SERVER_ANCHORS.filter((a) => !server.includes(a));
  if (missing.length) {
    throw new Error("ABORT: server.js is missing expected anchors:\n  " + missing.join("\n  "));
  }
  server = server.replace(/\s*$/, "\n") + SERVER_ADDITION;
  changes.push(["server.js", server]);
}

// ---------------------------------------------------------------------------
// 3. Required new files must already be present.
// ---------------------------------------------------------------------------

for (const f of ["lootcheck.js", "lootroutes.js"]) {
  if (!fs.existsSync(path.join(DIR, f))) {
    throw new Error(`ABORT: ${f} is not on the server yet. Copy it across before patching.`);
  }
}

// ---------------------------------------------------------------------------
// Write only after every check has passed.
// ---------------------------------------------------------------------------

if (!changes.length) {
  console.log("\nNothing to do - both files were already patched.");
} else {
  for (const [file, contents] of changes) {
    console.log(`Patching ${file}:`);
    backupOnce(file);
    fs.writeFileSync(path.join(DIR, file), contents);
    console.log(`  written (${contents.split("\n").length} lines)`);
  }
  console.log("\nPatched successfully. Now run the syntax check before restarting.");
}
