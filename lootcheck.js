/**
 * lootcheck.js - item-centric loot check.
 *
 * The inverse of upgrades.js. The sweep asks "given this player, which items
 * help most?" This asks "given this item, which player gains most?" Same
 * engine, same data, same paired-seed method - a different axis, not a
 * different product.
 *
 * Design notes worth keeping:
 *
 *  - BASELINES ARE CACHED per (report, fight, player, spec, phase, mode) for
 *    a raid night. A council checks many items against a stable baseline, so
 *    the first check on a player costs two sims and every later one costs one.
 *
 *  - PAIRING IS THE WHOLE POINT. sim.js pins randomSeed to 1, so every run is
 *    comparable to every other. That matters more here than in the sweep: a
 *    council may be separating two candidates by a few DPS, and unpaired Monte
 *    Carlo noise would swamp that difference and hand them a confident wrong
 *    answer.
 *
 *  - PAIRED SLOTS ARE SIMULATED IN BOTH POSITIONS. For a ring or trinket the
 *    real answer is "it replaces your weaker one", and there is no way to know
 *    which is weaker without asking. Costs a second sim; buys a correct answer.
 *
 *  - ELIGIBILITY ERRS TOWARD INCLUDING. The council confirms the shortlist, so
 *    an extra name costs one click. A missing name is invisible - they have no
 *    way to know the tool omitted someone.
 */

const { runSimulation, buildEquipmentSpec } = require("./sim");
const { getItem } = require("./gamedb");
const { SLOT_NAMES } = require("./upgrades");
const { isWarlockSpec, getWarlockSpec } = require("./warlockspecs");
const { isShamanSpec, getShamanSpec } = require("./shamanspecs");
const { isClassSpec, getClassSpec } = require("./classspecs");

// ---------------------------------------------------------------------------
// Enum values - read from proto/common.proto 2026-08-25, not inferred.
// ---------------------------------------------------------------------------

const ITEM_TYPE = {
  HEAD: 1, NECK: 2, SHOULDER: 3, BACK: 4, CHEST: 5, WRIST: 6, HANDS: 7,
  WAIST: 8, LEGS: 9, FEET: 10, FINGER: 11, TRINKET: 12, WEAPON: 13, RANGED: 14,
};

const HAND_TYPE = { UNKNOWN: 0, MAIN_HAND: 1, ONE_HAND: 2, OFF_HAND: 3, TWO_HAND: 4 };

const ARMOR = { NONE: 0, CLOTH: 1, LEATHER: 2, MAIL: 3, PLATE: 4 };

const WEAPON = {
  AXE: 1, DAGGER: 2, FIST: 3, MACE: 4, OFFHAND: 5, POLEARM: 6,
  SHIELD: 7, STAFF: 8, SWORD: 9,
};

const RANGED = {
  BOW: 1, CROSSBOW: 2, GUN: 3, THROWN: 4, WAND: 5,
  IDOL: 6, LIBRAM: 7, TOTEM: 8, SIGIL: 9,
};

const CLASS_ENUM = {
  ClassWarrior: 1, ClassPaladin: 2, ClassHunter: 3, ClassRogue: 4,
  ClassPriest: 5, ClassShaman: 7, ClassMage: 8, ClassWarlock: 9, ClassDruid: 11,
};

// Non-weapon item types map straight onto equipment indices. Paired slots list
// both positions; the check simulates each and reports the better.
const SLOTS_FOR_TYPE = {
  [ITEM_TYPE.HEAD]: [0], [ITEM_TYPE.NECK]: [1], [ITEM_TYPE.SHOULDER]: [2],
  [ITEM_TYPE.BACK]: [3], [ITEM_TYPE.CHEST]: [4], [ITEM_TYPE.WRIST]: [5],
  [ITEM_TYPE.HANDS]: [6], [ITEM_TYPE.WAIST]: [7], [ITEM_TYPE.LEGS]: [8],
  [ITEM_TYPE.FEET]: [9], [ITEM_TYPE.FINGER]: [10, 11],
  [ITEM_TYPE.TRINKET]: [12, 13], [ITEM_TYPE.RANGED]: [16],
};

const PAIRED_SLOT = { 10: 11, 11: 10, 12: 13, 13: 12 };

// ---------------------------------------------------------------------------
// HAND-ENTERED DATA - NEEDS A DOMAIN CHECK.
//
// db.bin carries no weapon/armor proficiency table. Its `classAllowlist` only
// covers items with an explicit per-class restriction, which is a small
// minority. So this table is transcribed from the game rather than read from
// data, and it is exactly the kind of thing that has been silently wrong on
// this project before.
//
// Only the four simulatable classes are here. Anyone else cannot be checked
// regardless, so an omission costs nothing.
//
// `maxArmor` means "can equip at or below" - a Shaman genuinely does sometimes
// wear a cloth caster piece, so this is the equip rule, not a preference rule.
// ---------------------------------------------------------------------------

