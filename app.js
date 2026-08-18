"use strict";

/* ================================================================
   CONFIGURATION
   ================================================================
   Point this at your deployed Cloudflare Worker once it exists.
   Until then the app runs in demo mode using sample data so the
   full flow (fetch -> compare -> results) can be exercised.
   Expected Worker endpoints (see cloudflare-worker/worker.js):
     GET  {WORKER_URL}/api/character?name=&realm=&region=
     POST {WORKER_URL}/api/items   (body: { itemIds: [...] })
   ================================================================ */
const WORKER_URL = ""; // e.g. "https://wow-gear-check.yourname.workers.dev"

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
  character: null,   // { name, class, realmSpec, realm, region }
  gear: null,         // { slot: [itemId, ...], weaponConfig: "..." }
  bisData: null,       // loaded once from data/bis.json
};

/* ================================================================
   DOM
   ================================================================ */
const $ = (id) => document.getElementById(id);

const els = {
  fetchForm: $("fetchForm"),
  fetchBtn: $("fetchBtn"),
  fetchError: $("fetchError"),
  demoNote: $("demoNote"),

  charPanel: $("charPanel"),
  charHeading: $("charHeading"),
  charClassPill: $("charClassPill"),
  charSpec: $("charSpec"),
  charRealmOut: $("charRealmOut"),
  charRegionOut: $("charRegionOut"),
  charGearStatus: $("charGearStatus"),
  refetchBtn: $("refetchBtn"),

  comparePanel: $("comparePanel"),
  compareForm: $("compareForm"),
  phaseSelect: $("phaseSelect"),
  specSelect: $("specSelect"),
  specWarning: $("specWarning"),
  checkBtn: $("checkBtn"),

  resultsPanel: $("resultsPanel"),
  resultsSummary: $("resultsSummary"),
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
    const res = await fetch("data/bis.json");
    state.bisData = await res.json();
  } catch (err) {
    console.error("Failed to load BiS data", err);
  }

  els.fetchForm.addEventListener("submit", onFetchCharacter);
  els.refetchBtn.addEventListener("click", resetToFetch);
  els.compareForm.addEventListener("submit", onCheckGear);
}

/* ================================================================
   STEP 1 — FETCH CHARACTER
   ================================================================ */
