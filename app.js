"use strict";

/* ================================================================
   CONFIGURATION
   ================================================================
   Point this at your deployed Cloudflare Worker once it exists.
   Until then the app runs in demo mode using sample data so the
   full flow (fetch -> compare -> results) can be exercised.
   Expected Worker endpoints (see cloudflare-worker/worker.js):
     GET  {WORKER_URL}/api/character?name=&reportCode=&fightId=
     POST {WORKER_URL}/api/items   (body: { itemIds: [...] })
   ================================================================ */
const WORKER_URL = "https://wcgear.lambertdaniel26.workers.dev";

/* Class -> allowed specs. Config-driven per section 44 of the spec,
   so post-MVP class-aware filtering only needs this table extended. */
const CLASS_SPEC_MAP = {
  Warrior: [
    { value: "arms_warrior", label: "Arms Warrior" },
    // Fury / Protection intentionally omitted — out of MVP scope.
  ],
  Warlock: [
    { value: "destruction_warlock", label: "Destruction Warlock" },
  ],
  Hunter: [
    { value: "beast_mastery_hunter", label: "Beast Mastery Hunter" },
  ],
};

/* Every spec option available in the MVP, independent of detected class.
   The user's selection always drives comparison — see spec section 7. */
const ALL_SPECS = [
  { value: "arms_warrior", label: "Arms Warrior", cls: "Warrior" },
  { value: "destruction_warlock", label: "Destruction Warlock", cls: "Warlock" },
  { value: "beast_mastery_hunter", label: "Beast Mastery Hunter", cls: "Hunter" },
];

const CLASS_COLOR_VAR = {
  Warrior: "--class-warrior",
  Warlock: "--class-warlock",
  Hunter: "--class-hunter",
};

/* Slots that only ever hold one item. */
const SINGLE_SLOTS = [
  ["head", "Head"], ["neck", "Neck"], ["shoulder", "Shoulder"], ["back", "Back"],
  ["chest", "Chest"], ["wrist", "Wrist"], ["hands", "Hands"], ["waist", "Waist"],
  ["legs", "Legs"], ["feet", "Feet"], ["ranged", "Ranged"],
];

/* Slots that can hold more than one identical item — handled by the
   reusable multi-slot ranking system (section 19). */
const MULTI_SLOTS = [
  ["trinket", "Trinket", 2],
  ["finger", "Finger", 2],
];

/* ================================================================
   STATE
   ================================================================ */
const state = {
  reportCode: null,   // resolved from the pasted report URL
  fightId: null,       // resolved fight (either from URL or "most recent")
  roster: null,         // [{ name, class, spec }, ...] from /api/roster
  character: null,       // { name, class, realmSpec, reportCode }
  gear: null,              // { slot: [itemId, ...], weaponConfig: "..." }
  bisData: null,            // loaded once from data/bis.json
};

/* ================================================================
   DOM
   ================================================================ */
const $ = (id) => document.getElementById(id);

const els = {
  reportForm: $("reportForm"),
  reportUrlInput: $("reportUrl"),
  loadReportBtn: $("loadReportBtn"),
  charSelectForm: $("charSelectForm"),
  charSelect: $("charSelect"),
  fetchBtn: $("fetchBtn"),
  changeReportBtn: $("changeReportBtn"),
  fetchError: $("fetchError"),
  demoNote: $("demoNote"),

  charPanel: $("charPanel"),
  charHeading: $("charHeading"),
  charClassPill: $("charClassPill"),
  charSpec: $("charSpec"),
  charRaid: $("charRaid"),
  charReportOut: $("charReportOut"),
  charBestPerf: $("charBestPerf"),
  charMedPerf: $("charMedPerf"),
  charGearStatus: $("charGearStatus"),
  refetchBtn: $("refetchBtn"),

  comparePanel: $("comparePanel"),
  compareForm: $("compareForm"),
  phaseSelect: $("phaseSelect"),
  specSelect: $("specSelect"),
  specWarning: $("specWarning"),
  specUnsupportedNote: $("specUnsupportedNote"),
  checkBtn: $("checkBtn"),

  resultsPanel: $("resultsPanel"),
  resultsSummary: $("resultsSummary"),
  resultsPerf: $("resultsPerf"),
  weaponResults: $("weaponResults"),
  armorResults: $("armorResults"),

  loadedEmptyState: $("loadedEmptyState"),
};

