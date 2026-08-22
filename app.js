"use strict";

/* ================================================================
   CONFIGURATION
   ================================================================
   Two separate backends, split deliberately:

   WCL_API_URL — the Warcraft Logs–calling endpoints (roster,
   character/gear) AND the wowsimtbc simulation endpoint (/api/simulate),
   all hosted on a VPS with a real dedicated IP, since Cloudflare
   Workers share a small, heavily-used pool of egress IPs across every
   Workers customer, and Warcraft Logs' anti-abuse IP throttle was
   triggering off that shared traffic — not our own usage. The
   simulation endpoint lives here rather than on Workers because it
   needs to reach the wowsimtbc process running locally on the same
   VPS (localhost:3333), which only the VPS can do.

   ITEMS_API_URL — Blizzard item enrichment. Stayed on Cloudflare
   Workers unchanged; that API never showed the shared-IP problem.

   Expected endpoints:
     GET  {WCL_API_URL}/api/roster?reportCode=&fightId=
     GET  {WCL_API_URL}/api/character?name=&reportCode=&fightId=
     POST {WCL_API_URL}/api/simulate   (body: { name, reportCode, fightId })
     POST {ITEMS_API_URL}/api/items    (body: { itemIds: [...] })
   ================================================================ */
const WCL_API_URL = "https://bischeck.net";
const ITEMS_API_URL = "https://wcgear.lambertdaniel26.workers.dev";

/* Test Mode: add ?test=1 to the site URL to force the app onto fully
   static fixture data — no WCL or Blizzard requests at all, even
   though the URLs above are set. Built so UI/ranking-logic changes
   can be checked without burning WCL requests or waiting out rate
   limits. Never affects real users, since it only activates on an
   explicit URL flag nobody would stumble into by accident. */
const IS_TEST_MODE = new URLSearchParams(location.search).get("test") === "1";
const USE_LIVE_WORKER = Boolean(WCL_API_URL) && !IS_TEST_MODE;

/* Classes the wowsimtbc integration actually supports right now (see
   server.js's SIMULATABLE_CLASSES and sim.js's buildDestructionWarlockPlayer).
   Used as a client-side fallback for demo/test mode, where there's no
   server to report back the `simulatable` flag the live /api/character
   response includes. Extend alongside server.js as more specs are added. */
const SIMULATABLE_CLASSES = new Set(["Warlock"]);

/* Class -> allowed specs. Config-driven per section 44 of the spec,
   so post-MVP class-aware filtering only needs this table extended. */
const CLASS_SPEC_MAP = {
  Warrior: [
    { value: "arms_warrior", label: "Arms" },
    { value: "fury_warrior", label: "Fury" },
    { value: "protection_warrior", label: "Protection" },
  ],
  Warlock: [
    { value: "affliction_warlock", label: "Affliction" },
    { value: "demonology_warlock", label: "Demonology" },
    { value: "destruction_warlock", label: "Destruction" },
  ],
  Hunter: [
    { value: "beast_mastery_hunter", label: "Beast Mastery" },
    { value: "survival_hunter", label: "Survival" },
    { value: "marksmanship_hunter", label: "Marksmanship" },
  ],
  Paladin: [
    { value: "holy_paladin", label: "Holy" },
    { value: "protection_paladin", label: "Protection" },
    { value: "retribution_paladin", label: "Retribution" },
  ],
  Priest: [
    { value: "holy_priest", label: "Holy" },
    { value: "discipline_priest", label: "Discipline" },
    { value: "shadow_priest", label: "Shadow" },
  ],
  Shaman: [
    { value: "elemental_shaman", label: "Elemental" },
    { value: "enhancement_shaman", label: "Enhancement" },
    { value: "restoration_shaman", label: "Restoration" },
  ],
};

/* Every spec option across all supported classes, independent of
   detected class — used as a lookup table (label, class ownership)
   once a spec value is already selected. BiS data only currently
   exists for one spec per class; the others show a graceful
   "no data yet" message rather than being hidden (spec section 7). */