async function onFetchCharacter(evt) {
  evt.preventDefault();
  hideError();

  const name = $("charName").value.trim();
  const realmRaw = $("charRealm").value.trim();
  const region = $("charRegion").value;
  const realm = normalizeRealm(realmRaw);

  if (!name || !realm) return;

  setFetchLoading(true);
  try {
    const { character, gear } = WORKER_URL
      ? await fetchCharacterFromWorker(name, realm, region)
      : await fetchCharacterDemo(name, realm, region);

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
  state.character = null;
  state.gear = null;
  els.charPanel.hidden = true;
  els.comparePanel.hidden = true;
  els.resultsPanel.hidden = true;
  els.loadedEmptyState.hidden = true;
  $("fetchForm").reset();
  els.fetchForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Realm normalization per section 31: trim, collapse whitespace,
 *  standardize apostrophes/hyphens, title-case each word. */
function normalizeRealm(raw) {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .split(/(\s|-|')/)
    .map((piece) => {
      if (/^\s|-|'$/.test(piece) || piece === " " || piece === "-" || piece === "'") return piece;
      return piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase();
    })
    .join("");
}

/** Calls the Cloudflare Worker, which owns Warcraft Logs OAuth and
 *  never exposes client credentials to this frontend (spec section 10). */
async function fetchCharacterFromWorker(name, realm, region) {
  const url = `${WORKER_URL}/api/character?name=${encodeURIComponent(name)}&realm=${encodeURIComponent(realm)}&region=${encodeURIComponent(region)}`;
  const res = await fetch(url);

  if (res.status === 404) {
    throw new Error("Character not found. Check the character name, realm, and region.");
  }
  if (!res.ok) {
    throw new Error("We couldn't retrieve this character. Please try again.");
  }

  const data = await res.json();
  if (!data.gear || Object.keys(data.gear).length === 0) {
    throw new Error("No Warcraft Logs gear data is available for this character.");
  }

  return {
    character: {
      name: data.name,
      class: data.class,
      realmSpec: data.spec || "Unknown",
      realm,
      region,
    },
    gear: data.gear, // expected shape: { slot: [itemId,...], weaponConfig }
  };
}

/** Demo-mode sample response so the UI can be exercised end to end
 *  before a Worker is deployed. Swap WORKER_URL above to go live. */
async function fetchCharacterDemo(name, realm, region) {
  await sleep(650);

  if (name.trim().toLowerCase() === "notfound") {
    throw new Error("Character not found. Check the character name, realm, and region.");
  }

  return {
    character: {
      name,
      class: "Warrior",
      realmSpec: "Arms",
      realm,
      region,
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
  els.charRealmOut.textContent = c.realm;
  els.charRegionOut.textContent = c.region;
  els.charGearStatus.textContent = "Successfully loaded";
  els.charPanel.hidden = false;

  populateSpecOptions(c.class);
}

/** Show every MVP spec, but mark the ones matching the detected class —
 *  the dropdown itself isn't filtered yet (that's post-MVP, section 44),
 *  it just gives a visual hint. */
function populateSpecOptions(detectedClass) {
  els.specSelect.innerHTML = "";
  ALL_SPECS.forEach((spec) => {
    const opt = document.createElement("option");
    opt.value = spec.value;
    opt.textContent = spec.cls === detectedClass ? `${spec.label} ✓` : spec.label;
    els.specSelect.appendChild(opt);
  });
}

/* ================================================================
   STEP 2 — CHECK GEAR
   ================================================================ */
function onCheckGear(evt) {
  evt.preventDefault();
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
  renderResults(results, phase, specMeta);
  els.loadedEmptyState.hidden = true;
  els.resultsPanel.hidden = false;
  els.resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
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

  // --- weapons: simple display categories, section 22 ---
  const weaponConfig = bisSet.weaponConfig || gear.weaponConfig;
  if (weaponConfig === "twohand") {
    results.weapons.push(compareSingleSlot("Two-Hand", gear.twohand, bisSet.twohand));
  } else {
    results.weapons.push(compareSingleSlot("Main Hand", gear.mainhand, bisSet.mainhand));
    results.weapons.push(compareSingleSlot("Off Hand", gear.offhand, bisSet.offhand));
  }

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

/** Compares a single-item slot (0 or 1 equipped item) against a
 *  ranked BiS list for that slot (rank 1 = best). */
function compareSingleSlot(label, equippedIds, bisRanked) {
  if (!bisRanked || bisRanked.length === 0) {
    return { label, state: "unknown", equippedId: equippedIds?.[0] ?? null, recommendedId: null, note: "No BiS entry configured for this slot." };
  }
  const equippedId = equippedIds?.[0] ?? null;
  const best = bisRanked[0];

  if (equippedId != null && bisRanked.some((b) => b.itemId === equippedId)) {
    return { label, state: "bis", equippedId, recommendedId: equippedId };
  }
  return { label, state: "upgrade", equippedId, recommendedId: best.itemId };
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

  const positions = equippedBis.map((id) => ({ state: "bis", equippedId: id, recommendedId: id }));

  const remainingSlots = slotCount - positions.length;
  let candidateIndex = 0;
  for (let i = 0; i < remainingSlots; i++) {
    const equippedForThis = equippedNonBis.shift() ?? null;
    const candidate = availableCandidates[candidateIndex];
    if (candidate) {
      candidateIndex++;
      positions.push({ state: "upgrade", equippedId: equippedForThis, recommendedId: candidate.itemId });
    } else {
      positions.push({ state: "unknown", equippedId: equippedForThis, recommendedId: null });
    }
  }

  return positions;
}

/* ================================================================
   RENDER — RESULTS
   ================================================================ */
function renderResults(results, phase, specMeta) {
  const all = [...results.weapons, ...results.armor];
  const tally = { bis: 0, upgrade: 0, unknown: 0 };
  all.forEach((r) => tally[r.state]++);

  els.resultsSummary.innerHTML = `
    <span class="tally-bis">${tally.bis} BiS</span>
    <span class="tally-upgrade">${tally.upgrade} Upgrade</span>
    <span class="tally-unknown">${tally.unknown} Unable to Check</span>
  `;

  els.weaponResults.innerHTML = "";
  results.weapons.forEach((r) => els.weaponResults.appendChild(renderSlotCard(r)));

  els.armorResults.innerHTML = "";
  results.armor.forEach((r) => els.armorResults.appendChild(renderSlotCard(r)));
}

const STATE_META = {
  bis: { badge: "BiS", cls: "state-bis" },
  upgrade: { badge: "Upgrade", cls: "state-upgrade" },
  unknown: { badge: "Unable to Check", cls: "state-unknown" },
};

function renderSlotCard(result) {
  const meta = STATE_META[result.state];
  const card = document.createElement("div");
  card.className = `slot-card ${meta.cls}`;

  const showArrow = result.state === "upgrade" && result.recommendedId;

  card.innerHTML = `
    <div class="slot-card-head">
      <span class="slot-name">${escapeHtml(result.label)}</span>
      <span class="slot-state-badge"><span class="dot"></span>${meta.badge}</span>
    </div>
    <div class="result-icon-flow">
      ${renderItemChip(result.equippedId, result.state === "bis" ? "Equipped — matches BiS" : "Currently equipped")}
      ${showArrow ? `<span class="flow-arrow">→</span>${renderItemChip(result.recommendedId, "Recommended")}` : ""}
    </div>
    ${result.state === "unknown" ? `<div class="slot-note">Not enough reliable data to evaluate this slot yet.</div>` : ""}
  `;
  return card;
}

function renderItemChip(itemId, sourceLabel) {
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
  // Name/icon/source enrichment comes from the Blizzard API via the
  // Worker (section 25). Until that's wired up, show the item ID —
  // the authoritative identifier per section 24.
  return `
    <div class="item-chip">
      <div class="item-icon placeholder">#</div>
      <div class="item-text">
        <div class="item-name">Item ${itemId}</div>
        <div class="item-source">${escapeHtml(sourceLabel)}</div>
      </div>
    </div>`;
}

/* ================================================================
   HELPERS
   ================================================================ */
function setFetchLoading(loading) {
  els.fetchBtn.disabled = loading;
  els.fetchBtn.querySelector(".btn-label").textContent = loading ? "Summoning…" : "Fetch Character";
  els.fetchBtn.querySelector(".btn-spinner").hidden = !loading;
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