/* ================================================================
   INIT
   ================================================================ */
async function init() {
  if (!WORKER_URL) els.demoNote.hidden = false;

  try {
    const res = await fetch("bis.json");
    state.bisData = await res.json();
  } catch (err) {
    console.error("Failed to load BiS data", err);
  }

  els.reportForm.addEventListener("submit", onLoadReport);
  els.charSelectForm.addEventListener("submit", onFetchCharacter);
  els.changeReportBtn.addEventListener("click", resetToFetch);
  els.refetchBtn.addEventListener("click", resetToFetch);
  els.compareForm.addEventListener("submit", onCheckGear);
}

/* ================================================================
   STEP 1a — LOAD REPORT ROSTER
   ================================================================ */
async function onLoadReport(evt) {
  evt.preventDefault();
  hideError();

  const reportUrlRaw = els.reportUrlInput.value.trim();
  if (!reportUrlRaw) return;

  const parsed = parseReportUrl(reportUrlRaw);
  if (!parsed) {
    showError("That doesn't look like a Warcraft Logs report URL. It should look like https://fresh.warcraftlogs.com/reports/AbC123XyZ");
    return;
  }

  setLoadReportLoading(true);
  try {
    const { fightId, roster } = WORKER_URL
      ? await fetchRosterFromWorker(parsed)
      : await fetchRosterDemo(parsed);

    if (roster.length === 0) {
      showError("No characters were found in that report.");
      return;
    }

    state.reportCode = parsed.reportCode;
    state.fightId = fightId;
    state.roster = roster;

    populateCharSelect(roster);
    els.reportForm.hidden = true;
    els.charSelectForm.hidden = false;
  } catch (err) {
    showError(err.message || "We couldn't load that report. Please try again.");
  } finally {
    setLoadReportLoading(false);
  }
}

function populateCharSelect(roster) {
  els.charSelect.innerHTML = "";
  roster.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.spec ? `${p.name} — ${p.spec} ${p.class}` : `${p.name} — ${p.class}`;
    els.charSelect.appendChild(opt);
  });
}

/* ================================================================
   STEP 1b — FETCH SELECTED CHARACTER'S GEAR
   ================================================================ */
async function onFetchCharacter(evt) {
  evt.preventDefault();
  hideError();

  const name = els.charSelect.value;
  if (!name) return;

  setFetchLoading(true);
  try {
    const { character, gear } = WORKER_URL
      ? await fetchCharacterFromWorker(name, { reportCode: state.reportCode, fightId: state.fightId })
      : await fetchCharacterDemo(name, { reportCode: state.reportCode, fightId: state.fightId });

    state.character = character;
    state.gear = gear;
    renderCharacter();
    els.comparePanel.hidden = false;
    els.loadedEmptyState.hidden = false;
    els.resultsPanel.hidden = true;
    els.comparePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(err.message || "We couldn't retrieve this character. Please try again.");
  } finally {
    setFetchLoading(false);
  }
}