const ALL_SPECS = [
  { value: "arms_warrior", label: "Arms Warrior", cls: "Warrior" },
  { value: "fury_warrior", label: "Fury Warrior", cls: "Warrior" },
  { value: "protection_warrior", label: "Protection Warrior", cls: "Warrior" },
  { value: "affliction_warlock", label: "Affliction Warlock", cls: "Warlock" },
  { value: "demonology_warlock", label: "Demonology Warlock", cls: "Warlock" },
  { value: "destruction_warlock", label: "Destruction Warlock", cls: "Warlock" },
  { value: "beast_mastery_hunter", label: "Beast Mastery Hunter", cls: "Hunter" },
  { value: "survival_hunter", label: "Survival Hunter", cls: "Hunter" },
  { value: "marksmanship_hunter", label: "Marksmanship Hunter", cls: "Hunter" },
  { value: "holy_paladin", label: "Holy Paladin", cls: "Paladin" },
  { value: "protection_paladin", label: "Protection Paladin", cls: "Paladin" },
  { value: "retribution_paladin", label: "Retribution Paladin", cls: "Paladin" },
  { value: "holy_priest", label: "Holy Priest", cls: "Priest" },
  { value: "discipline_priest", label: "Discipline Priest", cls: "Priest" },
  { value: "shadow_priest", label: "Shadow Priest", cls: "Priest" },
  { value: "elemental_shaman", label: "Elemental Shaman", cls: "Shaman" },
  { value: "enhancement_shaman", label: "Enhancement Shaman", cls: "Shaman" },
  { value: "restoration_shaman", label: "Restoration Shaman", cls: "Shaman" },
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
  equippedItemDetails: null, // itemId -> { name, icon, quality, permanentEnchant, temporaryEnchant, gems }
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
  charRaidDate: $("charRaidDate"),
  charBestPerf: $("charBestPerf"),
  charMedPerf: $("charMedPerf"),
  refetchBtn: $("refetchBtn"),

  upgradePanel: $("upgradePanel"),
  upgradeBtn: $("upgradeBtn"),
  upgradePhaseSelect: $("upgradePhaseSelect"),
  upgradeStatus: $("upgradeStatus"),
  upgradeResults: $("upgradeResults"),

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
  if (!USE_LIVE_WORKER) {
    els.demoNote.innerHTML = IS_TEST_MODE
      ? "<strong>Test mode.</strong> Using static fixture data (deliberately spans every ranking scenario — 1st/2nd/3rd BiS, upgrades, empty weapon slots) so UI changes can be checked without hitting Warcraft Logs or Blizzard at all."
      : "<strong>Demo mode.</strong> No live Worker endpoint is configured yet, so this is showing sample gear so you can try the flow. Point the backend URLs in <code>app.js</code> at your deployed servers to go live.";
    els.demoNote.hidden = false;
  }

  try {
    const res = await fetch("bis.json");
    state.bisData = await res.json();
  } catch (err) {
    console.error("Failed to load BiS data", err);
  }

  els.reportForm.addEventListener("submit", onLoadReport);
  els.charSelectForm.addEventListener("submit", onFetchCharacter);
  els.changeReportBtn.addEventListener("click", onClearReportClick);
  els.refetchBtn.addEventListener("click", onClearReportClick);
  els.compareForm.addEventListener("submit", onCheckGear);
  els.upgradeBtn.addEventListener("click", onFindUpgrades);

  // The two phase controls are kept in lockstep on purpose. The sweep
  // simulates whatever the gear check recommends, so if they could drift
  // apart the panel would be reporting DPS for a different phase than the
  // cards below are showing.
  els.upgradePhaseSelect.addEventListener("change", () => {
    els.phaseSelect.value = els.upgradePhaseSelect.value;
    runAndRenderComparison({ scroll: false });
  });
  els.phaseSelect.addEventListener("change", () => {
    els.upgradePhaseSelect.value = els.phaseSelect.value;
  });
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
    const { fightId, roster } = USE_LIVE_WORKER
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
    const { character, gear, equippedItemDetails } = USE_LIVE_WORKER
      ? await fetchCharacterFromWorker(name, { reportCode: state.reportCode, fightId: state.fightId })
      : await fetchCharacterDemo(name, { reportCode: state.reportCode, fightId: state.fightId });

    state.character = character;
    state.gear = gear;
    state.equippedItemDetails = equippedItemDetails || {};
    renderCharacter();
    els.comparePanel.hidden = false;
    els.loadedEmptyState.hidden = false;
    els.resultsPanel.hidden = true;

    // Auto-select the phase WCL's raid zone tells us this log belongs
    // to (requirement 4) — falling back to whatever's already selected
    // if we couldn't confidently map the zone. populateSpecOptions
    // (called inside renderCharacter) has already defaulted the spec
    // dropdown to the one with real data, so both pieces are in place
    // before we auto-run the comparison (requirement 3/8). The
    // dropdowns stay fully editable afterward for manual research
    // (requirement 5) — this only sets the *initial* view.
    const phaseOptionExists = [...els.phaseSelect.options].some((o) => o.value === character.autoPhase);
    if (character.autoPhase && phaseOptionExists) {
      els.phaseSelect.value = character.autoPhase;
    }
    // The upgrade panel's phase control has to follow the auto-detected
    // phase too. Without this it stays on its markup default, and because
    // onFindUpgrades() resolves any disagreement in that control's favour,
    // the sweep would silently drag the comparison to the wrong phase.
    els.upgradePhaseSelect.value = els.phaseSelect.value;
    try {
      await runAndRenderComparison({ scroll: false });
    } catch (autoRunErr) {
      // Isolated from the outer catch below on purpose — a failure here
      // should never be mislabeled as "couldn't retrieve this character"
      // when the character fetch itself actually succeeded.
      console.error("Auto-run comparison threw:", autoRunErr);
    }

    els.comparePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(err.message || "We couldn't retrieve this character. Please try again.");
  } finally {
    setFetchLoading(false);
  }
}

/** Clearing the loaded report/character wipes everything currently on
 *  screen — confirm before doing it, since there's no undo. */
function onClearReportClick() {
  const confirmed = window.confirm(
    "Clear the loaded report and character data? This will reset the page back to the start — you'll need to load the report again."
  );
  if (confirmed) resetToFetch();
}

