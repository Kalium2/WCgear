/**
 * shape-armory.js — print the real structure of what Blizzard returned.
 *
 * Reads the JSON that probe-armory.js saved and prints a digest small enough to
 * paste into chat but complete enough to build against. Run it in the same
 * directory as ./armory-probe/.
 *
 *   node shape-armory.js
 *
 * WHY THIS EXISTS AND NOT JUST `cat`:
 *   The equipment file is tens of KB of repeated structure. What matters is the
 *   SHAPE — which keys exist, what TYPE each value is, and whether a key is
 *   present on every item or only some. A digest shows that; a dump buries it.
 *
 * THE SPECIFIC QUESTION IT ANSWERS:
 *   probe-armory.js reported "0 socketed" for a level 70 raider, counting
 *   `item.sockets`. That is either true, or the field has a different name and
 *   the count silently read zero. This script does not trust the name: it walks
 *   every key on every item and reports anything whose name OR content looks
 *   like a socket or a gem, then prints those entries verbatim.
 *
 * Also writes armory-digest.txt so it can be sent as a file instead of pasted.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(process.cwd(), "armory-probe");
const NS = process.argv[2] || "classicann";

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

function load(kind) {
  const f = path.join(DIR, `${NS}__${kind}.json`);
  if (!fs.existsSync(f)) { say(`(missing: ${path.relative(process.cwd(), f)})`); return null; }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** Compact type description — the thing we actually need to know. */
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/** One-line preview of a value, truncated. */
function preview(v, max = 70) {
  let s;
  if (v === null || v === undefined) s = String(v);
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Walk an object to a bounded depth, printing key -> type = preview. */
function outline(obj, indent = "  ", depth = 0, maxDepth = 2) {
  if (depth > maxDepth || obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_links" || k === "key") continue;
    say(`${indent}${k}: ${typeOf(v)} = ${preview(v)}`);
    if (v && typeof v === "object" && !Array.isArray(v) && depth < maxDepth) {
      outline(v, indent + "  ", depth + 1, maxDepth);
    }
  }
}

say("=".repeat(72));
say(`ARMORY DIGEST — namespace family: ${NS}`);
say("=".repeat(72));

/* ---- SUMMARY ------------------------------------------------------------ */
const summary = load("summary");
if (summary) {
  say("\n## SUMMARY — top-level keys and the ones we care about\n");
  say(`  all keys: ${Object.keys(summary).join(", ")}`);
  for (const k of ["name", "level", "faction", "race", "character_class",
                   "active_spec", "realm", "last_login_timestamp",
                   "average_item_level", "equipped_item_level", "guild"]) {
    if (k in summary) say(`  ${k}: ${typeOf(summary[k])} = ${preview(summary[k], 90)}`);
  }
}

/* ---- EQUIPMENT ---------------------------------------------------------- */
const equip = load("equipment");
if (equip) {
  const items = equip.equipped_items || [];
  say("\n" + "-".repeat(72));
  say(`## EQUIPMENT — ${items.length} items`);
  say("-".repeat(72));

  say(`\n  response top-level keys: ${Object.keys(equip).join(", ")}`);

  // Key census: which keys appear on how many items. A key present on SOME
  // items is the interesting case — that is where optional data (gems,
  // enchants) lives, and where a naive reader silently gets undefined.
  const census = new Map();
  for (const it of items) {
    for (const k of Object.keys(it)) census.set(k, (census.get(k) || 0) + 1);
  }
  say("\n  key census (key: present on N of " + items.length + " items):");
  [...census.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    const sample = items.find((i) => i[k] !== undefined)[k];
    say(`    ${k.padEnd(26)} ${String(n).padStart(3)}   ${typeOf(sample)}`);
  });

  // Slot census — we need every slot.type string to map onto our own slot names.
  say("\n  slot types, in order returned:");
  say("    " + items.map((i) => (i.slot && i.slot.type) || "?").join(", "));

  // Anything socket- or gem-shaped, whatever it is called.
  say("\n  SOCKET / GEM HUNT — any key whose NAME or CONTENT looks socket-like:");
  const hits = [];
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      const nameLooks = /socket|gem/i.test(k);
      const contentLooks = /socket|gem/i.test(JSON.stringify(v || "").slice(0, 2000));
      if (nameLooks || contentLooks) {
        hits.push({ slot: it.slot && it.slot.type, key: k, value: v });
      }
    }
  }
  if (!hits.length) {
    say("    NOTHING socket-shaped on any item, under any key name.");
    say("    -> the 0-socketed count is real, not a field-name miss.");
  } else {
    say(`    ${hits.length} hit(s):`);
    hits.slice(0, 4).forEach((h) => {
      say(`\n    [${h.slot}] ${h.key} =`);
      say(JSON.stringify(h.value, null, 2).split("\n").map((l) => "      " + l).join("\n"));
    });
    if (hits.length > 4) say(`\n    (${hits.length - 4} more of the same shape)`);
  }

  // One enchanted item in full — enchant ID space is what we must map.
  const enchanted = items.find((i) => Array.isArray(i.enchantments) && i.enchantments.length);
  if (enchanted) {
    say("\n  ONE ENCHANTED ITEM, VERBATIM (enchant id space matters):");
    say(JSON.stringify(enchanted, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  } else {
    say("\n  No item carries an `enchantments` array — check the census above for the real key.");
  }

  // A plain item in full, for the baseline shape.
  const plain = items.find((i) => i !== enchanted) || items[0];
  if (plain) {
    say("\n  ONE PLAIN ITEM, VERBATIM (baseline shape):");
    say(JSON.stringify(plain, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  }
}

/* ---- TALENTS ------------------------------------------------------------ */
const specs = load("specializations");
if (specs) {
  say("\n" + "-".repeat(72));
  say("## TALENTS — the whole point");
  say("-".repeat(72));

  say(`\n  top-level keys: ${Object.keys(specs).join(", ")}`);
  const groups = specs.specialization_groups || [];
  say(`  specialization_groups: ${typeOf(groups)}`);

  const raw = JSON.stringify(specs, null, 2);
  if (raw.length <= 14000) {
    say("\n  FULL RESPONSE (it is small enough to show entirely):\n");
    say(raw.split("\n").map((l) => "    " + l).join("\n"));
  } else {
    say(`\n  (full response is ${raw.length} bytes — showing structure + first group)\n`);
    outline(specs, "    ", 0, 1);
    if (groups.length) {
      say("\n  FIRST GROUP, VERBATIM:\n");
      const g = JSON.stringify(groups[0], null, 2);
      say((g.length > 12000 ? g.slice(0, 12000) + "\n… truncated" : g)
        .split("\n").map((l) => "    " + l).join("\n"));
    }
  }
}

/* ---- write it out ------------------------------------------------------- */
const file = path.join(process.cwd(), "armory-digest.txt");
fs.writeFileSync(file, out.join("\n"));
console.log(`\n\nWritten to ${file} — send that file if it is easier than pasting.`);
