/**
 * lootroutes.js - HTTP surface for the item-centric loot check.
 *
 * Kept out of server.js so the whole feature arrives as two new files plus a
 * two-line patch, rather than a 150-line insertion into a file that has been
 * corrupted by hand-editing before.
 *
 * Everything server.js already owns is passed in as a dependency rather than
 * re-implemented - above all `buildSweepTargets`, so gem and enchant
 * resolution stays in exactly one place and the loot check can never disagree
 * with the upgrade sweep about the same item.
 */

const fs = require("fs");
const path = require("path");

const {
  searchItems, summariseItem, slotsForItem, canEquip,
  resolveSpec, specIsSimulatable, runLootCheck,
} = require("./lootcheck");
const { getItem, loadGameDatabase } = require("./gamedb");

const JOB_TTL_MS = 30 * 60 * 1000;
const lootJobs = new Map();

function pruneLootJobs() {
  const now = Date.now();
  for (const [id, job] of lootJobs) {
    if (now - job.startedAt > JOB_TTL_MS) lootJobs.delete(id);
  }
}

/**
 * Warcraft Logs reports a spec label and a class; our keys are
 * "<stem>_<class>", lowercase.
 *
 * The naive version of this built ONE candidate key and gave up. That silently
 * hid every Hunter: WCL spells multi-word specs without a space
 * ("BeastMastery"), which produced "beastmastery_hunter" and matched nothing,
 * so a spec with a perfectly good working sim was reported as unsupported.
 * Every other working spec is a single word, which is why nothing else broke
 * and why it went unnoticed.
 *
 * So: try every plausible spelling and keep the first that resolves. Cheap,
 * and it stops the same trap being reset by the next multi-word spec added
 * (Feral Combat, Beast Mastery, Shadow Priest...).
 */
const SPEC_ALIASES = {
  beastmastery: ["beast_mastery"],
  beastmaster: ["beast_mastery"],
  moonkin: ["balance"],
  boomkin: ["balance"],
  feralcombat: ["feral", "feral_cat", "feral_combat"],
  feral: ["feral_cat", "feral_combat"],
  cat: ["feral", "feral_cat"],
  guardian: ["feral_bear", "bear"],
  resto: ["restoration"],
  combat: ["combat"],
};

// Log an unmatched spec ONCE so the server reports coverage gaps itself,
// rather than a whole class quietly disappearing from every shortlist.
const loggedUnmatched = new Set();