function resetToFetch() {
  state.reportCode = null;
  state.fightId = null;
  state.roster = null;
  state.character = null;
  state.gear = null;
  state.equippedItemDetails = null;
  els.charPanel.hidden = true;
  els.upgradePanel.hidden = true;
  els.upgradeStatus.innerHTML = "";
  els.upgradeResults.innerHTML = "";
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

/** Pulls the actual error message out of a Worker error response body
 *  (e.g. rate-limit or upstream failure text), falling back to a
 *  generic message only if the body isn't readable JSON. Without this,
 *  every non-404 failure showed the same generic text regardless of
 *  the real cause. */
async function extractWorkerErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
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
  const url = `${WCL_API_URL}/api/roster?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new Error("That report doesn't have any readable fights. Check the URL and try again.");
  }
  if (!res.ok) {
    throw new Error(await extractWorkerErrorMessage(res, "We couldn't load that report. Please try again."));
  }

  const data = await res.json();
  return { fightId: data.fightId, roster: data.roster || [] };
}

/** Demo/test-mode roster. In Test Mode this deliberately spans all
 *  four supported classes so the class→spec filtering and auto-phase
 *  detection can be exercised by picking different characters. */
async function fetchRosterDemo(parsed) {
  await sleep(500);
  return {
    fightId: parsed.fightId || "12",
    roster: [
      { name: "Testarms", class: "Warrior", spec: "Arms" },
      { name: "Testlock", class: "Warlock", spec: "Destruction" },
      { name: "Testhunter", class: "Hunter", spec: "Beast Mastery" },
      { name: "Testpally", class: "Paladin", spec: "Holy" },
    ],
  };
}

/** Calls the VPS server, which owns Warcraft Logs OAuth and never
 *  exposes client credentials to this frontend (spec section 10). */
async function fetchCharacterFromWorker(name, resolved) {
  const params = new URLSearchParams({ name, reportCode: resolved.reportCode, fightId: resolved.fightId });
  const url = `${WCL_API_URL}/api/character?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 404) {
    throw new Error("Character not found in that report. Check the character name and report URL.");
  }
  if (!res.ok) {
    throw new Error(await extractWorkerErrorMessage(res, "We couldn't retrieve this character. Please try again."));
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
      fightId: resolved.fightId,
      zoneName: data.zoneName || null,
      autoPhase: data.autoPhase || null,
      raidDate: data.raidDate || null,
      bestPerfAvg: data.bestPerfAvg ?? null, // null -> "Unavailable" (requirement 3.3)
      medPerfAvg: data.medPerfAvg ?? null,
      simulatable: Boolean(data.simulatable), // server tells us definitively whether /api/simulate supports this class
    },
    gear: data.gear, // expected shape: { slot: [itemId,...], weaponConfig }
    equippedItemDetails: data.equippedItemDetails || {}, // itemId -> { name, icon, quality, permanentEnchant, temporaryEnchant, gems }
  };
}

/** Demo/test-mode character response. "Testarms" is deliberately built
 *  to hit every ranking scenario the comparison engine supports, using
 *  real Phase 3 Arms Warrior item IDs from bis.json so the results
 *  actually reflect the live ranking logic, not made-up placeholder
 *  data:
 *    - rank 1 equipped in a single slot  -> BiS, no note   (head, hands, waist, feet, neck)
 *    - rank 2 equipped in a single slot  -> upgrade + "2nd BiS" note (shoulder, legs, ranged)
 *    - rank 3 equipped in a single slot  -> upgrade + "3rd BiS" note (back)
 *    - rank 4 equipped in a single slot  -> upgrade, no note (rank4 is past the label threshold) (wrist)
 *    - off-list item in a single slot    -> plain upgrade, no note (chest)
 *    - rank 1 + rank 2 in a multi-slot   -> BOTH satisfied, rank2 gets "2nd BiS" note, no upgrade (finger)
 *    - rank 1 + rank 3 in a multi-slot   -> rank1 satisfied; rank3 upgrades to next available (not rank1, already owned) + "3rd BiS" note (trinket)
 *    - empty two-hand + real mainhand/offhand -> tests all three weapon rows at once
 *  Other test characters (Testlock/Testhunter/Testpally) return
 *  simpler placeholder gear just to exercise the picker/class-spec
 *  flow — Testarms is the one built for thorough ranking-logic checks. */
const TEST_FIXTURES = {
  testarms: {
    character: { class: "Warrior", realmSpec: "Arms", zoneName: "Black Temple", autoPhase: "phase3", raidDate: "Aug 15, 2026", bestPerfAvg: 97.2, medPerfAvg: 62.8 },
    gear: {
      // weaponConfig omitted on purpose: the frontend derives weapon
      // rows from what's actually populated, matching the real Worker.
      mainhand: [32837], offhand: [32838],       // both rank 1 -> BiS, no upgrade
      head: [30972],                              // rank 1 -> BiS
      shoulder: [30055],                           // rank 2 -> upgrade + "2nd BiS"
      back: [32323],                                // rank 3 -> upgrade + "3rd BiS"
      chest: [99999],                                // off-list -> plain upgrade, no note
      wrist: [30861],                                  // rank 4 -> upgrade, no note (past label threshold)
      hands: [30969],                                   // rank 1 -> BiS
      waist: [30106],                                     // rank 1 -> BiS
      legs: [30977],                                       // rank 2 -> upgrade + "2nd BiS"
      feet: [32345],                                        // rank 1 -> BiS
      neck: [32591],                                         // rank 1 -> BiS
      ranged: [32326],                                        // rank 2 -> upgrade + "2nd BiS"
      finger: [32497, 32335],                                  // rank 1 + rank 2 -> both satisfied
      trinket: [28830, 32505],                                  // rank 1 + rank 3 -> rank3 upgrades
    },
    // Sample gems/enchants so the hover-tooltip feature can be checked
    // without needing a live WCL fetch. Real gem IDs (Bold/Delicate
    // Living Ruby etc.) and a real TBC weapon enchant ID.
    equippedItemDetails: {
      30972: { name: "Onslaught Battle-Helm", icon: null, quality: "Epic", permanentEnchant: null, temporaryEnchant: null, gems: [23107, 23096] }, // 2 red gems
      32837: { name: "Warglaive of Azzinoth", icon: null, quality: "Legendary", permanentEnchant: 2673, temporaryEnchant: null, gems: [] }, // Enchant: Executioner
      30055: { name: "Shoulderpads of the Stranger", icon: null, quality: "Epic", permanentEnchant: null, temporaryEnchant: null, gems: [23096] },
    },
  },
  testlock: {
    character: { class: "Warlock", realmSpec: "Destruction", zoneName: "Black Temple", autoPhase: "phase3", raidDate: "Aug 15, 2026", bestPerfAvg: 54.1, medPerfAvg: 31.9 },
    gear: { twohand: [32374], head: [31051], chest: [30107], trinket: [32483] },
  },
  testhunter: {
    character: { class: "Hunter", realmSpec: "Beast Mastery", zoneName: "Zul'Aman", autoPhase: "phase4", raidDate: "Sep 2, 2026", bestPerfAvg: 100, medPerfAvg: 88.4 },
    gear: { twohand: [29993], head: [32235], chest: [31004], trinket: [33831] },
  },
  testpally: {
    character: { class: "Paladin", realmSpec: "Holy", zoneName: "Black Temple", autoPhase: "phase3", raidDate: "Aug 15, 2026", bestPerfAvg: 12.6, medPerfAvg: 8.0 },
    gear: { mainhand: [32500], offhand: [32255], head: [30988], chest: [30992] },
  },
};

