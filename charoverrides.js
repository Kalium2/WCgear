/**
 * charoverrides.js - per-character settings that Warcraft Logs cannot tell us.
 *
 * WCL reports no race at all, and `combatantInfo.talents` is placeholder junk
 * ("UseDatabaseForName", guid 0) in Classic logs. So build and race are things
 * only a human can supply. Everything defaults to the wowsims value for the
 * spec, and the user corrects it only if they are not the common case - a
 * player who never opens the settings still gets a sensible answer.
 *
 * DESIGN NOTE - why this file touches no player builder:
 * `buildWarlockPlayer` and `buildSpecPlayer` already read `race`,
 * `profession1`, `profession2` and `talents` off the SPEC object. So an
 * override is applied by cloning the spec with new values, not by threading a
 * new argument through five function signatures. One small change in
 * runSimulation, and everything downstream works unchanged.
 *
 * DEPENDENCY NOTE: this file must never require sim.js, upgrades.js or
 * lootcheck.js. sim.js requires THIS file, so any of those would be circular.
 * The spec registries only require fs/path, so they are safe.
 */

const { getWarlockSpec, isWarlockSpec } = require("./warlockspecs");
const { getShamanSpec, isShamanSpec } = require("./shamanspecs");
const { getClassSpec, isClassSpec } = require("./classspecs");

// ---------------------------------------------------------------------------
// HAND-ENTERED DATA - NEEDS A DOMAIN CHECK.
//
// TBC class-race combinations. There is no data source for this in db.bin or
// the protos, so it is transcribed. A wrong row lets someone simulate a
// character that cannot exist, or hides a legal choice.
//
// Only the four simulatable classes. Anyone else cannot be simulated anyway.
// ---------------------------------------------------------------------------

const RACES_BY_CLASS = {
  Warlock: ["RaceHuman", "RaceGnome", "RaceOrc", "RaceUndead", "RaceBloodElf"],
  Shaman: ["RaceDraenei", "RaceOrc", "RaceTauren", "RaceTroll"],
  Warrior: [
    "RaceHuman", "RaceDwarf", "RaceNightElf", "RaceGnome", "RaceDraenei",
    "RaceOrc", "RaceUndead", "RaceTauren", "RaceTroll",
  ],
  Hunter: [
    "RaceDwarf", "RaceNightElf", "RaceDraenei",
    "RaceOrc", "RaceTauren", "RaceTroll", "RaceBloodElf",
  ],
};

const RACE_LABELS = {
  RaceBloodElf: "Blood Elf", RaceDraenei: "Draenei", RaceDwarf: "Dwarf",
  RaceGnome: "Gnome", RaceHuman: "Human", RaceNightElf: "Night Elf",
  RaceOrc: "Orc", RaceTauren: "Tauren", RaceTroll: "Troll", RaceUndead: "Undead",
};

// proto.Profession, read from common.proto 2026-08-25. Unknown is offered as
// "None" so a player can clear a profession they do not have.
const PROFESSIONS = [
  "ProfessionUnknown", "Alchemy", "Blacksmithing", "Enchanting", "Engineering",
  "Herbalism", "Inscription", "Jewelcrafting", "Leatherworking", "Mining",
  "Skinning", "Tailoring",
];

// TBC talent strings are digits and dashes only - e.g. Arms Warrior
// "32005020352010500221-0550000500521203". Deliberately strict: an unparseable
// string sent to wowsimtbc is a confusing failure, and silently ignoring a
// typo would be worse than rejecting it.
const TALENTS_RE = /^[0-9-]{1,64}$/;

function resolveSpecEntry(specKey) {
  if (!specKey) return null;
  if (!(isWarlockSpec(specKey) || isShamanSpec(specKey) || isClassSpec(specKey))) return null;
  // Order matches server.js: getWarlockSpec is lenient and must stay last.
  return getShamanSpec(specKey) || getClassSpec(specKey) || getWarlockSpec(specKey) || null;
}

