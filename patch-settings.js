/**
 * patch-settings.js - threads per-character overrides (race, professions,
 * talents) through the simulation path.
 *
 * Throwaway. Run once, check the output, delete it.
 * Aborts before writing anything if any anchor is missing.
 *
 * The whole design rests on one observation: buildWarlockPlayer and
 * buildSpecPlayer already read race/professions/talents off the SPEC object.
 * So an override is a cloned spec, not a new argument threaded through every
 * builder. That keeps this patch to three files and eight small edits.
 *
 * Backward compatible: every new parameter is optional, and omitting it
 * reproduces today's behaviour exactly.
 */

const fs = require("fs");
const path = require("path");

const DIR = "/root/wow-gear-check-server/";

// [file, [[anchor, replacement], ...], alreadyPatchedMarker]
const WORK = [
  ["sim.js", [
    [
      "async function runSimulation(gear, equippedItemDetails, overrideEquipment, specKey) {",
      '// Per-character overrides. Required here rather than at the top of the file\n' +
      '// so the patch needs no anchor in sim.js\'s header; the const is initialised\n' +
      '// during module evaluation, long before any request calls runSimulation.\n' +
      'const { applySpecOverrides } = require("./charoverrides");\n' +
      '\n' +
      'async function runSimulation(gear, equippedItemDetails, overrideEquipment, specKey, playerOverrides) {',
    ],
    [
      "  const otherSpec = getShamanSpec(specKey) || getClassSpec(specKey);\n  let requestObj;",
      "  // applySpecOverrides returns the spec untouched when there is nothing to\n" +
      "  // apply, and passes null straight through, so the `if (otherSpec)` branch\n" +
      "  // below still selects the right builder.\n" +
      "  const otherSpec = applySpecOverrides(getShamanSpec(specKey) || getClassSpec(specKey), playerOverrides);\n" +
      "  if (playerOverrides && Object.keys(playerOverrides).length) {\n" +
      "    console.log(\"  character overrides: \" + JSON.stringify(playerOverrides));\n" +
      "  }\n" +
      "  let requestObj;",
    ],
    [
      "    const spec = getWarlockSpec(specKey || DEFAULT_SPEC);",
      "    const spec = applySpecOverrides(getWarlockSpec(specKey || DEFAULT_SPEC), playerOverrides);",
    ],
  ], "playerOverrides"],

  ["upgrades.js", [
    [
      "async function runUpgradeSweep(gear, equippedItemDetails, presetItems, onProgress, specKey) {",
      "async function runUpgradeSweep(gear, equippedItemDetails, presetItems, onProgress, specKey, playerOverrides) {",
    ],
    [
      "  const baselineResult = await runSimulation(gear, equippedItemDetails, current, specKey);",
      "  const baselineResult = await runSimulation(gear, equippedItemDetails, current, specKey, playerOverrides);",
    ],
    [
      "      const result = await runSimulation(gear, equippedItemDetails, swapped, specKey);",
      "      const result = await runSimulation(gear, equippedItemDetails, swapped, specKey, playerOverrides);",
    ],
    [
      "    const fullResult = await runSimulation(gear, equippedItemDetails, { items: fullItems }, specKey);",
      "    const fullResult = await runSimulation(gear, equippedItemDetails, { items: fullItems }, specKey, playerOverrides);",
    ],
  ], "playerOverrides"],

  ["server.js", [
    [
      'const { isClassSpec, getClassSpec } = require("./classspecs");',
      'const { isClassSpec, getClassSpec } = require("./classspecs");\n' +
      'const charOverrides = require("./charoverrides");',
    ],
    [
      "    const { name, reportCode, fightId: fightIdParam, phase, targets, spec } = req.body || {};",
      "    const { name, reportCode, fightId: fightIdParam, phase, targets, spec, overrides } = req.body || {};",
    ],
    [
      `    const cacheKey = [
      reportCode, fightId, player.name, phaseKey, specName,
      targetItems.map((t) => (t ? t.id : 0)).join(","),
    ].join(":");`,
      `    // Overrides MUST be in the cache key. Without it, changing race would
    // return the previous race's numbers from cache and look like the setting
    // had no effect.
    let playerOverrides = null;
    try {
      playerOverrides = charOverrides.sanitise(overrides, player.type, spec);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const cacheKey = [
      reportCode, fightId, player.name, phaseKey, specName,
      targetItems.map((t) => (t ? t.id : 0)).join(","),
      charOverrides.overrideKey(playerOverrides),
    ].join(":");`,
    ],
    [
      `          job.currentSlot = p.slotName;
        }, spec);`,
      `          job.currentSlot = p.slotName;
        }, spec, playerOverrides);`,
    ],
  ], "charOverrides"],
];

const APPEND_TO_SERVER = `
// --- Per-character settings (added 2026-08-25) ------------------------------
// GET /api/spec-options?spec=...&class=... - legal races, professions and the
// wowsims defaults, so the browser never has to duplicate those tables.
charOverrides.registerSettingsRoutes(app);
console.log("charoverrides: settings route registered (/api/spec-options)");
`;

// --- Preflight: every anchor must be present before anything is written ----

if (!fs.existsSync(path.join(DIR, "charoverrides.js"))) {
  throw new Error("ABORT: charoverrides.js is not on the server yet. Copy it across first.");
}

const staged = [];
for (const [file, edits, marker] of WORK) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) throw new Error(`ABORT: ${file} not found.`);
  let src = fs.readFileSync(p, "utf8");

  if (src.includes(marker)) { console.log(`${file}: already patched, skipping.`); continue; }

  const missing = edits.filter(([a]) => !src.includes(a));
  if (missing.length) {
    console.error(`\nABORT: ${missing.length} anchor(s) did not match ${file}.\n`);
    missing.forEach(([a]) => console.error("--- expected ---\n" + a + "\n"));
    process.exit(1);
  }

  for (const [a, r] of edits) src = src.replace(a, r);
  if (file === "server.js" && !src.includes("registerSettingsRoutes(app)")) {
    src = src.replace(/\s*$/, "\n") + APPEND_TO_SERVER;
  }
  staged.push([file, src]);
}

if (!staged.length) {
  console.log("\nNothing to do - everything was already patched.");
  process.exit(0);
}

for (const [file, src] of staged) {
  const target = path.join(DIR, file);
  const bak = target + ".bak-settings";
  if (fs.existsSync(bak)) console.log(`${file}: backup already exists, leaving it alone.`);
  else { fs.copyFileSync(target, bak); console.log(`${file}: backed up to ${path.basename(bak)}`); }
  fs.writeFileSync(target, src);
  console.log(`${file}: patched.`);
}

console.log("\nDone. Now run the syntax checks before restarting.");