function resetToFetch() {
  state.reportCode = null;
  state.fightId = null;
  state.roster = null;
  state.character = null;
  state.gear = null;
  els.charPanel.hidden = true;
  els.comparePanel.hidden = true;
  els.resultsPanel.hidden = true;
  els.loadedEmptyState.hidden = true;
  els.charSelectForm.hidden = true;
  els.reportForm.hidden = false;
  els.charSelect.innerHTML = "";
  els.specWarning.hidden = true;
  els.specUnsupportedNote.hidden = true;
  hideError();
  $("reportForm").reset();
  $("compareForm").reset();
  els.reportForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Pulls the report code and, if present, the specific fight ID out of
 *  a pasted Warcraft Logs URL. Works with or without a fight= param —
 *  if no fight is specified, the Worker defaults to the most recent
 *  fight in the report. */
function parseReportUrl(raw) {
  const codeMatch = raw.match(/\/reports\/([a-zA-Z0-9]+)/);
  if (!codeMatch) return null;
  const fightMatch = raw.match(/[?#&]fight=(\d+)/);
  return {
    reportCode: codeMatch[1],
    fightId: fightMatch ? fightMatch[1] : null,
  };
}

/** Calls the Worker's /api/roster endpoint to list every character
 *  logged in the report/fight. */
async function fetchRosterFromWorker(parsed) {
  const params = new URLSearchParams({ reportCode: parsed.reportCode });
  if (parsed.fightId) params.set("fightId", parsed.fightId);
  const url = `${WORKER_URL}/api/roster?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new Error("That report doesn't have any readable fights. Check the URL and try again.");
  }
  if (!res.ok) {
    throw new Error("We couldn't load that report. Please try again.");
  }

  const data = await res.json();
  return { fightId: data.fightId, roster: data.roster || [] };
}

/** Demo-mode roster so the UI can be exercised end to end before a
 *  Worker is deployed. Swap WORKER_URL above to go live. */
async function fetchRosterDemo(parsed) {
  await sleep(500);
  return {
    fightId: parsed.fightId || "12",
    roster: [
      { name: "Kalium", class: "Warrior", spec: "Arms" },
      { name: "Thrall", class: "Shaman", spec: "Enhancement" },
      { name: "Drexion", class: "Warlock", spec: "Destruction" },
    ],
  };
}

/** Calls the Cloudflare Worker, which owns Warcraft Logs OAuth and
 *  never exposes client credentials to this frontend (spec section 10). */
async function fetchCharacterFromWorker(name, resolved) {
  const params = new URLSearchParams({ name, reportCode: resolved.reportCode, fightId: resolved.fightId });
  const url = `${WORKER_URL}/api/character?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new Error("Character not found in that report. Check the character name and report URL.");
  }
  if (!res.ok) {
    throw new Error("We couldn't retrieve this character. Please try again.");
  }

  const data = await res.json();
  if (!data.gear || Object.keys(data.gear).length === 0) {
    throw new Error("No gear data is available for this character in that report.");
  }

  return {
    character: {
      name: data.name,
      class: data.class,
      realmSpec: data.spec || "Unknown",
      reportCode: resolved.reportCode,
      zoneName: data.zoneName || null,
      bestPerfAvg: data.bestPerfAvg ?? null, // null -> "Unavailable" (requirement 3.3)
      medPerfAvg: data.medPerfAvg ?? null,
    },
    gear: data.gear, // expected shape: { slot: [itemId,...], weaponConfig }
  };
}

/** Demo-mode sample response so the UI can be exercised end to end
 *  before a Worker is deployed. Swap WORKER_URL above to go live. */
async function fetchCharacterDemo(name, resolved) {
  await sleep(650);

  if (name.trim().toLowerCase() === "notfound") {
    throw new Error("Character not found in that report. Check the character name and report URL.");
  }

  return {
    character: {
      name,
      class: "Warrior",
      realmSpec: "Arms",
      reportCode: resolved.reportCode,
      zoneName: "Black Temple",
      bestPerfAvg: 87.3, // demo-only sample values so the UI can be previewed pre-Worker
      medPerfAvg: 61.5,
    },
    gear: {
      weaponConfig: "twohand",
      twohand: [30318],          // Sample: Sulfuras-tier placeholder ID
      head: [29757],
      neck: [28753],
      shoulder: [30096],
      back: [28770],
      chest: [30180],
      wrist: [28829],
      hands: [30186],
      waist: [29774],
      legs: [30183],
      feet: [28727],
      ranged: [28772],
      trinket: [28830, 29383],   // one BiS-ranked, one off-list, per sample data
      finger: [29283, 28753],
    },
  };
}

/* ================================================================
   RENDER — CHARACTER
   ================================================================ */
function renderCharacter() {
  const c = state.character;
  els.charHeading.textContent = c.name;
  els.charClassPill.textContent = c.class;
  const colorVar = CLASS_COLOR_VAR[c.class];
  els.charClassPill.style.color = colorVar ? `var(${colorVar})` : "var(--text-parchment)";
  els.charSpec.textContent = c.realmSpec;
  els.charRaid.textContent = c.zoneName || "Unknown";
  els.charReportOut.innerHTML = `<a href="https://fresh.warcraftlogs.com/reports/${escapeHtml(c.reportCode)}" target="_blank" rel="noopener">${escapeHtml(c.reportCode)}</a>`;
  els.charBestPerf.innerHTML = formatPerf(c.bestPerfAvg);
  els.charMedPerf.innerHTML = formatPerf(c.medPerfAvg);
  els.charGearStatus.textContent = "Successfully loaded";
  els.charPanel.hidden = false;

  populateSpecOptions(c.class);
}

/** Best/Median Performance Average tiering, matching Warcraft Logs'
 *  own color convention: 90+ green, 75-89 blue-ish, 50-74 purple,
 *  below that gray. "Unavailable" per requirement 3.3 when unknown. */
function formatPerf(value) {
  if (value == null) return `<span class="perf-tier-low">Unavailable</span>`;
  const tier = value >= 90 ? "great" : value >= 75 ? "good" : value >= 50 ? "ok" : "low";
  return `<span class="perf-tier-${tier}">${value.toFixed(1)}</span>`;
}

/** Show every MVP spec, but mark the ones matching the detected class —
 *  the dropdown itself isn't filtered yet (that's post-MVP, section 44),
 *  it just gives a visual hint. */
/** Populates the spec dropdown with ONLY the specs valid for the
 *  detected class (requirement 2.1 — this previously showed every
 *  spec and just decorated the matching one with a checkmark, which
 *  meant invalid cross-class specs were still selectable). If the
 *  detected class isn't one this tool supports yet, the compare form
 *  is disabled with an explanatory message instead of showing
 *  unrelated specs. */
function populateSpecOptions(detectedClass) {
  const validSpecs = CLASS_SPEC_MAP[detectedClass];
  els.specSelect.innerHTML = "";

  if (!validSpecs || validSpecs.length === 0) {
    els.specSelect.disabled = true;
    els.checkBtn.disabled = true;
    els.specUnsupportedNote.textContent = `This tool doesn't have Best-in-Slot data for ${detectedClass || "this class"} yet — only Arms Warrior, Destruction Warlock, and Beast Mastery Hunter are currently supported.`;
    els.specUnsupportedNote.hidden = false;
    return;
  }

  els.specSelect.disabled = false;
  els.checkBtn.disabled = false;
  els.specUnsupportedNote.hidden = true;
  validSpecs.forEach((spec) => {
    const opt = document.createElement("option");
    opt.value = spec.value;
    opt.textContent = spec.label;
    els.specSelect.appendChild(opt);
  });
}

/* ================================================================
   STEP 2 — CHECK GEAR
   ================================================================ */
async function onCheckGear(evt) {
  evt.preventDefault();
  if (els.specSelect.disabled) return; // unsupported class — nothing valid to compare
  const phase = els.phaseSelect.value;
  const specValue = els.specSelect.value;
  const specMeta = ALL_SPECS.find((s) => s.value === specValue);

  renderSpecWarning(specMeta);

  const bisSet = state.bisData?.[phase]?.[specValue];
  if (!bisSet) {
    showError(`No BiS data is available yet for ${specMeta.label} in ${phaseLabel(phase)}.`);
    return;
  }

  const results = runComparison(state.gear, bisSet);
  const itemIds = collectItemIds(results);
  const enrichment = await fetchItemEnrichment(itemIds);

  renderResults(results, phase, specMeta, enrichment);
  els.loadedEmptyState.hidden = true;
  els.resultsPanel.hidden = false;
  els.resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Every equipped/recommended item ID referenced across the results, deduped. */
function collectItemIds(results) {
  const ids = new Set();
  [...results.weapons, ...results.armor].forEach((r) => {
    if (r.equippedId != null) ids.add(r.equippedId);
    if (r.recommendedId != null) ids.add(r.recommendedId);
  });
  return [...ids];
}

/** Calls the Worker's /api/items endpoint for name/icon/quality.
 *  Sent in small batches: Cloudflare Workers cap total subrequests per
 *  invocation, and a full comparison can reference 30+ unique items
 *  (equipped + every recommended BiS piece), which blew past that
 *  ceiling as one request. Returns {} (safe no-op) in demo mode or on
 *  failure, so the UI just falls back to showing item IDs. */
async function fetchItemEnrichment(itemIds) {
  if (!WORKER_URL || itemIds.length === 0) return {};

  const BATCH_SIZE = 12;
  const batches = [];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    batches.push(itemIds.slice(i, i + BATCH_SIZE));
  }

  const merged = {};
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(`${WORKER_URL}/api/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds: batch, region: "us" }), // item static data barely varies by region
        });
        if (!res.ok) return;
        const data = await res.json();
        Object.assign(merged, data.items || {});
      } catch (err) {
        console.error("Item enrichment batch failed", err);
      }
    })
  );

  return merged;
}

function renderSpecWarning(specMeta) {
  const detected = state.character.realmSpec;
  const detectedFullName = `${detected} ${state.character.class}`;
  if (detected && detected !== "Unknown" && !specMeta.label.toLowerCase().includes(detected.toLowerCase())) {
    els.specWarning.textContent = `Warcraft Logs reports this character as ${detectedFullName}. You selected ${specMeta.label}. The comparison below still uses your selection.`;
    els.specWarning.hidden = false;
  } else {
    els.specWarning.hidden = true;
  }
}

function phaseLabel(phaseKey) {
  return phaseKey === "phase3" ? "Phase 3" : phaseKey === "phase4" ? "Phase 4" : phaseKey;
}

/* ================================================================
   COMPARISON ENGINE
   ================================================================
   Operates entirely on gear already retrieved during Fetch Character
   (section 17) and on the BiS dataset for the selected phase+spec.
   Single-slot and multi-slot categories both flow through the same
   reusable ranking function — section 19 requires this not be
   hardcoded per-category logic.
   ================================================================ */
function runComparison(gear, bisSet) {
  const results = { weapons: [], armor: [] };

  // --- weapons: always show all three rows, regardless of what's
  // actually equipped (requirement 5.1). A player's unused weapon
  // config just shows "Empty" vs. the BiS recommendation for it —
  // useful context if they're considering a build switch.
  results.weapons.push(compareSingleSlot("Two-Hand", gear.twohand, bisSet.twohand));
  results.weapons.push(compareSingleSlot("Main Hand", gear.mainhand, bisSet.mainhand));
  results.weapons.push(compareSingleSlot("Off Hand", gear.offhand, bisSet.offhand));

  // --- single-item armor/accessory slots ---
  SINGLE_SLOTS.forEach(([key, label]) => {
    if (!bisSet[key]) return; // slot not tracked for this spec
    results.armor.push(compareSingleSlot(label, gear[key], bisSet[key]));
  });

  // --- multi-slot categories (trinket, finger) via reusable ranking ---
  MULTI_SLOTS.forEach(([key, label, count]) => {
    if (!bisSet[key]) return;
    const positions = resolveMultiSlot(gear[key] || [], bisSet[key], count);
    positions.forEach((pos, i) => {
      results.armor.push({
        label: `${label} ${i + 1}`,
        ...pos,
      });
    });
  });

  return results;
}

/** Looks up an item's drop source from a ranked BiS list. Only items
 *  that appear on the curated BiS list have a known source — an
 *  equipped item that isn't BiS-listed (random off-list gear) simply
 *  won't have one, which is expected (requirement 5.4). */
function findSource(itemId, bisRanked) {
  if (itemId == null || !bisRanked) return null;
  return bisRanked.find((b) => b.itemId === itemId)?.source ?? null;
}

/** Compares a single-item slot (0 or 1 equipped item) against a
 *  ranked BiS list for that slot (rank 1 = best). Carries the full
 *  ranked list through as `alternatives` so the UI can expose every
 *  ranked option, not just the top pick (requirement 5.2/5.5). */
function compareSingleSlot(label, equippedIds, bisRanked) {
  const equippedId = equippedIds?.[0] ?? null;

  if (!bisRanked || bisRanked.length === 0) {
    return {
      label,
      state: "unknown",
      equippedId,
      recommendedId: null,
      alternatives: [],
      note: `The BiS list for this phase and spec doesn't include a ${label.toLowerCase()} recommendation yet.`,
    };
  }

  const best = bisRanked[0];

  if (equippedId != null && bisRanked.some((b) => b.itemId === equippedId)) {
    return {
      label, state: "bis", equippedId, recommendedId: equippedId,
      equippedSource: findSource(equippedId, bisRanked),
      recommendedSource: findSource(equippedId, bisRanked),
      alternatives: bisRanked,
    };
  }
  return {
    label, state: "upgrade", equippedId, recommendedId: best.itemId,
    equippedSource: findSource(equippedId, bisRanked),
    recommendedSource: findSource(best.itemId, bisRanked),
    alternatives: bisRanked,
  };
}

/**
 * Generic multi-slot ranking system (section 19).
 * Given the items currently equipped in a category and a ranked BiS
 * list, assigns each equipped BiS item to its own position (best rank
 * first), then fills any remaining positions with the next-highest
 * ranked BiS items the character doesn't already own — never
 * recommending a duplicate of something already equipped.
 *
 * @param {number[]} equippedIds   items currently in the slot category
 * @param {{itemId:number, rank:number}[]} bisRanked   sorted ascending by rank
 * @param {number} slotCount   number of identical slots (e.g. 2 for trinkets)
 * @returns {{state:string, equippedId:number|null, recommendedId:number|null}[]}
 */
function resolveMultiSlot(equippedIds, bisRanked, slotCount) {
  const ranked = [...bisRanked].sort((a, b) => a.rank - b.rank);
  const rankOf = new Map(ranked.map((b) => [b.itemId, b.rank]));
  const ownedSet = new Set(equippedIds);

  // Which equipped items are themselves on the BiS list, best rank first —
  // each seats its own position and can never be displaced by a duplicate
  // recommendation (section 19's duplicate-prevention requirement).
  const equippedBis = equippedIds
    .filter((id) => rankOf.has(id))
    .sort((a, b) => rankOf.get(a) - rankOf.get(b));

  // Non-BiS equipped items — shown paired with an upgrade suggestion
  // where a remaining position needs to display "what's worn now".
  const equippedNonBis = [...equippedIds.filter((id) => !rankOf.has(id))];

  // Candidates for remaining positions: ranked BiS items not already owned.
  const availableCandidates = ranked.filter((b) => !ownedSet.has(b.itemId));

  const positions = equippedBis.map((id) => ({
    state: "bis", equippedId: id, recommendedId: id,
    equippedSource: findSource(id, ranked), recommendedSource: findSource(id, ranked),
    alternatives: ranked,
  }));

  const remainingSlots = slotCount - positions.length;
  let candidateIndex = 0;
  for (let i = 0; i < remainingSlots; i++) {
    const equippedForThis = equippedNonBis.shift() ?? null;
    const candidate = availableCandidates[candidateIndex];
    if (candidate) {
      candidateIndex++;
      positions.push({
        state: "upgrade", equippedId: equippedForThis, recommendedId: candidate.itemId,
        equippedSource: findSource(equippedForThis, ranked), recommendedSource: findSource(candidate.itemId, ranked),
        alternatives: ranked,
      });
    } else {
      positions.push({ state: "unknown", equippedId: equippedForThis, recommendedId: null, alternatives: ranked });
    }
  }

  return positions;
}

/* ================================================================
   RENDER — RESULTS
   ================================================================ */
function renderResults(results, phase, specMeta, enrichment) {
  const all = [...results.weapons, ...results.armor];
  const tally = { bis: 0, upgrade: 0, unknown: 0 };
  all.forEach((r) => tally[r.state]++);

  els.resultsPerf.innerHTML = `
    <span class="perf-badge"><span class="perf-label">Best Perf Avg</span> ${formatPerf(state.character?.bestPerfAvg)}</span>
    <span class="perf-badge"><span class="perf-label">Median Perf Avg</span> ${formatPerf(state.character?.medPerfAvg)}</span>
  `;

  els.resultsSummary.innerHTML = `
    <span class="tally-bis">${tally.bis} BiS</span>
    <span class="tally-upgrade">${tally.upgrade} Upgrade</span>
    <span class="tally-unknown">${tally.unknown} Unable to Check</span>
  `;

  els.weaponResults.innerHTML = "";
  results.weapons.forEach((r) => els.weaponResults.appendChild(renderSlotCard(r, enrichment)));

  els.armorResults.innerHTML = "";
  results.armor.forEach((r) => els.armorResults.appendChild(renderSlotCard(r, enrichment)));
}

const STATE_META = {
  bis: { badge: "BiS", cls: "state-bis" },
  upgrade: { badge: "Upgrade", cls: "state-upgrade" },
  unknown: { badge: "Unable to Check", cls: "state-unknown" },
};

function renderSlotCard(result, enrichment) {
  const meta = STATE_META[result.state];
  const card = document.createElement("div");
  card.className = `slot-card ${meta.cls}`;

  const showArrow = result.state === "upgrade" && result.recommendedId;
  const alternatives = result.alternatives || [];

  card.innerHTML = `
    <div class="slot-card-head">
      <span class="slot-name">${escapeHtml(result.label)}</span>
      <span class="slot-state-badge"><span class="dot"></span>${meta.badge}</span>
    </div>
    <div class="result-icon-flow">
      ${renderItemChip(result.equippedId, result.state === "bis" ? "Equipped — matches BiS" : "Currently equipped", enrichment, result.equippedSource)}
      ${showArrow ? `<span class="flow-arrow">→</span>${renderItemChip(result.recommendedId, "Recommended", enrichment, result.recommendedSource)}` : ""}
    </div>
    ${result.state === "unknown" ? `<div class="slot-note">${escapeHtml(result.note || "Not enough reliable data to evaluate this slot yet.")}</div>` : ""}
    ${renderAlternatives(alternatives, enrichment)}
  `;
  return card;
}

/** Every ranked BiS option for this slot (requirement 5.2/5.5) —
 *  id, rank, name, and drop source — collapsed behind a toggle so the
 *  primary equipped/recommended row stays the focus. */
function renderAlternatives(alternatives, enrichment) {
  if (!alternatives || alternatives.length === 0) return "";
  const rows = alternatives
    .map((alt) => {
      const info = enrichment?.[alt.itemId];
      const name = info?.name || alt.name || `Item ${alt.itemId}`;
      const source = alt.source ? `<span class="alt-source">${escapeHtml(alt.source)}</span>` : "";
      return `<div class="alt-row"><span class="alt-rank">#${alt.rank}</span><span class="alt-name">${escapeHtml(name)}</span>${source}</div>`;
    })
    .join("");
  return `
    <details class="slot-alternatives">
      <summary>All ranked BiS options (${alternatives.length})</summary>
      <div class="alt-list">${rows}</div>
    </details>`;
}

function renderItemChip(itemId, sourceLabel, enrichment, dropSource) {
  if (itemId == null) {
    return `
      <div class="item-chip">
        <div class="item-icon placeholder">—</div>
        <div class="item-text">
          <div class="item-name">Empty</div>
          <div class="item-source">${escapeHtml(sourceLabel)}</div>
        </div>
      </div>`;
  }

  const info = enrichment?.[itemId];
  const iconMarkup = info?.icon
    ? `<img class="item-icon" src="${escapeHtml(info.icon)}" alt="" loading="lazy">`
    : `<div class="item-icon placeholder">#</div>`;
  const nameText = info?.name ? escapeHtml(info.name) : `Item ${itemId}`;
  const dropSourceMarkup = dropSource ? `<div class="item-drop-source">${escapeHtml(dropSource)}</div>` : "";

  return `
    <div class="item-chip">
      ${iconMarkup}
      <div class="item-text">
        <div class="item-name">${nameText}</div>
        <div class="item-source">${escapeHtml(sourceLabel)}</div>
        ${dropSourceMarkup}
      </div>
    </div>`;
}

/* ================================================================
   HELPERS
   ================================================================ */
/** Buttons disable during processing but stay visually static —
 *  no spinner/animated indicator, per UI requirement 1.1. */
function setFetchLoading(loading) {
  els.fetchBtn.disabled = loading;
  els.fetchBtn.querySelector(".btn-label").textContent = loading ? "Summoning…" : "Fetch Character";
}

function setLoadReportLoading(loading) {
  els.loadReportBtn.disabled = loading;
  els.loadReportBtn.querySelector(".btn-label").textContent = loading ? "Loading…" : "Load Report";
}

function showError(msg) {
  els.fetchError.textContent = msg;
  els.fetchError.hidden = false;
}
function hideError() {
  els.fetchError.hidden = true;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

document.addEventListener("DOMContentLoaded", init);