async function fetchCharacterDemo(name, resolved) {
  await sleep(650);

  if (name.trim().toLowerCase() === "notfound") {
    throw new Error("Character not found in that report. Check the character name and report URL.");
  }

  const fixture = TEST_FIXTURES[name.trim().toLowerCase()] || TEST_FIXTURES.testarms;

  return {
    character: {
      name,
      reportCode: resolved.reportCode,
      fightId: resolved.fightId,
      simulatable: SIMULATABLE_CLASSES.has(fixture.character.class),
      ...fixture.character,
    },
    gear: fixture.gear,
    equippedItemDetails: fixture.equippedItemDetails || {},
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
  els.charRaidDate.innerHTML = c.raidDate
    ? `<a href="https://fresh.warcraftlogs.com/reports/${escapeHtml(c.reportCode)}" target="_blank" rel="noopener">${escapeHtml(c.raidDate)}</a>`
    : "Unknown";
  els.charBestPerf.innerHTML = formatPerf(c.bestPerfAvg);
  els.charMedPerf.innerHTML = formatPerf(c.medPerfAvg);
  els.charPanel.hidden = false;

  // Simulation is only available for classes sim.js actually has a
  // rotation built for (Destruction Warlock, currently) — hide the
  // panel entirely rather than show a button that will always 400.
  els.upgradePanel.hidden = !c.simulatable;
  els.upgradeStatus.innerHTML = "";
  els.upgradeResults.innerHTML = "";

  populateSpecOptions(c.class);
}

/** Best/Median Performance Average tiering, matching Warcraft Logs'
 *  own percentile color convention exactly (gold/pink/orange/purple/
 *  blue/green/gray). "Unavailable" per requirement 3.3 when unknown. */
function formatPerf(value) {
  if (value == null) return `<span class="perf-tier-gray">Unavailable</span>`;
  const tier =
    value >= 100 ? "gold" :
    value >= 99 ? "pink" :
    value >= 95 ? "orange" :
    value >= 75 ? "purple" :
    value >= 50 ? "blue" :
    value >= 25 ? "green" : "gray";
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
    opt.textContent = hasBisData(spec.value) ? spec.label : `${spec.label} (no data yet)`;
    els.specSelect.appendChild(opt);
  });

  // Default to a spec that actually has data, if one exists among the
  // valid options for this class — no reason to make the user land on
  // an empty spec first when a real one is right there.
  const firstWithData = validSpecs.find((s) => hasBisData(s.value));
  if (firstWithData) els.specSelect.value = firstWithData.value;
}

/** True if either phase's BiS dataset has an entry for this spec. */
function hasBisData(specValue) {
  return Boolean(state.bisData?.phase3?.[specValue] || state.bisData?.phase4?.[specValue]);
}

/* ================================================================
   UPGRADE PRIORITY — what is each recommended piece actually worth?
   ================================================================
   Deliberately separate from the BiS comparison below: that panel is
   driven by the curated data/bis.json, while this one simulates
   wowsims' own preset gear set. The two can name different items for
   the same slot, so they're presented as two independent views rather
   than being interleaved (which would risk showing one item's name
   next to another item's DPS number).

   The backend runs one sim per slot (~30s total), so this is a job:
   POST starts it and returns an id, then we poll for progress.
   ================================================================ */
let upgradeInFlight = false;