const CLASS_PROFILE = {
  Warlock: {
    classId: CLASS_ENUM.ClassWarlock,
    maxArmor: ARMOR.CLOTH,
    oneHand: new Set([WEAPON.DAGGER, WEAPON.SWORD]),
    twoHand: new Set([WEAPON.STAFF]),
    offHand: new Set([WEAPON.OFFHAND]),
    ranged: new Set([RANGED.WAND]),
  },
  Shaman: {
    classId: CLASS_ENUM.ClassShaman,
    maxArmor: ARMOR.MAIL,
    oneHand: new Set([WEAPON.AXE, WEAPON.MACE, WEAPON.DAGGER, WEAPON.FIST]),
    twoHand: new Set([WEAPON.AXE, WEAPON.MACE, WEAPON.STAFF]),
    offHand: new Set([WEAPON.OFFHAND, WEAPON.SHIELD]),
    ranged: new Set([RANGED.TOTEM]),
  },
  Warrior: {
    classId: CLASS_ENUM.ClassWarrior,
    maxArmor: ARMOR.PLATE,
    oneHand: new Set([WEAPON.AXE, WEAPON.MACE, WEAPON.SWORD, WEAPON.DAGGER, WEAPON.FIST]),
    twoHand: new Set([WEAPON.AXE, WEAPON.MACE, WEAPON.SWORD, WEAPON.POLEARM, WEAPON.STAFF]),
    offHand: new Set([WEAPON.OFFHAND, WEAPON.SHIELD]),
    ranged: new Set([RANGED.BOW, RANGED.CROSSBOW, RANGED.GUN, RANGED.THROWN]),
  },
  Hunter: {
    classId: CLASS_ENUM.ClassHunter,
    maxArmor: ARMOR.MAIL,
    oneHand: new Set([WEAPON.AXE, WEAPON.SWORD, WEAPON.DAGGER, WEAPON.FIST]),
    twoHand: new Set([WEAPON.AXE, WEAPON.SWORD, WEAPON.POLEARM, WEAPON.STAFF]),
    offHand: new Set([WEAPON.OFFHAND]),
    ranged: new Set([RANGED.BOW, RANGED.CROSSBOW, RANGED.GUN]),
  },
};

// ---------------------------------------------------------------------------
// Spec resolution
//
// Three parallel registries with no unified lookup. server.js already does the
// a || b || c chain inline; this is the same chain in one place so a fourth
// registry does not mean a fourth copy. Order matches server.js exactly -
// getWarlockSpec is lenient and must stay last.
// ---------------------------------------------------------------------------

function specIsSimulatable(specKey) {
  if (!specKey) return false;
  return isWarlockSpec(specKey) || isShamanSpec(specKey) || isClassSpec(specKey);
}

function resolveSpec(specKey) {
  if (!specIsSimulatable(specKey)) return null;
  return getShamanSpec(specKey) || getClassSpec(specKey) || getWarlockSpec(specKey) || null;
}

// ---------------------------------------------------------------------------
// Item lookup and search
// ---------------------------------------------------------------------------

function summariseItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    icon: item.icon,
    quality: item.quality,
    phase: item.phase,
    type: item.type,
    handType: item.handType,
    armorType: item.armorType,
    weaponType: item.weaponType,
    rangedWeaponType: item.rangedWeaponType,
    unique: Boolean(item.unique),
    setName: item.setName || "",
    slots: slotsForItem(item),
  };
}

/**
 * Name search over the whole item database. A bare number is treated as an
 * item ID so a Wowhead link's tail still works without a second input.
 */
function searchItems(allItemsMap, query, limit) {
  const cap = limit || 20;
  const raw = String(query || "").trim();
  if (!raw) return [];

  if (/^\d+$/.test(raw)) {
    const direct = getItem(Number(raw));
    return direct ? [summariseItem(direct)] : [];
  }

  const q = raw.toLowerCase();
  if (q.length < 2) return [];

  const hits = [];
  for (const item of allItemsMap.values()) {
    const name = item && item.name;
    if (!name) continue;
    const idx = name.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    // Prefix matches first, then earliest match position, then higher quality
    // (epics before greens), then alphabetical for a stable order.
    hits.push({ item, rank: (idx === 0 ? 0 : 1e6) + idx * 100 - (item.quality || 0) });
  }

  hits.sort((a, b) => a.rank - b.rank || String(a.item.name).localeCompare(String(b.item.name)));
  return hits.slice(0, cap).map((h) => summariseItem(h.item));
}

