/**
 * lootpanel.js - "this dropped, who gains most?"
 *
 * The loot-council half of the tool. Deliberately self-contained: it builds
 * its own DOM, ships its own styles, and reads app.js only through a guarded
 * global lookup with a fall-back. That keeps it out of app.js, which is large,
 * hand-edited through the GitHub web UI, and has already cost an afternoon to
 * a two-registry sync bug.
 *
 * Integration is one line in index.html:
 *     <script src="lootpanel.js"></script>
 * placed AFTER the app.js tag.
 */

(function () {
  "use strict";

  var API = "https://bischeck.net";
  var POLL_MS = 1200;
  var POLL_DEADLINE_MS = 10 * 60 * 1000;

  var el = {};
  var lootState = {
    item: null,
    roster: [],
    selected: {},
    running: false,
    searchSeq: 0,
  };

  // -------------------------------------------------------------------------
  // Report context
  //
  // app.js declares `state` with const at classic-script top level, so it
  // lands in the shared global lexical scope and is readable here. The typeof
  // guard means a future move to type="module" degrades to the input-parsing
  // fall-back instead of throwing.
  // -------------------------------------------------------------------------

  function reportContext() {
    try {
      if (typeof state === "object" && state && state.reportCode) {
        return { reportCode: state.reportCode, fightId: state.fightId };
      }
    } catch (e) { /* not in scope - fall through */ }

    var input = document.getElementById("reportUrlInput");
    var raw = input && input.value ? input.value.trim() : "";
    var m = raw.match(/reports\/([a-zA-Z0-9]+)/);
    if (!m) return null;
    var fight = raw.match(/fight=(\d+)/);
    return { reportCode: m[1], fightId: fight ? Number(fight[1]) : null };
  }

  function currentPhase() {
    var sel = document.getElementById("lcPhase");
    if (sel && sel.value) return sel.value;
    var compare = document.getElementById("phaseSelect");
    return compare && compare.value ? compare.value : "phase3";
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  var STYLE = [
    "#lootPanel{margin:1.5rem 0;padding:1.25rem;border:1px solid rgba(128,128,128,.35);border-radius:10px}",
    "#lootPanel h2{margin:0 0 .25rem}",
    ".lc-sub{opacity:.75;font-size:.9rem;margin:0 0 1rem}",
    ".lc-row{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-bottom:.85rem}",
    ".lc-row label{font-size:.85rem;opacity:.8}",
    ".lc-search{position:relative;flex:1 1 260px;min-width:0}",
    ".lc-search input{width:100%;box-sizing:border-box;padding:.55rem .7rem;font:inherit;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit}",
    ".lc-results{position:absolute;z-index:40;left:0;right:0;top:100%;max-height:17rem;overflow-y:auto;border:1px solid rgba(128,128,128,.45);border-radius:6px;background:#14161c;box-shadow:0 6px 20px rgba(0,0,0,.5)}",
    ".lc-results button{display:block;width:100%;text-align:left;padding:.5rem .7rem;font:inherit;background:none;border:0;color:inherit;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.18)}",
    ".lc-results button:last-child{border-bottom:0}",
    ".lc-results button:hover,.lc-results button:focus{background:rgba(120,150,255,.16);outline:none}",
    ".lc-slot{opacity:.6;font-size:.82rem;margin-left:.4rem}",
    ".lc-chosen{padding:.6rem .75rem;border:1px solid rgba(128,128,128,.4);border-radius:6px;margin-bottom:.9rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}",
    ".lc-cands{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem}",
    ".lc-cands label{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .6rem;border:1px solid rgba(128,128,128,.4);border-radius:999px;font-size:.9rem;cursor:pointer}",
    ".lc-cands label.on{border-color:rgba(120,170,255,.9);background:rgba(120,170,255,.13)}",
    ".lc-cands .lc-spec{opacity:.62;font-size:.82rem}",
    ".lc-excluded{font-size:.85rem;opacity:.75;margin:.4rem 0 1rem}",
    ".lc-excluded summary{cursor:pointer}",
    ".lc-excluded li{margin:.2rem 0}",
    ".lc-go{padding:.6rem 1.1rem;font:inherit;font-weight:600;border-radius:6px;border:1px solid rgba(120,170,255,.75);background:rgba(120,170,255,.18);color:inherit;cursor:pointer}",
    ".lc-go[disabled]{opacity:.5;cursor:default}",
    ".lc-status{margin:.8rem 0 0;font-size:.9rem;opacity:.85}",
    ".lc-err{color:#ff9b9b}",
    ".lc-out{margin-top:1rem}",
    ".lc-res{display:grid;grid-template-columns:minmax(7rem,auto) 1fr minmax(5rem,auto);gap:.6rem;align-items:center;padding:.55rem 0;border-bottom:1px solid rgba(128,128,128,.2)}",
    ".lc-res:last-child{border-bottom:0}",
    ".lc-name{font-weight:600}",
    ".lc-meta{display:block;font-weight:400;opacity:.62;font-size:.82rem}",
    // display:block matters - these are spans, and an inline element ignores
    // height, which collapses the bar to nothing.
    ".lc-track{display:block}",
    ".lc-bar{display:block;height:.55rem;border-radius:999px;background:rgba(128,128,128,.2);overflow:hidden}",
    ".lc-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#4f8cff,#63d8b0)}",
    ".lc-res a{color:#8fb6ff}",
    ".lc-bar.neg span{background:linear-gradient(90deg,#ff7a7a,#ffb066)}",
    ".lc-delta{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}",
    ".lc-delta.neg{color:#ff9b9b}",
    ".lc-note{font-size:.85rem;opacity:.7;margin-top:.9rem;line-height:1.5}",
    ".lc-modenote{font-size:.82rem;opacity:.7;flex-basis:100%;margin:0}",
    "@media(max-width:560px){.lc-res{grid-template-columns:1fr auto;}.lc-bar{grid-column:1/-1}}",
  ].join("");

  var HTML = [
    '<h2>Loot Check</h2>',
    '<p class="lc-sub">An item dropped &mdash; who gains the most from it? Figures are the DPS each player would gain, simulated against their own logged gear.</p>',

    '<div class="lc-row">',
    '  <div class="lc-search">',
    '    <input id="lcSearch" type="text" autocomplete="off" placeholder="What dropped? Type an item name or paste an item ID">',
    '    <div id="lcResults" class="lc-results" hidden></div>',
    '  </div>',
    '  <label for="lcPhase">Evaluate for</label>',
    '  <select id="lcPhase"><option value="phase3">Phase 3</option><option value="phase4">Phase 4</option></select>',
    '</div>',

    '<div id="lcChosen" class="lc-chosen" hidden></div>',
    '<p id="lcPick" class="lc-sub" hidden>Pick who is in contention.</p>',
    '<div id="lcCands" class="lc-cands"></div>',
    '<div id="lcExcluded"></div>',
    '<button id="lcGo" class="lc-go" type="button" disabled>Compare candidates</button>',
    '<p id="lcStatus" class="lc-status"></p>',
    '<div id="lcOut" class="lc-out"></div>',
  ].join("");

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  function mount() {
    if (document.getElementById("lootPanel")) return;

    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    var panel = document.createElement("section");
    panel.id = "lootPanel";
    panel.hidden = true;
    panel.innerHTML = HTML;

    var after = document.getElementById("upgradePanel") || document.getElementById("resultsPanel");
    if (after && after.parentNode) after.parentNode.insertBefore(panel, after.nextSibling);
    else document.body.appendChild(panel);

    ["lcSearch", "lcResults", "lcChosen", "lcPick", "lcCands", "lcExcluded", "lcGo", "lcStatus", "lcOut", "lcPhase"]
      .forEach(function (id) { el[id] = document.getElementById(id); });

    el.lcSearch.addEventListener("input", debounce(onSearch, 220));
    el.lcSearch.addEventListener("focus", function () { if (el.lcResults.children.length) el.lcResults.hidden = false; });
    document.addEventListener("click", function (e) {
      if (!el.lcResults.contains(e.target) && e.target !== el.lcSearch) el.lcResults.hidden = true;
    });
    el.lcGo.addEventListener("click", onRun);
    el.lcPhase.addEventListener("change", function () { if (lootState.item) loadCandidates(lootState.item.id); });

    // Mirror the Compare panel's phase, which carries the auto-detected value.
    // Same lockstep requirement as the Upgrade panel: a loot check evaluated
    // for the wrong phase silently borrows the wrong gemming.
    var compare = document.getElementById("phaseSelect");
    if (compare) {
      var sync = function () { if (compare.value) el.lcPhase.value = compare.value; };
      compare.addEventListener("change", sync);
      sync();
    }

    watchForReport();
  }

  // Poll rather than hook app.js: no edits to app.js, and it recovers on its
  // own if a report is loaded, cleared and reloaded.
  function watchForReport() {
    var panel = document.getElementById("lootPanel");
    setInterval(function () {
      panel.hidden = !reportContext();
    }, 750);
  }

  // -------------------------------------------------------------------------
  // Item search
  // -------------------------------------------------------------------------

  function onSearch() {
    var q = el.lcSearch.value.trim();
    if (q.length < 2) { el.lcResults.hidden = true; el.lcResults.innerHTML = ""; return; }

    var seq = ++lootState.searchSeq;
    fetch(API + "/api/item-search?q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== lootState.searchSeq) return; // a newer keystroke won
        renderSearchResults((data && data.results) || []);
      })
      .catch(function () {
        if (seq !== lootState.searchSeq) return;
        el.lcResults.innerHTML = '<button type="button" disabled>Search failed.</button>';
        el.lcResults.hidden = false;
      });
  }

  var SLOT_LABEL = ["Head","Neck","Shoulder","Back","Chest","Wrist","Hands","Waist","Legs","Feet","Finger","Finger","Trinket","Trinket","Main Hand","Off Hand","Ranged"];

  function slotHint(item) {
    var s = item.slots || [];
    if (!s.length) return "";
    var name = SLOT_LABEL[s[0]] || "";
    if (s.length > 1 && SLOT_LABEL[s[0]] !== SLOT_LABEL[s[1]]) name += " / " + SLOT_LABEL[s[1]];
    return name;
  }

  function renderSearchResults(results) {
    if (!results.length) {
      el.lcResults.innerHTML = '<button type="button" disabled>No items match that.</button>';
      el.lcResults.hidden = false;
      return;
    }
    el.lcResults.innerHTML = results.map(function (it) {
      return '<button type="button" data-id="' + it.id + '">' + esc(it.name) +
        '<span class="lc-slot">' + esc(slotHint(it)) + "</span></button>";
    }).join("");
    Array.prototype.forEach.call(el.lcResults.querySelectorAll("button[data-id]"), function (b) {
      b.addEventListener("click", function () { chooseItem(Number(b.getAttribute("data-id"))); });
    });
    el.lcResults.hidden = false;
  }

  function chooseItem(itemId) {
    el.lcResults.hidden = true;
    el.lcSearch.value = "";
    el.lcOut.innerHTML = "";
    loadCandidates(itemId);
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  function loadCandidates(itemId) {
    var ctx = reportContext();
    if (!ctx) { setStatus("Load a report first.", true); return; }

    setStatus("Working out who can use it\u2026");
    var params = new URLSearchParams({ itemId: String(itemId), reportCode: ctx.reportCode });
    if (ctx.fightId != null) params.set("fightId", String(ctx.fightId));

    fetch(API + "/api/loot-candidates?" + params.toString(), { cache: "no-store" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d && res.d.error ? res.d.error : "Could not build a candidate list.");
        lootState.item = res.d.item;
        lootState.roster = res.d.roster || [];
        // Nobody is pre-selected. The council decides who is in contention;
        // the tool's job is to say who COULD be, not to shortlist for them.
        lootState.selected = {};
        renderChosen();
        renderRoster();
        setStatus("");
      })
      .catch(function (err) { setStatus(err.message, true); });
  }

  function renderChosen() {
    var it = lootState.item;
    if (!it) { el.lcChosen.hidden = true; return; }
    el.lcChosen.innerHTML =
      '<strong>' + wowheadLink(it.id, it.name) + "</strong>" +
      '<span class="lc-slot">' + esc(slotHint(it)) + (it.unique ? " \u00b7 unique-equipped" : "") + "</span>";
    el.lcChosen.hidden = false;
    refreshWowhead();
  }

  function isPickable(r) { return r.simulatable && r.equippable; }

  function renderRoster() {
    var roster = lootState.roster;
    var pickable = roster.filter(isPickable);
    var rest = roster.filter(function (r) { return !isPickable(r); });

    el.lcPick.hidden = !roster.length;

    if (!pickable.length) {
      el.lcCands.innerHTML = '<p class="lc-sub" style="margin:0">Nobody in this report can be simulated for that item yet.</p>';
    } else {
      el.lcCands.innerHTML = pickable.map(function (c) {
        return '<label data-name="' + esc(c.name) + '">' +
          '<input type="checkbox" data-name="' + esc(c.name) + '">' +
          esc(c.name) + '<span class="lc-spec">' + esc(c.specLabel) + "</span></label>";
      }).join("");
      Array.prototype.forEach.call(el.lcCands.querySelectorAll("input[type=checkbox]"), function (box) {
        box.addEventListener("change", function () {
          var name = box.getAttribute("data-name");
          lootState.selected[name] = box.checked;
          var label = el.lcCands.querySelector('label[data-name="' + cssEsc(name) + '"]');
          if (label) label.classList.toggle("on", box.checked);
          updateGo();
        });
      });
    }

    // The rest of the roster stays visible with its reason. A council that
    // cannot see who was left out has no way to tell "the tool is silent about
    // this person" apart from "the tool ruled them out".
    if (rest.length) {
      el.lcExcluded.innerHTML =
        '<details class="lc-excluded"><summary>' + rest.length +
        " others in this raid</summary><ul>" +
        rest.map(function (x) {
          return "<li>" + esc(x.name) + " \u2014 " + esc(x.reason || "not available") + "</li>";
        }).join("") + "</ul></details>";
    } else {
      el.lcExcluded.innerHTML = "";
    }

    updateGo();
  }

  function selectedNames() {
    return lootState.roster
      .filter(function (c) { return isPickable(c) && lootState.selected[c.name]; })
      .map(function (c) { return { name: c.name, specKey: c.specKey }; });
  }

  function updateGo() {
    var n = selectedNames().length;
    el.lcGo.disabled = lootState.running || !lootState.item || n === 0 || n > 8;
    el.lcGo.textContent = n > 1 ? "Compare " + n + " candidates" : n === 1 ? "Check 1 candidate" : "Pick who to compare";
    if (n > 8) setStatus("Pick at most 8 candidates.", true);
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  function onRun() {
    var ctx = reportContext();
    if (!ctx || !lootState.item) return;
    var picked = selectedNames();
    if (!picked.length) return;

    lootState.running = true;
    updateGo();
    el.lcOut.innerHTML = "";
    setStatus("Starting\u2026");

    fetch(API + "/api/loot-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: lootState.item.id,
        reportCode: ctx.reportCode,
        fightId: ctx.fightId,
        phase: currentPhase(),
        candidates: picked,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d && res.d.error ? res.d.error : "Could not start the loot check.");
        return poll(res.d.jobId);
      })
      .catch(function (err) { setStatus(err.message, true); })
      .then(function () { lootState.running = false; updateGo(); });
  }

  function poll(jobId) {
    var deadline = Date.now() + POLL_DEADLINE_MS;

    function tick() {
      if (Date.now() > deadline) { setStatus("That took too long. Try fewer candidates.", true); return; }
      return fetch(API + "/api/loot-check/" + encodeURIComponent(jobId), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (job) {
          if (job.error) { setStatus(job.error, true); return; }
          if (job.status === "done") {
            setStatus("");
            renderResults(job);
            return;
          }
          var who = job.currentName ? " \u2014 " + job.currentName : "";
          setStatus("Simulating " + (job.done + 1) + " of " + job.total + who + "\u2026");
          return sleep(POLL_MS).then(tick);
        });
    }
    return tick();
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  function renderResults(job) {
    var results = job.results || [];
    var ok = results.filter(function (r) { return r.status === "ok"; });
    var peak = ok.reduce(function (m, r) { return Math.max(m, Math.abs(r.delta)); }, 0) || 1;

    var rows = results.map(function (r) {
      if (r.status !== "ok") {
        var msg = r.status === "already_equipped"
          ? "already wearing it (" + esc(r.wornSlotName || "") + ")"
          : esc(r.error || "could not be simulated");
        return '<div class="lc-res"><span class="lc-name">' + esc(r.name) +
          '<span class="lc-meta">' + esc(r.specLabel) + "</span></span>" +
          '<span class="lc-meta">' + msg + "</span><span></span></div>";
      }

      var pct = Math.max(2, Math.round((Math.abs(r.delta) / peak) * 100));
      var neg = r.delta < 0;
      var replaces = r.replacedItemId ? "replaces " + wowheadLink(r.replacedItemId, "their " + r.slotName) : "into empty " + esc(r.slotName);
      if (r.alsoReplacedItemId) replaces += " and their off-hand";

      return '<div class="lc-res">' +
        '<span class="lc-name">' + esc(r.name) + '<span class="lc-meta">' + esc(r.specLabel) + "</span></span>" +
        '<span class="lc-track"><span class="lc-bar' + (neg ? " neg" : "") + '"><span style="width:' + pct + '%"></span></span>' +
        '<span class="lc-meta">' + replaces + "</span></span>" +
        '<span class="lc-delta' + (neg ? " neg" : "") + '">' + (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1) + "</span>" +
        "</div>";
    }).join("");

    el.lcOut.innerHTML = rows +
      '<p class="lc-note"><strong>' + esc(phaseLabel(job.phase)) + " \u00b7 each player on their logged spec.</strong> " +
      "Each figure is the DPS that player would gain from this one item, with everything else they wear left as it is. " +
      "Runs share a fixed random seed, so two candidates a few DPS apart are genuinely a few DPS apart rather than noise. " +
      "A negative usually means the item breaks a set bonus they currently have.</p>";

    refreshWowhead();
  }

  function phaseLabel(p) { return p === "phase4" ? "Phase 4" : "Phase 3"; }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function wowheadLink(itemId, text) {
    return '<a class="item-chip-link" href="https://www.wowhead.com/tbc/item=' + itemId +
      '" data-wowhead="item=' + itemId + '" target="_blank" rel="noopener">' + esc(text) + "</a>";
  }

  // Wowhead's script only decorates links present at its initial page scan.
  // These appear up to a minute later, so it must be told explicitly.
  function refreshWowhead() {
    try {
      if (window.$WowheadPower && typeof window.$WowheadPower.refreshLinks === "function") {
        window.$WowheadPower.refreshLinks();
      }
    } catch (e) { /* decoration is cosmetic; names are already correct */ }
  }

  function setStatus(msg, isError) {
    el.lcStatus.textContent = msg || "";
    el.lcStatus.className = "lc-status" + (isError ? " lc-err" : "");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