/** What the settings UI needs: legal choices plus the wowsims defaults. */
function optionsFor(specKey, className) {
  const spec = resolveSpecEntry(specKey);
  if (!spec) return null;

  const races = (RACES_BY_CLASS[className] || []).map((r) => ({ value: r, label: RACE_LABELS[r] || r }));

  // A spec's own default must always be offered even if the table above
  // disagrees - wowsims picked it, so it is legal, and our transcription is
  // the less trustworthy of the two.
  if (spec.race && !races.some((r) => r.value === spec.race)) {
    races.unshift({ value: spec.race, label: (RACE_LABELS[spec.race] || spec.race) + " (wowsims default)" });
  }

  return {
    specKey,
    specLabel: spec.label,
    races,
    professions: PROFESSIONS.map((p) => ({ value: p, label: p === "ProfessionUnknown" ? "None" : p })),
    defaults: {
      race: spec.race || "RaceUnknown",
      profession1: spec.profession1 || "ProfessionUnknown",
      profession2: spec.profession2 || "ProfessionUnknown",
      talents: spec.talents || "",
    },
  };
}

/**
 * Validate and normalise what the browser sent. Returns null when there is
 * nothing to apply, so the caller can treat "no overrides" and "overrides that
 * match the defaults" identically.
 *
 * Throws on invalid input rather than silently dropping it - a setting that
 * appears to apply but doesn't is the worst outcome here.
 */
function sanitise(raw, className, specKey) {
  if (!raw || typeof raw !== "object") return null;
  const spec = resolveSpecEntry(specKey);
  if (!spec) return null;

  const out = {};

  if (raw.race) {
    const legal = RACES_BY_CLASS[className] || [];
    if (raw.race !== spec.race && legal.length && !legal.includes(raw.race)) {
      throw new Error(`${RACE_LABELS[raw.race] || raw.race} is not a valid race for a ${className}.`);
    }
    if (raw.race !== spec.race) out.race = raw.race;
  }

  for (const key of ["profession1", "profession2"]) {
    if (!raw[key]) continue;
    if (!PROFESSIONS.includes(raw[key])) throw new Error(`Unknown profession: ${raw[key]}`);
    if (raw[key] !== (spec[key] || "ProfessionUnknown")) out[key] = raw[key];
  }

  if (raw.talents) {
    const t = String(raw.talents).trim();
    if (!TALENTS_RE.test(t)) {
      throw new Error("That talent string doesn't look valid - TBC strings are digits and dashes only.");
    }
    if (t !== spec.talents) out.talents = t;
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Clone the spec with the overrides applied. Shallow clone on purpose - the
 * registries hand back shared table objects, and mutating one would leak into
 * every later simulation in the process.
 */
function applySpecOverrides(spec, overrides) {
  if (!spec || !overrides || !Object.keys(overrides).length) return spec;
  return Object.assign({}, spec, overrides);
}

/**
 * Stable cache-key fragment. MUST be folded into every cache key that can hold
 * a simulation result, or changing race would silently return the old numbers.
 */
function overrideKey(overrides) {
  if (!overrides || !Object.keys(overrides).length) return "default";
  return Object.keys(overrides).sort().map((k) => k + "=" + overrides[k]).join("|");
}

/** GET /api/spec-options?spec=destruction_warlock&class=Warlock */
function registerSettingsRoutes(app) {
  app.get("/api/spec-options", (req, res) => {
    const { spec, class: className } = req.query;
    const opts = optionsFor(spec, className);
    if (!opts) return res.status(404).json({ error: "No simulation is available for that specialization." });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(opts);
  });
}

module.exports = {
  RACES_BY_CLASS, RACE_LABELS, PROFESSIONS,
  optionsFor, sanitise, applySpecOverrides, overrideKey,
  registerSettingsRoutes, resolveSpecEntry,
};