/** Which equipment indices does this item compete for? */
function slotsForItem(item) {
  if (!item) return [];
  if (item.type === ITEM_TYPE.WEAPON) {
    switch (item.handType) {
      case HAND_TYPE.TWO_HAND: return [14];
      case HAND_TYPE.MAIN_HAND: return [14];
      case HAND_TYPE.OFF_HAND: return [15];
      case HAND_TYPE.ONE_HAND: return [14, 15];
      default: return [14];
    }
  }
  return SLOTS_FOR_TYPE[item.type] || [];
}

let loggedAllowlistShape = false;

/**
 * Can this class physically equip this item? Database-derived where possible
 * (classAllowlist, armorType), table-driven only for weapon proficiency.
 *
 * Returns { ok, reason } - reason is shown to the council when a roster member
 * is excluded, because "we did not consider this person" needs to be visible.
 */
function canEquip(className, item) {
  const prof = CLASS_PROFILE[className];
  if (!prof) return { ok: false, reason: `no simulation for ${className || "this class"}` };
  if (!item) return { ok: false, reason: "item not found" };

  const allow = Array.isArray(item.classAllowlist) ? item.classAllowlist : [];
  if (allow.length) {
    if (!loggedAllowlistShape) {
      loggedAllowlistShape = true;
      console.log("lootcheck: first non-empty classAllowlist seen:", JSON.stringify(allow));
    }
    const ids = allow.map((v) => (typeof v === "number" ? v : CLASS_ENUM[String(v)]));
    if (!ids.includes(prof.classId)) return { ok: false, reason: "restricted to other classes" };
  }

  if (item.type === ITEM_TYPE.WEAPON) {
    const wt = item.weaponType;
    let allowed;
    switch (item.handType) {
      case HAND_TYPE.TWO_HAND: allowed = prof.twoHand.has(wt); break;
      case HAND_TYPE.OFF_HAND: allowed = prof.offHand.has(wt) || prof.oneHand.has(wt); break;
      default: allowed = prof.oneHand.has(wt) || prof.twoHand.has(wt); break;
    }
    return allowed ? { ok: true } : { ok: false, reason: `${className}s cannot use that weapon` };
  }

  if (item.type === ITEM_TYPE.RANGED) {
    return prof.ranged.has(item.rangedWeaponType)
      ? { ok: true }
      : { ok: false, reason: `${className}s cannot use that ranged weapon` };
  }

  const armor = item.armorType || ARMOR.NONE;
  if (armor === ARMOR.NONE) return { ok: true };
  return armor <= prof.maxArmor
    ? { ok: true }
    : { ok: false, reason: `${className}s cannot wear that armor type` };
}

// ---------------------------------------------------------------------------
// Baseline cache
//
// Deliberately separate from sweepCache in server.js. A sweep result is
// disposable - 15 minutes is right. A baseline is worth keeping for the whole
// raid night, which is the entire reason the loot check is fast enough to use
// mid-raid.
// ---------------------------------------------------------------------------

const baselineCache = new Map();
const BASELINE_TTL_MS = 6 * 60 * 60 * 1000;

function baselineKey(ctx) {
  return [
    ctx.reportCode, ctx.fightId, String(ctx.name || "").toLowerCase(),
    ctx.specKey, ctx.phase, ctx.mode,
  ].join(":");
}

function pruneBaselines() {
  const now = Date.now();
  for (const [k, v] of baselineCache) {
    if (now - v.at > BASELINE_TTL_MS) baselineCache.delete(k);
  }
}

function dpsOf(result) {
  return result && result.raidMetrics && result.raidMetrics.dps
    ? result.raidMetrics.dps.avg
    : null;
}

async function getBaseline(ctx, gear, details, current) {
  pruneBaselines();
  const key = baselineKey(ctx);
  const hit = baselineCache.get(key);
  if (hit) return { dps: hit.dps, cached: true };

  const result = await runSimulation(gear, details, current, ctx.specKey);
  const dps = dpsOf(result);
  if (dps == null) throw new Error("Baseline simulation returned no DPS.");
  baselineCache.set(key, { dps, at: Date.now() });
  return { dps, cached: false };
}

function baselineStats() {
  pruneBaselines();
  return { entries: baselineCache.size };
}

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

/**
 * @param item        the database item record
 * @param candidates  [{ name, className, specKey, gear, details }]
 * @param ctx         { reportCode, fightId, phase, mode }
 * @param resolveTarget(candidate, slot, itemId, displacedItem) -> { id, enchant, gems }
 *                    supplied by the route layer so gemming/enchant resolution
 *                    stays in ONE place (buildSweepTargets) and cannot drift
 *                    between the sweep and the loot check. `displacedItem` lets
 *                    it fall back to the gems the player already has in that
 *                    slot when no preset covers their class.
 * @param onProgress  ({ done, total, currentName }) => void
 */