function specKeyFromWcl(specLabel, className) {
  if (!className) return null;
  const cls = String(className).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const raw = String(specLabel || "").trim();
  if (!raw || !cls) return null;

  const stems = new Set();
  const tidy = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  stems.add(tidy(raw));                                          // "Beast Mastery" -> beast_mastery
  stems.add(tidy(raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2")));    // "BeastMastery"  -> beast_mastery
  stems.add(raw.toLowerCase().replace(/[^a-z0-9]/g, ""));         // -> beastmastery

  for (const s of Array.from(stems)) {
    for (const alias of SPEC_ALIASES[s.replace(/_/g, "")] || []) stems.add(alias);
  }

  for (const stem of stems) {
    if (!stem) continue;
    const key = stem + "_" + cls;
    if (specIsSimulatable(key)) return key;
  }

  const tag = raw + "/" + className;
  if (!loggedUnmatched.has(tag)) {
    loggedUnmatched.add(tag);
    console.log(
      `lootcheck: no sim for spec "${raw}" (${className}) - tried ` +
      Array.from(stems).map((s) => s + "_" + cls).join(", ")
    );
  }
  return null;
}

function registerLootRoutes(app, deps) {
  const {
    resolveFightAndPlayers,
    mapCombatantGearToSlots,
    buildSweepTargets,
    PRESET_BY_CLASS_PHASE,
    presetPathFor,
    allItemsMap,
  } = deps;

  const presetCache = new Map();

  // Spec-keyed where server.js offers it, class-keyed otherwise. Without the
  // spec key a Fury warrior borrows the Arms gemming reference - Arms is a
  // two-hander build and Fury dual-wields, so those sets are not interchangeable.
  function loadPreset(specKey, className, phaseKey) {
    const rel = presetPathFor
      ? presetPathFor(specKey, className, phaseKey)
      : (PRESET_BY_CLASS_PHASE[className] || {})[phaseKey];
    if (!rel) return { items: [] };
    if (presetCache.has(rel)) return presetCache.get(rel);
    let parsed = { items: [] };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(__dirname, rel), "utf8"));
    } catch (err) {
      console.log(`lootcheck: could not read preset ${rel} - ${err.message}`);
    }
    presetCache.set(rel, parsed);
    return parsed;
  }

  /**
   * One place for gemming. buildSweepTargets already trims borrowed gems to the
   * target item's real socket count; the only addition here is a fall-back to
   * whatever the player already had in that slot, for classes with no preset on
   * file. An item with more sockets than its donor stays slightly understated -
   * the same known, documented caveat the sweep carries.
   */
  function makeResolveTarget(phaseKey) {
    return function resolveTarget(candidate, slot, itemId, displaced) {
      const preset = loadPreset(candidate.specKey, candidate.className, phaseKey);
      const built = buildSweepTargets([{ slot, itemId }], preset)[slot] || { id: itemId, enchant: 0, gems: [] };

      if (!built.gems || !built.gems.length) {
        const dbItem = getItem(itemId);
        const sockets = dbItem && Array.isArray(dbItem.gemSockets) ? dbItem.gemSockets.length : 0;
        const inherited = Array.isArray(displaced && displaced.gems) ? displaced.gems.filter(Boolean) : [];
        if (inherited.length) built.gems = inherited.slice(0, sockets);
      }
      if (!built.enchant && displaced && displaced.enchant) built.enchant = displaced.enchant;

      return built;
    };
  }

  // -------------------------------------------------------------------------
  // Item search - drives the "what dropped?" box.
  // -------------------------------------------------------------------------

  // Every route that touches the item database must await it first. The
  // database is LAZY - allItems() returns an empty Map and getItem() returns
  // undefined until something has loaded it. On a freshly restarted server
  // that made item search silently return no results until an unrelated
  // simulation happened to warm it.
  app.get("/api/item-search", async (req, res) => {
    try {
      await loadGameDatabase();
      const { q, limit } = req.query;
      const results = searchItems(allItemsMap(), q, Math.min(Number(limit) || 20, 50));
      res.set("Cache-Control", "public, max-age=3600");
      res.json({ query: q || "", results });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Item search failed." });
    }
  });

  // -------------------------------------------------------------------------
  // Candidate shortlist.
  //
  // Returns TWO lists. `candidates` are people we can actually simulate;
  // `excluded` is everyone else with the reason. A council needs to see that
  // the tool is silent about someone rather than assume it ruled them out -
  // "no sim for Rogues yet" and "cannot use that weapon" are very different
  // answers, and neither is "no".
  // -------------------------------------------------------------------------

  app.get("/api/loot-candidates", async (req, res) => {
    try {
      await loadGameDatabase();
      const { itemId, reportCode, fightId: fightIdParam } = req.query;
      if (!itemId || !reportCode) return res.status(400).json({ error: "Missing item ID or report code." });

      const item = getItem(Number(itemId));
      if (!item) return res.status(404).json({ error: "That item is not in the game database." });

      const { allPlayers, fightId } = await resolveFightAndPlayers(reportCode, fightIdParam);

      // The WHOLE roster comes back, flagged - the tool does not decide who is
      // in contention. Eligibility is reported as information the council reads,
      // not as a filter applied on their behalf, which is the stated design
      // philosophy: give people the data and let them decide.
      const roster = allPlayers.map((p) => {
        const className = p.type || "Unknown";
        const wclSpec = p.specs && p.specs[0] ? p.specs[0].spec : null;
        const specKey = specKeyFromWcl(wclSpec, className);
        const spec = specKey ? resolveSpec(specKey) : null;
        const equip = canEquip(className, item);

        const reasons = [];
        if (!specKey) {
          reasons.push(wclSpec
            ? `no simulation for ${wclSpec} ${className} yet`
            : `Warcraft Logs reported no spec for this ${className}`);
        }
        if (!equip.ok) reasons.push(equip.reason);

        return {
          name: p.name,
          className,
          wclSpec,
          specKey: specKey || null,
          specLabel: (spec && spec.label) || wclSpec || className,
          simulatable: Boolean(specKey),
          equippable: equip.ok,
          reason: reasons.join("; "),
        };
      });

      // Usable candidates first, then people we could sim but who cannot wear
      // it, then everyone else - alphabetical within each band.
      const band = (r) => (r.simulatable && r.equippable ? 0 : r.simulatable ? 1 : 2);
      roster.sort((a, b) => band(a) - band(b) || a.name.localeCompare(b.name));

      res.set("Cache-Control", "no-store");
      res.json({ fightId, item: summariseItem(item), roster });
    } catch (err) {
      console.error(err);
      res.status(err.status || 502).json({ error: err.status ? err.message : "Could not build a candidate list." });
    }
  });

  // -------------------------------------------------------------------------
  // The check. Job API, same shape as /api/upgrade-sweep, because the frontend
  // already knows how to poll that.
  // -------------------------------------------------------------------------

  app.post("/api/loot-check", async (req, res) => {
    try {
      pruneLootJobs();
      await loadGameDatabase();

      const { itemId, reportCode, fightId: fightIdParam, phase, mode, candidates } = req.body || {};
      if (!itemId || !reportCode) return res.status(400).json({ error: "Missing item ID or report code." });
      if (!Array.isArray(candidates) || !candidates.length) {
        return res.status(400).json({ error: "Pick at least one candidate to compare." });
      }
      if (candidates.length > 8) {
        return res.status(400).json({ error: "Compare at most 8 candidates at once." });
      }

      const phaseKey = phase === "phase3" ? "phase3" : "phase4";
      // Both modes currently resolve to identical settings - no player can
      // customise a build or race yet. It is threaded through the cache key
      // anyway so the plumbing is real the day that changes.
      const modeKey = mode === "standardised" ? "standardised" : "actual";

      const item = getItem(Number(itemId));
      if (!item) return res.status(404).json({ error: "That item is not in the game database." });
      if (!slotsForItem(item).length) {
        return res.status(400).json({ error: `${item.name} is not an equippable item we can evaluate.` });
      }

      const { allPlayers, fightId } = await resolveFightAndPlayers(reportCode, fightIdParam);

      const resolved = [];
      for (const wanted of candidates) {
        const name = typeof wanted === "string" ? wanted : wanted && wanted.name;
        if (!name) continue;
        const p = allPlayers.find((x) => (x.name || "").toLowerCase() === String(name).trim().toLowerCase());
        if (!p) return res.status(404).json({ error: `${name} is not in that report.` });

        const className = p.type || "Unknown";
        const specKey =
          (typeof wanted === "object" && wanted.specKey) ||
          specKeyFromWcl(p.specs && p.specs[0] ? p.specs[0].spec : null, className);

        if (!specKey || !specIsSimulatable(specKey)) {
          return res.status(400).json({ error: `No simulation is available for ${name} yet.` });
        }

        const { gear, details } = mapCombatantGearToSlots(p.combatantInfo && p.combatantInfo.gear);
        if (!gear || !Object.keys(gear).length) {
          return res.status(400).json({ error: `No gear data is available for ${name} in that report.` });
        }

        resolved.push({ name: p.name, className, specKey, gear, details });
      }

      const jobId = `loot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        status: "running",
        startedAt: Date.now(),
        done: 0,
        total: resolved.length,
        currentName: resolved[0] ? resolved[0].name : null,
        item: summariseItem(item),
        mode: modeKey,
        phase: phaseKey,
        results: null,
        error: null,
      };
      lootJobs.set(jobId, job);

      console.log(
        `Loot check for ${item.name} (${item.id}) - ${resolved.length} candidate(s), ` +
        `${phaseKey}, ${modeKey}: ${resolved.map((r) => `${r.name}/${r.specKey}`).join(", ")}`
      );

      // Fire and forget; the client polls. Sequential inside runLootCheck,
      // which is correct on one core - wowsimtbc has no cancellation, so
      // overlapping sims only halve throughput.
      runLootCheck({
        item,
        candidates: resolved,
        ctx: { reportCode, fightId, phase: phaseKey, mode: modeKey },
        resolveTarget: makeResolveTarget(phaseKey),
        onProgress: ({ done, total, currentName }) => {
          job.done = done;
          job.total = total;
          job.currentName = currentName;
        },
      })
        .then((results) => {
          job.results = results;
          job.status = "done";
          job.currentName = null;
        })
        .catch((err) => {
          job.status = "error";
          job.error = String(err.message || err);
          console.error("Loot check failed:", err);
        });

      res.json({ jobId, fightId, item: job.item, mode: modeKey, total: resolved.length });
    } catch (err) {
      console.error(err);
      res.status(err.status || 502).json({ error: err.status ? err.message : "Could not start the loot check." });
    }
  });

  app.get("/api/loot-check/:jobId", (req, res) => {
    const job = lootJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "That loot check has expired. Run it again." });
    res.set("Cache-Control", "no-store");
    res.json({
      status: job.status,
      done: job.done,
      total: job.total,
      currentName: job.currentName,
      item: job.item,
      mode: job.mode,
      phase: job.phase,
      results: job.results,
      error: job.error,
    });
  });
}

module.exports = { registerLootRoutes, specKeyFromWcl };
