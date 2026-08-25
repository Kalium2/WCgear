/**
 * patch-fightselect.js - pick a fight that actually has players in it.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * THE BUG: resolveFightAndPlayers defaulted to fights[fights.length - 1] -
 * the LAST fight in the report, whatever it happens to be. Guilds routinely
 * end a log on trash, a wipe with no combatant info, or a stopped pull, and
 * those carry no friendlyPlayers. The roster then came back empty and the user
 * saw "No player data found in that report" for a report that was completely
 * fine - confirmed 2026-08-25, where the same report returned 25 players the
 * moment fightId=1 was named explicitly.
 *
 * THE FIX: ask WCL for a little more about each fight and pick the last one
 * that is a real boss encounter WITH players, degrading through weaker
 * conditions rather than trusting a single guess:
 *
 *   1. last boss encounter (encounterID > 0) that has players
 *   2. last fight of any kind that has players
 *   3. last fight - the old behaviour, so nothing gets worse
 *
 * ALSO HARDENED: the spec-label lookup ended in getWarlockSpec, which THROWS
 * on an unknown spec instead of returning null. Sitting a thrower at the end
 * of an `a || b || c` chain means any unresolvable spec takes the whole
 * request down with a Warlock-flavoured error message. Guarded with
 * isWarlockSpec so the chain returns null and the caller answers cleanly.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/server.js";

const EDITS = [
  // 1. Ask for the fields we need to judge a fight.
  [
    `      query ReportFights($code: String!) {
        reportData { report(code: $code) { fights { id } } }
      }`,
    `      query ReportFights($code: String!) {
        reportData { report(code: $code) { fights { id name encounterID friendlyPlayers } } }
      }`,
  ],

  // 2. Choose a fight that has players.
  [
    "    fightId = fights[fights.length - 1].id;",
    `    // The last fight is frequently trash, a stopped pull, or a wipe with no
    // combatant info - all of which have no friendlyPlayers and produced an
    // empty roster for a perfectly good report. Walk backwards to the last
    // fight that can actually answer the question.
    const hasPlayers = (f) => Array.isArray(f.friendlyPlayers) && f.friendlyPlayers.length > 0;
    const reversed = fights.slice().reverse();

    const chosen =
      reversed.find((f) => f.encounterID > 0 && hasPlayers(f)) ||
      reversed.find(hasPlayers) ||
      fights[fights.length - 1];

    if (chosen.id !== fights[fights.length - 1].id) {
      console.log(
        \`Report \${reportCode}: last fight (id \${fights[fights.length - 1].id}) had no usable \` +
        \`player data; using fight \${chosen.id}\${chosen.name ? " - " + chosen.name : ""} instead.\`
      );
    }
    fightId = chosen.id;`,
  ],

  // 3. Stop a thrower sitting on the end of a fallback chain.
  [
    "    const specName = (getShamanSpec(spec) || getClassSpec(spec) || getWarlockSpec(spec)).label;",
    `    // getWarlockSpec THROWS on an unknown spec rather than returning null, so
    // it cannot be the last link in an || chain - an unresolvable spec would
    // crash the request with a misleading "Unknown Warlock spec" error.
    const specMeta =
      getShamanSpec(spec) || getClassSpec(spec) || (isWarlockSpec(spec) ? getWarlockSpec(spec) : null);
    if (!specMeta) {
      return res.status(400).json({ error: \`Simulation isn't available for "\${spec}" yet.\` });
    }
    const specName = specMeta.label;`,
  ],
];

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("friendlyPlayers")) {
  console.log("server.js: already patched. Nothing to do.");
  process.exit(0);
}

const missing = EDITS.filter(([a]) => !src.includes(a));
if (missing.length) {
  console.error(`\nABORT: ${missing.length} anchor(s) did not match server.js.\n`);
  missing.forEach(([a]) => console.error("--- expected ---\n" + a + "\n"));
  process.exit(1);
}

for (const [a, r] of EDITS) src = src.replace(a, r);

const bak = FILE + ".bak-fightselect";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched server.js - all 3 edits applied.");
console.log("Now: node --check server.js && pm2 restart wow-gear-check");