async function onFindUpgrades() {
  if (upgradeInFlight || !state.character) return;
  upgradeInFlight = true;
  setUpgradeLoading(true);
  els.upgradeResults.innerHTML = "";
  els.upgradeStatus.innerHTML = `<span class="perf-badge"><span class="perf-label">Starting…</span></span>`;

  try {
    if (!USE_LIVE_WORKER) {
      await sleep(1200);
      renderUpgradeResults({ baselineDps: 1821.1, fullBisDps: 2104.6, results: DEMO_UPGRADES });
      return;
    }

    // Make sure the comparison matches the phase selected here before
    // reading its recommendations, so the sweep can never be a phase
    // behind what the cards show.
    if (els.phaseSelect.value !== els.upgradePhaseSelect.value) {
      els.phaseSelect.value = els.upgradePhaseSelect.value;
      await runAndRenderComparison({ scroll: false });
    }

    const targets = buildSweepTargets();
    if (targets.length === 0) {
      throw new Error("Nothing to simulate — either run a gear check first, or you're already best-in-slot everywhere for this phase.");
    }

    const startRes = await fetch(`${WCL_API_URL}/api/upgrade-sweep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.character.name,
        reportCode: state.character.reportCode,
        fightId: state.character.fightId,
        phase: els.phaseSelect.value,
        targets,
      }),
    });
    const start = await startRes.json().catch(() => ({}));
    if (!startRes.ok || start.error) {
      throw new Error(start.error || "Could not start the upgrade sweep.");
    }

    // The backend caches finished sweeps, so a repeat request for the
    // same character/fight/phase comes back instantly with no job.
    if (start.cached) {
      renderUpgradeResults(start);
      return;
    }

    const final = await pollUpgradeSweep(start.jobId);
    renderUpgradeResults(final);
  } catch (err) {
    els.upgradeStatus.innerHTML = `<span class="perf-badge"><span class="perf-value" style="color:var(--accent-upgrade);">${escapeHtml(err.message || "Upgrade sweep failed.")}</span></span>`;
  } finally {
    upgradeInFlight = false;
    setUpgradeLoading(false);
  }
}

async function pollUpgradeSweep(jobId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const res = await fetch(`${WCL_API_URL}/api/upgrade-sweep/${encodeURIComponent(jobId)}`);
    if (!res.ok) throw new Error("Lost track of the upgrade sweep — please try again.");
    const job = await res.json();
    if (job.status === "error") throw new Error(job.error || "Upgrade sweep failed.");
    if (job.status === "done") return job;
    els.upgradeStatus.innerHTML =
      `<span class="perf-badge"><span class="perf-label">Simulating ${job.done}/${job.total}</span> <span class="perf-value">${escapeHtml(job.currentSlot || "")}</span></span>`;
  }
  throw new Error("The upgrade sweep took longer than expected.");
}

function renderUpgradeResults({ baselineDps, fullBisDps, fullBisError, results }) {
  // Three levels of answer: where you are now, where the full recommended
  // set would put you, and what each individual piece contributes.
  // nowrap keeps each badge's label and figure on one line; the flex row
  // then breaks between whole badges instead of mid-phrase.
  const badgeStyle = "white-space:nowrap;";
  const badges = [
    `<span class="perf-badge" style="${badgeStyle}"><span class="perf-label">Current gear</span> <span class="perf-value perf-tier-gold">${baselineDps.toFixed(1)} DPS</span></span>`,
  ];

  if (fullBisDps != null) {
    const gain = fullBisDps - baselineDps;
    const sign = gain >= 0 ? "+" : "";
    const gainColour = gain >= 0 ? "var(--accent-bis, #63d471)" : "var(--accent-upgrade)";
    badges.push(
      `<span class="perf-badge" style="${badgeStyle}"><span class="perf-label">Full recommended set</span> <span class="perf-value perf-tier-gold">${fullBisDps.toFixed(1)} DPS</span> <span class="perf-value" style="color:${gainColour};">${sign}${gain.toFixed(1)}</span></span>`
    );
  } else if (fullBisError) {
    badges.push(
      `<span class="perf-badge" style="${badgeStyle}"><span class="perf-value" style="color:var(--accent-upgrade);">Full set couldn't be simulated</span></span>`
    );
  }

  els.upgradeStatus.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 22px;">${badges.join("")}</div>`;

  const rowStyle = "display:flex;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.07);";
  const slotStyle = "flex:0 0 92px;opacity:0.75;font-size:0.85rem;";
  const itemStyle = "flex:1 1 auto;min-width:0;";
  const valStyle = "flex:0 0 auto;font-weight:600;font-variant-numeric:tabular-nums;";

  // Same link shape the result cards use, so Wowhead's script supplies
  // the icon, the quality-coloured name and the full tooltip. The "Item
  // NNNNN" text is only a fallback shown before the script rewrites it.
  const itemLink = (id) =>
    `<a class="item-chip-link" href="https://www.wowhead.com/tbc/item=${id}" target="_blank" rel="noopener">Item ${id}</a>`;

  const rows = (results || []).map((r) => {
    if (r.error) {
      return `<div style="${rowStyle}"><span style="${slotStyle}">${escapeHtml(r.slotName)}</span><span style="${itemStyle}">${itemLink(r.recommendedItemId)}</span><span style="${valStyle};opacity:0.6;">couldn't simulate</span></div>`;
    }
    if (r.alreadyEquipped) {
      return `<div style="${rowStyle}"><span style="${slotStyle}">${escapeHtml(r.slotName)}</span><span style="${itemStyle}">${itemLink(r.recommendedItemId)}</span><span style="${valStyle};opacity:0.6;">already equipped</span></div>`;
    }
    const d = r.delta;
    const colour = d > 0.05 ? "var(--accent-bis, #63d471)" : d < -0.05 ? "var(--accent-upgrade)" : "inherit";
    const sign = d >= 0 ? "+" : "";
    return `<div style="${rowStyle}"><span style="${slotStyle}">${escapeHtml(r.slotName)}</span><span style="${itemStyle}">${itemLink(r.recommendedItemId)}</span><span style="${valStyle};color:${colour};">${sign}${d.toFixed(1)} DPS</span></div>`;
  }).join("");

  els.upgradeResults.innerHTML = `
    <div style="margin-top:12px;">${rows}</div>
    <p class="panel-hint" style="margin-top:12px;">
      Each figure is what you'd gain from obtaining that single piece, with everything else left as it is.
      They deliberately don't sum to the full-set number above — the spell hit cap, stat diminishing and set
      bonuses all make gear non-linear, so the whole set is usually worth less than the individual gains added together.
      A negative usually means swapping that piece alone would break a set bonus you're currently getting.
    </p>
  `;

  // These rows are injected long after Wowhead's initial page scan, so
  // without this the links stay as bare "Item 32374" text — no icon, no
  // name, no quality colour. Same call the result cards already make.
  if (window.$WowheadPower?.refreshLinks) {
    window.$WowheadPower.refreshLinks();
  }
}

