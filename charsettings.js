/**
 * charsettings.js - per-character settings for the Upgrade Priority panel.
 *
 * Warcraft Logs reports no race, and its Classic talent data is placeholder
 * junk, so these are things only a human can supply. Everything defaults to
 * the wowsims value for the spec: a player who never opens this still gets a
 * sensible answer, which is the whole point of "Actual by default".
 *
 * Self-contained, like lootpanel.js - it builds its own DOM and styles and
 * injects itself into #upgradePanel. app.js needs exactly one line added.
 *
 * Exposes window.WCGearSettings.forRequest() -> overrides object, or null.
 * null means "use the spec defaults", which is what Standardised mode sends
 * and what the server already treats as "no overrides".
 */

(function () {
  "use strict";

  var API = "https://bischeck.net";
  var LS_PREFIX = "wcgear:charsettings:";

  var el = {};
  var st = {
    specKey: null,
    className: null,
    charName: null,
    options: null,   // from /api/spec-options
    mode: "actual",
    values: null,    // { race, profession1, profession2, talents }
  };

  // -------------------------------------------------------------------------
  // Persistence - per character AND per spec, because an Affliction and a
  // Destruction warlock of the same name are different builds with different
  // sensible defaults.
  // -------------------------------------------------------------------------

  function storageKey() {
    if (!st.charName || !st.specKey) return null;
    return LS_PREFIX + st.charName.toLowerCase() + ":" + st.specKey;
  }

  function load() {
    var k = storageKey();
    if (!k) return null;
    try {
      var raw = window.localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function save() {
    var k = storageKey();
    if (!k) return;
    try {
      if (st.mode === "actual" && isDefault()) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, JSON.stringify({ mode: st.mode, values: st.values }));
    } catch (e) { /* private browsing, quota - settings just don't persist */ }
  }

  function isDefault() {
    if (!st.options || !st.values) return true;
    var d = st.options.defaults;
    return ["race", "profession1", "profession2", "talents"].every(function (f) {
      return String(st.values[f] || "") === String(d[f] || "");
    });
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  var STYLE = [
    "#charSettings{margin:10px 0 4px;font-size:.92rem}",
    "#charSettings summary{cursor:pointer;opacity:.85;padding:4px 0;user-select:none}",
    "#charSettings summary::marker{color:rgba(255,255,255,.4)}",
    ".cs-body{padding:10px 0 4px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end}",
    ".cs-field{display:flex;flex-direction:column;gap:3px;min-width:0}",
    ".cs-field label{font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;opacity:.6}",
    ".cs-field select,.cs-field input{font:inherit;padding:5px 7px;border-radius:5px;border:1px solid rgba(128,128,128,.45);background:rgba(0,0,0,.25);color:inherit}",
    ".cs-field input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;min-width:20rem}",
    ".cs-wide{flex:1 1 20rem}",
    ".cs-body[data-mode='standardised'] .cs-field.cs-lockable{opacity:.45;pointer-events:none}",
    ".cs-note{flex-basis:100%;margin:2px 0 0;font-size:.82rem;opacity:.72;line-height:1.5}",
    ".cs-warn{color:#ffcf8f}",
    ".cs-reset{background:none;border:0;color:inherit;opacity:.7;text-decoration:underline;cursor:pointer;font:inherit;font-size:.82rem;padding:0}",
    ".cs-reset[disabled]{opacity:.3;cursor:default;text-decoration:none}",
    ".cs-dirty{color:#8fd3ff}",
  ].join("");

  var MODE_NOTE = {
    actual: "Using this character's own settings. Anything you change here applies only to them.",
    standardised: "Ignoring per-character settings and simulating on wowsims' defaults for this spec — the level playing field for comparing players.",
  };

  function mount() {
    if (document.getElementById("charSettings")) return true;
    var panel = document.getElementById("upgradePanel");
    if (!panel) return false;

    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    var box = document.createElement("details");
    box.id = "charSettings";
    box.innerHTML =
      "<summary>Character settings</summary>" +
      '<div class="cs-body" id="csBody" data-mode="actual">' +
      '  <div class="cs-field"><label for="csMode">Settings</label>' +
      '    <select id="csMode"><option value="actual">Actual</option><option value="standardised">Standardised</option></select></div>' +
      '  <div class="cs-field cs-lockable"><label for="csRace">Race</label><select id="csRace"></select></div>' +
      '  <div class="cs-field cs-lockable"><label for="csProf1">Profession 1</label><select id="csProf1"></select></div>' +
      '  <div class="cs-field cs-lockable"><label for="csProf2">Profession 2</label><select id="csProf2"></select></div>' +
      '  <div class="cs-field cs-lockable cs-wide"><label for="csTalents">Talent string</label><input id="csTalents" type="text" spellcheck="false"></div>' +
      '  <div class="cs-field"><button type="button" class="cs-reset" id="csReset" disabled>Reset to default</button></div>' +
      '  <p class="cs-note" id="csNote"></p>' +
      "</div>";

    // Sits directly above the results, below the phase/spec selectors.
    var anchor = document.getElementById("upgradeStatus");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
    else panel.appendChild(box);

    ["csBody", "csMode", "csRace", "csProf1", "csProf2", "csTalents", "csReset", "csNote"]
      .forEach(function (id) { el[id] = document.getElementById(id); });

    el.csMode.addEventListener("change", function () {
      st.mode = el.csMode.value;
      el.csBody.setAttribute("data-mode", st.mode);
      render();
      save();
    });

    ["csRace", "csProf1", "csProf2", "csTalents"].forEach(function (id) {
      var evt = id === "csTalents" ? "input" : "change";
      el[id].addEventListener(evt, function () {
        st.values = {
          race: el.csRace.value,
          profession1: el.csProf1.value,
          profession2: el.csProf2.value,
          talents: el.csTalents.value.trim(),
        };
        render();
        save();
      });
    });

    el.csReset.addEventListener("click", function () {
      if (!st.options) return;
      st.values = Object.assign({}, st.options.defaults);
      render();
      save();
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // Loading options for the current spec
  // -------------------------------------------------------------------------

  function currentContext() {
    var sel = document.getElementById("upgradeSpecSelect");
    var specKey = sel && sel.value ? sel.value : null;
    var name = null, cls = null;
    try {
      if (typeof state === "object" && state && state.character) {
        name = state.character.name;
        cls = state.character.class;
      }
    } catch (e) { /* app.js scope unavailable */ }
    return { specKey: specKey, className: cls, charName: name };
  }

  function refresh() {
    var ctx = currentContext();
    var box = document.getElementById("charSettings");
    if (!box) return;

    if (!ctx.specKey || !ctx.className || !ctx.charName) { box.hidden = true; return; }
    if (ctx.specKey === st.specKey && ctx.charName === st.charName) return; // nothing changed

    st.specKey = ctx.specKey;
    st.className = ctx.className;
    st.charName = ctx.charName;
    st.options = null;

    fetch(API + "/api/spec-options?spec=" + encodeURIComponent(ctx.specKey) +
          "&class=" + encodeURIComponent(ctx.className))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (opts) {
        // No sim for this spec - the panel can't run anyway, so stay hidden
        // rather than offering settings that do nothing.
        if (!opts) { box.hidden = true; st.options = null; return; }

        st.options = opts;
        var saved = load();
        st.mode = (saved && saved.mode) || "actual";
        st.values = Object.assign({}, opts.defaults, (saved && saved.values) || {});
        el.csMode.value = st.mode;
        el.csBody.setAttribute("data-mode", st.mode);
        fillSelects();
        render();
        box.hidden = false;
      })
      .catch(function () { box.hidden = true; });
  }

  function fillSelects() {
    var o = st.options;
    el.csRace.innerHTML = o.races.map(function (r) {
      return '<option value="' + esc(r.value) + '">' + esc(r.label) + "</option>";
    }).join("");
    var profs = o.professions.map(function (p) {
      return '<option value="' + esc(p.value) + '">' + esc(p.label) + "</option>";
    }).join("");
    el.csProf1.innerHTML = profs;
    el.csProf2.innerHTML = profs;
  }

  function render() {
    var o = st.options;
    if (!o) return;

    el.csRace.value = st.values.race;
    el.csProf1.value = st.values.profession1;
    el.csProf2.value = st.values.profession2;
    if (document.activeElement !== el.csTalents) el.csTalents.value = st.values.talents;

    var def = isDefault();
    el.csReset.disabled = def;

    var bits = [MODE_NOTE[st.mode]];

    if (st.mode === "actual" && !def) {
      var changed = [];
      var d = o.defaults;
      if (st.values.race !== d.race) changed.push("race");
      if (st.values.profession1 !== d.profession1 || st.values.profession2 !== d.profession2) changed.push("professions");
      if (st.values.talents !== d.talents) changed.push("talents");
      bits.push('<span class="cs-dirty">Changed from the wowsims default: ' + changed.join(", ") + ".</span>");
    }

    // A talent string alone does NOT make a different build. wowsims bundles
    // talents WITH a rotation and spec options - pasting Destro Fire talents
    // here leaves the Destruction rotation running, which produces a confident
    // wrong number. Say so rather than let someone find out the hard way.
    if (st.mode === "actual" && st.values.talents !== o.defaults.talents) {
      bits.push('<span class="cs-warn">Note: the rotation stays this spec’s own. ' +
        "Talents from a different build (Destro Fire, Demo Felguard) need that build's rotation too — " +
        "those are being added as their own entries in the Specialization list.</span>");
    }

    el.csNote.innerHTML = bits.join(" ");

    // Settings change the answer, so a stale result table would be misleading.
    var results = document.getElementById("upgradeResults");
    if (results && results.innerHTML.trim() && !def) {
      var flag = document.getElementById("csStale");
      if (!flag) {
        flag = document.createElement("p");
        flag.id = "csStale";
        flag.className = "cs-note cs-warn";
        flag.textContent = "Settings changed — run Find My Upgrades again to apply them.";
        results.parentNode.insertBefore(flag, results);
      }
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // -------------------------------------------------------------------------
  // Public surface - what app.js sends with the sweep
  // -------------------------------------------------------------------------

  window.WCGearSettings = {
    /**
     * null means "spec defaults". The server treats null and
     * defaults-unchanged identically, so Standardised and an untouched
     * Actual produce the same cache key and the same numbers.
     */
    forRequest: function () {
      if (st.mode === "standardised" || !st.options || !st.values || isDefault()) return null;
      return {
        race: st.values.race,
        profession1: st.values.profession1,
        profession2: st.values.profession2,
        talents: st.values.talents,
      };
    },
    mode: function () { return st.mode; },
    clearStaleFlag: function () {
      var f = document.getElementById("csStale");
      if (f && f.parentNode) f.parentNode.removeChild(f);
    },
  };

  function boot() {
    if (!mount()) { setTimeout(boot, 400); return; }
    // Poll rather than hook app.js: no edits there, and it picks up character
    // and spec changes however they happen.
    setInterval(refresh, 700);
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