async function runLootCheck({ item, candidates, ctx, resolveTarget, onProgress }) {
  const itemSlots = slotsForItem(item);
  if (!itemSlots.length) {
    throw new Error(`${item.name} has no equippable slot we recognise (type ${item.type}).`);
  }

  const results = [];
  let done = 0;
  const total = candidates.length;

  for (const cand of candidates) {
    const base = {
      name: cand.name,
      className: cand.className,
      specKey: cand.specKey,
      specLabel: (resolveSpec(cand.specKey) || {}).label || cand.specKey,
    };

    if (onProgress) onProgress({ done, total, currentName: cand.name });

    try {
      const current = buildEquipmentSpec(cand.gear, cand.details);

      // Already wearing it? Say so rather than simulating a no-op, and treat a
      // unique-equipped item held in EITHER paired slot as already equipped -
      // a second copy is an impossible set-up and would come back as a large
      // fake negative. db.bin exposes `unique` directly, so this needs no
      // heuristic.
      const wornSlots = [];
      for (let s = 0; s < 17; s++) {
        if ((current.items[s] || {}).id === item.id) wornSlots.push(s);
      }
      if (wornSlots.length) {
        results.push({
          ...base,
          status: "already_equipped",
          wornSlot: wornSlots[0],
          wornSlotName: SLOT_NAMES[wornSlots[0]],
        });
        done++;
        continue;
      }

      const { dps: baselineDps, cached } = await getBaseline(
        { ...ctx, name: cand.name, specKey: cand.specKey },
        cand.gear, cand.details, current
      );

      // A unique item cannot go into a paired slot whose sibling already holds
      // one - but we established above that it is worn nowhere, so all listed
      // slots are open to it.
      const perSlot = [];
      for (const slot of itemSlots) {
        const target = resolveTarget(cand, slot, item.id, current.items[slot] || {});

        // A two-hander UNEQUIPS the off-hand. Without this the sim runs an
        // impossible set-up - two-hander plus off-hand - and inflates the
        // delta. Same family as the unique-trinket double-equip: the engine
        // does not reject it, it just answers a question nobody asked.
        // `{}` is what buildEquipmentSpec emits for an empty slot, so indices
        // do not shift.
        const clearsOffHand =
          slot === 14 && item.type === ITEM_TYPE.WEAPON && item.handType === HAND_TYPE.TWO_HAND;

        const override = {
          items: current.items.map((it, i) => {
            if (i === slot) return target;
            if (clearsOffHand && i === 15) return {};
            return it;
          }),
        };
        const result = await runSimulation(cand.gear, cand.details, override, cand.specKey);
        const dps = dpsOf(result);
        if (dps == null) continue;
        perSlot.push({
          slot,
          slotName: SLOT_NAMES[slot],
          dps,
          delta: dps - baselineDps,
          replacedItemId: (current.items[slot] || {}).id || null,
          // Surfaced so the UI can say "replaces both weapons" - a delta that
          // costs a player their off-hand is a different proposition from one
          // that does not, and hiding that would mislead.
          alsoReplacedItemId: clearsOffHand ? (current.items[15] || {}).id || null : null,
        });
      }

      if (!perSlot.length) throw new Error("No simulation returned a DPS figure.");

      // Best position wins - "it replaces your weaker trinket" is the answer.
      perSlot.sort((a, b) => b.delta - a.delta);
      const best = perSlot[0];

      results.push({
        ...base,
        status: "ok",
        baselineDps,
        baselineCached: cached,
        delta: best.delta,
        slot: best.slot,
        slotName: best.slotName,
        replacedItemId: best.replacedItemId,
        perSlot,
      });
    } catch (err) {
      results.push({ ...base, status: "error", error: String(err.message || err) });
    }

    done++;
    if (onProgress) onProgress({ done, total, currentName: null });
  }

  // Winners first; anything that could not be simulated sinks to the bottom
  // but is never dropped - a silent omission is the failure mode we care about.
  results.sort((a, b) => {
    if (a.status === "ok" && b.status === "ok") return b.delta - a.delta;
    if (a.status === "ok") return -1;
    if (b.status === "ok") return 1;
    return 0;
  });

  return results;
}

module.exports = {
  searchItems,
  summariseItem,
  slotsForItem,
  canEquip,
  resolveSpec,
  specIsSimulatable,
  runLootCheck,
  baselineStats,
  CLASS_PROFILE,
  ITEM_TYPE,
  PAIRED_SLOT,
};