function setUpgradeLoading(loading) {
  els.upgradeBtn.disabled = loading;
  els.upgradeBtn.querySelector(".btn-label").textContent = loading ? "Simulating…" : "Find My Upgrades";
}

/** Comparison slot label -> wowsimtbc ItemSlot index (proto/common.proto).
 *  "Two-Hand" and "Main Hand" both occupy slot 14; whichever the BiS set
 *  actually populates for this spec is the one that gets sent. */
const SWEEP_SLOT_INDEX = {
  "Head": 0, "Neck": 1, "Shoulder": 2, "Back": 3, "Chest": 4, "Wrist": 5,
  "Hands": 6, "Waist": 7, "Legs": 8, "Feet": 9,
  "Finger 1": 10, "Finger 2": 11, "Trinket 1": 12, "Trinket 2": 13,
  "Two-Hand": 14, "Main Hand": 14, "Off Hand": 15, "Ranged": 16,
};

/** The items the current comparison recommends, as [{slot, itemId}].
 *  Only slots that actually have a recommendation are included. */
function buildSweepTargets() {
  const comparison = state.lastComparison;
  if (!comparison) return [];

  const bySlot = new Map();
  const rows = [...(comparison.weapons || []), ...(comparison.armor || [])];

  for (const row of rows) {
    const slot = SWEEP_SLOT_INDEX[row.label];
    if (slot === undefined) continue;

    // Nothing to test if the slot is already BiS or has no recommendation.
    const itemId = row.recommendedId;
    if (!itemId) continue;

    // Slot 14 collision: prefer the weapon config this spec's BiS set
    // actually uses. Two-Hand wins if it has a recommendation, since a
    // staff spec leaves Main Hand empty rather than the other way round.
    if (bySlot.has(slot) && row.label === "Main Hand") continue;
    bySlot.set(slot, { slot, itemId });
  }

  return [...bySlot.values()];
}

/** Demo-mode stand-in so the panel can be exercised without a backend. */
const DEMO_UPGRADES = [
  { slot: 14, slotName: "Main Hand", recommendedItemId: 32374, alreadyEquipped: false, delta: 172.1 },
  { slot: 4, slotName: "Chest", recommendedItemId: 30107, alreadyEquipped: false, delta: 35.9 },
  { slot: 12, slotName: "Trinket 1", recommendedItemId: 32483, alreadyEquipped: false, delta: 20.3 },
  { slot: 7, slotName: "Waist", recommendedItemId: 30038, alreadyEquipped: true, delta: 0 },
  { slot: 3, slotName: "Back", recommendedItemId: 32524, alreadyEquipped: false, delta: -4.8 },
];

/* ================================================================
   STEP 2 — CHECK GEAR
   ================================================================ */
async function onCheckGear(evt) {
  evt.preventDefault();
  await runAndRenderComparison({ scroll: true });
}

/** Runs the comparison for whatever phase/spec is currently selected
 *  and renders it. Shared by the manual "Check Gear" submit and the
 *  automatic run that fires right after a character is fetched, so
 *  there's exactly one place this logic lives (requirement 3/4/8). */
let comparisonInFlight = false;

async function runAndRenderComparison({ scroll } = {}) {
  if (els.specSelect.disabled) return; // unsupported class — nothing valid to compare
  if (comparisonInFlight) return; // guards against a manual Check Gear click racing the auto-run
  comparisonInFlight = true;
  els.checkBtn.disabled = true;

  try {
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
    if (scroll) els.resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    comparisonInFlight = false;
    els.checkBtn.disabled = false;
  }
}

/** Every equipped/recommended item ID referenced across the results, deduped. */
function collectItemIds(results) {
  const ids = new Set();
  [...results.weapons, ...results.armor].forEach((r) => {
    if (r.equippedId != null) ids.add(r.equippedId);
    if (r.recommendedId != null) ids.add(r.recommendedId);
  });
  // Gems are just items too — reuse the same Blizzard enrichment pass
  // to get their real names/icons instead of a separate lookup path.
  Object.values(state.equippedItemDetails || {}).forEach((d) => {
    (d.gems || []).forEach((gemId) => ids.add(gemId));
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
  if (IS_TEST_MODE) return buildTestEnrichment(itemIds);
  if (!USE_LIVE_WORKER || itemIds.length === 0) return {};

  const BATCH_SIZE = 12;
  const batches = [];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    batches.push(itemIds.slice(i, i + BATCH_SIZE));
  }

  const merged = {};
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(`${ITEMS_API_URL}/api/items`, {
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

/** Test-mode item enrichment: rather than hand-maintain a separate
 *  static name list that could drift out of sync, this just looks up
 *  each item's real name straight out of bis.json's own `name` field
 *  (already present on every ranked entry for human auditing). Items
 *  that genuinely aren't on any BiS list (like the fixture's
 *  deliberately off-list chest item) correctly fall through to the
 *  "Item {id}" placeholder — which is itself useful to see in test
 *  mode, since that's exactly what an unrecognized item looks like
 *  in production too. */
function buildTestEnrichment(itemIds) {
  const byId = new Map();
  const phases = state.bisData ? Object.values(state.bisData).filter((v) => typeof v === "object") : [];
  phases.forEach((specs) => {
    Object.values(specs).forEach((slots) => {
      if (typeof slots !== "object") return;
      Object.values(slots).forEach((entries) => {
        if (!Array.isArray(entries)) return;
        entries.forEach((e) => {
          if (e.itemId != null && e.name) byId.set(e.itemId, e.name);
        });
      });
    });
  });

  const result = {};
  itemIds.forEach((id) => {
    if (byId.has(id)) result[id] = { name: byId.get(id), icon: null, quality: "epic", itemLevel: null };
  });
  return result;
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

/** Single-slot items (armor, weapons, ranged): ONLY rank 1 counts as
 *  a full match with no upgrade shown. Ranks 2 and 3 still get the
 *  upgrade recommendation (pointing at rank 1) — but since they're
 *  recognized BiS-list items, not random gear, they're tagged with
 *  an ordinal note ("2nd BiS"/"3rd BiS") so it's clear they're not
 *  worthless, just not optimal. Rank 4+ or off-list items get the
 *  upgrade with no note, same as always. */
const SINGLE_SLOT_LABEL_THRESHOLD = 3; // ranks up to this get a "Nth BiS" note when upgrading

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

  const ranked = [...bisRanked].sort((a, b) => a.rank - b.rank);
  const best = ranked[0];
  const equippedRank = equippedId != null ? ranked.find((b) => b.itemId === equippedId)?.rank : undefined;

  if (equippedRank === 1) {
    return {
      label, state: "bis", equippedId, recommendedId: equippedId,
      equippedSource: findSource(equippedId, ranked),
      recommendedSource: findSource(equippedId, ranked),
      alternatives: ranked,
    };
  }
  return {
    label, state: "upgrade", equippedId, recommendedId: best.itemId,
    equippedRankNote: equippedRank != null && equippedRank <= SINGLE_SLOT_LABEL_THRESHOLD ? `${ordinal(equippedRank)} BiS` : null,
    equippedSource: findSource(equippedId, ranked),
    recommendedSource: findSource(best.itemId, ranked),
    alternatives: ranked,
  };
}

/**
 * Generic multi-slot ranking system (section 19).
 * Given the items currently equipped in a category and a ranked BiS
 * list, assigns each equipped BiS item to its own position (best rank
 * first), then fills any remaining positions with the next-highest
 * ranked BiS items the character doesn't already own — never
 * recommending a duplicate of something already equipped.
 * Multi-slot items (trinket, finger): rank 1 or 2 both count as
 * "satisfied" — no upgrade suggested, since these categories have
 * two physical positions and getting the 2nd-best pick is a
 * reasonable outcome when only one rank-1 item exists to go around.
 * Rank 3+ (or off-list) triggers the upgrade path.
 */
const MULTI_SLOT_SATISFIED_THRESHOLD = 2;

function resolveMultiSlot(equippedIds, bisRanked, slotCount) {
  const ranked = [...bisRanked].sort((a, b) => a.rank - b.rank);
  const rankOf = new Map(ranked.map((b) => [b.itemId, b.rank]));
  const ownedSet = new Set(equippedIds);

  const isSatisfied = (id) => rankOf.has(id) && rankOf.get(id) <= MULTI_SLOT_SATISFIED_THRESHOLD;

  // Rank 1/2 equipped items are each a full BiS match — every one seats
  // its own position and can never be displaced by a duplicate
  // recommendation (section 19's duplicate-prevention requirement).
  const equippedSatisfied = equippedIds
    .filter(isSatisfied)
    .sort((a, b) => rankOf.get(a) - rankOf.get(b));

  // Everything else needing a recommendation: equipped items ranked 3+
  // (gets an ordinal note) or not on the list at all (no note).
  const equippedNeedingUpgrade = [...equippedIds.filter((id) => !isSatisfied(id))];

  // Candidates for remaining positions: ranked BiS items not already owned.
  const availableCandidates = ranked.filter((b) => !ownedSet.has(b.itemId));

  const positions = equippedSatisfied.map((id) => {
    const rank = rankOf.get(id);
    return {
      state: "bis", equippedId: id, recommendedId: id,
      equippedSource: findSource(id, ranked), recommendedSource: findSource(id, ranked),
      equippedRankNote: rank >= 2 ? `${ordinal(rank)} BiS` : null,
      alternatives: ranked,
    };
  });

  const remainingSlots = slotCount - positions.length;
  let candidateIndex = 0;
  for (let i = 0; i < remainingSlots; i++) {
    const equippedForThis = equippedNeedingUpgrade.shift() ?? null;
    const equippedRank = equippedForThis != null ? rankOf.get(equippedForThis) : null;
    const candidate = availableCandidates[candidateIndex];
    if (candidate) {
      candidateIndex++;
      positions.push({
        state: "upgrade", equippedId: equippedForThis, recommendedId: candidate.itemId,
        equippedSource: findSource(equippedForThis, ranked), recommendedSource: findSource(candidate.itemId, ranked),
        equippedRankNote: equippedRank ? `${ordinal(equippedRank)} BiS` : null,
        alternatives: ranked,
      });
    } else {
      positions.push({
        state: "unknown", equippedId: equippedForThis, recommendedId: null,
        equippedRankNote: equippedRank ? `${ordinal(equippedRank)} BiS` : null,
        alternatives: ranked,
      });
    }
  }

  return positions;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", etc. */
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ================================================================
   RENDER — RESULTS
   ================================================================ */
/** Filters out whichever weapon row doesn't apply to how this
 *  character is actually built — a Two-Hand user's empty Main Hand/
 *  Off Hand rows (and vice versa) exist for display context, but
 *  should never count as "missing BiS" since that config was never
 *  in play to begin with. Falls back to "only rows with something
 *  actually equipped" if weaponConfig is ever missing. */
function filterApplicableResults(results, gear) {
  const config = gear?.weaponConfig;
  const weapons = results.weapons.filter((r) => {
    if (config === "twohand") return r.label === "Two-Hand";
    if (config === "mainhand_offhand") return r.label === "Main Hand" || r.label === "Off Hand";
    return r.equippedId != null;
  });
  return [...weapons, ...results.armor];
}

function renderResults(results, phase, specMeta, enrichment) {
  // Remembered so the upgrade sweep can simulate exactly the items these
  // cards recommend — see buildSweepTargets().
  state.lastComparison = results;
  const applicable = filterApplicableResults(results, state.gear);
  const tally = { bis: 0, upgrade: 0, unknown: 0 };
  applicable.forEach((r) => tally[r.state]++);

  // BiS percentage deliberately excludes "Unable to Check" slots from
  // the denominator — we genuinely don't know if those are BiS or
  // not, so counting them as "missing" would be misleading.
  const countable = applicable.filter((r) => r.state !== "unknown");
  const bisCount = countable.filter((r) => r.state === "bis").length;
  const bisPercent = countable.length > 0 ? Math.round((bisCount / countable.length) * 100) : 0;

  els.resultsPerf.innerHTML = `
    <span class="perf-badge"><span class="perf-label">Best Perf Avg</span> ${formatPerf(state.character?.bestPerfAvg)}</span>
    <span class="perf-badge"><span class="perf-label">Median Perf Avg</span> ${formatPerf(state.character?.medPerfAvg)}</span>
  `;

  els.resultsSummary.innerHTML = `
    <span class="bis-progress"><span class="bis-progress-count">${bisCount}/${countable.length}</span> BiS <span class="bis-progress-percent">(${bisPercent}%)</span></span>
    <span class="tally-upgrade">${tally.upgrade} Upgrade</span>
    <span class="tally-unknown">${tally.unknown} Unable to Check</span>
  `;

  els.weaponResults.innerHTML = "";
  results.weapons.forEach((r) => els.weaponResults.appendChild(renderSlotCard(r, enrichment)));

  els.armorResults.innerHTML = "";
  results.armor.forEach((r) => els.armorResults.appendChild(renderSlotCard(r, enrichment)));

  // Wowhead's tooltip script only iconizes/renames links it sees during
  // its initial page scan — every result card here is injected
  // dynamically via JS, well after that scan already happened, so
  // without this the icon/name never populate (tooltips still work,
  // since hover detection works differently). Confirmed straight from
  // a Wowhead team reply: "call $WowheadPower.refreshLinks() after
  // you're done generating links." Guarded in case the script hasn't
  // finished loading yet (e.g. slow network) or is blocked.
  if (window.$WowheadPower?.refreshLinks) {
    window.$WowheadPower.refreshLinks();
  }
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
      ${renderItemChip(result.equippedId, result.state === "bis" ? "Equipped — matches BiS" : "Currently equipped", enrichment, result.equippedSource, result.equippedRankNote, true)}
      ${showArrow ? `<span class="flow-arrow">→</span>${renderItemChip(result.recommendedId, "Recommended", enrichment, result.recommendedSource, null, false)}` : ""}
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
      return `<div class="alt-row"><span class="alt-rank">#${alt.rank}</span><a class="alt-name" href="https://www.wowhead.com/tbc/item=${alt.itemId}" target="_blank" rel="noopener">${escapeHtml(name)}</a>${source}</div>`;
    })
    .join("");
  return `
    <details class="slot-alternatives">
      <summary>All ranked BiS options (${alternatives.length})</summary>
      <div class="alt-list">${rows}</div>
    </details>`;
}

function renderItemChip(itemId, sourceLabel, enrichment, dropSource, rankNote, isEquipped) {
  if (itemId == null) {
    return `
      <div class="item-chip">
        <div class="item-chip-link">
          <div class="item-icon placeholder">—</div>
          <div class="item-name">Empty</div>
        </div>
        <div class="item-text">
          <div class="item-source">${escapeHtml(sourceLabel)}</div>
        </div>
      </div>`;
  }

  const dropSourceMarkup = dropSource ? `<div class="item-drop-source">${escapeHtml(dropSource)}</div>` : "";
  const rankNoteMarkup = rankNote ? `<div class="item-rank-note">${escapeHtml(rankNote)}</div>` : "";

  // Wowhead's tooltip script (loaded in index.html's <head>) auto-attaches
  // a full, authentic WoW tooltip to any link with a data-wowhead
  // attribute — stats, sockets, socket bonus, equip effects, sell
  // price, all of it, pulled from Wowhead's own database. This is the
  // same system Warcraft Logs itself uses (confirmed on Wowhead's own
  // tooltips documentation page), so the result matches real WCL
  // tooltips rather than approximating them. For equipped items we
  // pass the character's actual gems/enchant (from WCL's
  // combatantInfo, via equippedItemDetails) so the tooltip reflects
  // what's really socketed. Recommended items get a plain item link —
  // Wowhead still shows the full base tooltip with no extra params
  // needed, which is what makes this work for prospective gear too.
  const details = isEquipped ? state.equippedItemDetails?.[itemId] : null;
  const whParams = [];
  if (details?.gems?.length) whParams.push(`gems=${details.gems.join(":")}`);
  if (details?.permanentEnchant) whParams.push(`ench=${details.permanentEnchant}`);
  const whAttr = whParams.length ? ` data-wowhead="${whParams.join("&")}"` : "";

  // Icon and name text are no longer built from Blizzard enrichment —
  // iconizeLinks/renameLinks (set in index.html) tell Wowhead's own
  // script to supply both directly on this link, the same way it
  // already supplies the tooltip. The text below is only a fallback
  // shown briefly before the script runs, or if it's ever blocked.
  return `
    <div class="item-chip">
      <a class="item-chip-link" href="https://www.wowhead.com/tbc/item=${itemId}" target="_blank" rel="noopener"${whAttr}>Item ${itemId}</a>
      <div class="item-text">
        <div class="item-source">${escapeHtml(sourceLabel)}</div>
        ${dropSourceMarkup}
        ${rankNoteMarkup}
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
