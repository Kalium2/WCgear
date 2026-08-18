# WoW Gear Check

Fetch a Burning Crusade character from Warcraft Logs, then check the
already-loaded gear against a curated Best-in-Slot list for any
Phase 3 / Phase 4 phase and Arms Warrior / Destruction Warlock /
Beast Mastery Hunter spec combination — no refetch needed between
comparisons.

## Status

This is the **Phase 1 (frontend foundation) + skeleton backend**
build:

- ✅ Character fetch form, character card, phase/spec selectors, results UI
- ✅ Comparison engine, including the reusable multi-slot ranking system
  used for both Trinket ×2 and Finger ×2 (see `resolveMultiSlot` in `app.js`)
- ✅ Realm normalization, spec-mismatch warning, error states
- ✅ Cloudflare Worker skeleton with OAuth client-credentials flow for
  both Warcraft Logs and Blizzard
- ✅ `data/bis.json` now has **real item IDs** sourced from Wowhead (Arms Warrior) and Warcraft Tavern (Destruction Warlock, Beast Mastery Hunter) Phase 3/4 guides — see the dataset's `_readme` field and the note below for what to double check
- ⚠️ The Worker's GraphQL query and gear-mapping logic are written to
  the documented API shape but **not yet tested against a live
  response** — do this once your credentials are in place
- 🔲 Not yet wired: Worker deployment, real BiS curation, Blizzard icon
  rendering (currently shows item IDs as a placeholder chip)

Until a Worker is deployed and `WORKER_URL` is set in `app.js`, the
site runs in **demo mode** with sample gear so you can exercise the
full fetch → compare → results flow immediately by opening
`index.html`.

## Project structure

```
wow-gear-check/
├── index.html              Character form, results UI
├── style.css                WoW-tooltip-inspired visual language
├── app.js                   State, fetch logic, comparison engine
├── data/
│   └── bis.json              Curated BiS dataset (placeholder — see below)
├── cloudflare-worker/
│   └── worker.js             OAuth + API proxy, deploy separately
└── README.md
```

## Getting it running locally (demo mode)

No build step. Just open `index.html` in a browser, or serve the
folder:

```bash
cd wow-gear-check
python3 -m http.server 8080
# visit http://localhost:8080
```

Try any character name/realm — you'll get sample Arms Warrior gear
back. Enter `NotFound` as the character name to see the
character-not-found error state.

## Wiring up the real APIs

### 1. Get credentials

- **Warcraft Logs**: create a v2 API client at
  https://www.warcraftlogs.com/api/clients/ → gives you a Client ID
  and Client Secret for the OAuth 2.0 client credentials flow.
- **Blizzard**: create a client at
  https://develop.battle.net/access/clients → gives you a Client ID
  and Client Secret for the Game Data APIs.

**Send me these values (or set them directly as Worker secrets,
below) and I'll finish wiring up and testing the live integration
against real responses.**

### 2. Deploy the Cloudflare Worker

```bash
cd cloudflare-worker
npx wrangler init --from-dash false   # or `wrangler deploy` if you already have a project
wrangler secret put WARCRAFTLOGS_CLIENT_ID
wrangler secret put WARCRAFTLOGS_CLIENT_SECRET
wrangler secret put BLIZZARD_CLIENT_ID
wrangler secret put BLIZZARD_CLIENT_SECRET
wrangler deploy
```

Edit `ALLOWED_ORIGIN` at the top of `worker.js` (or set it as an
`ALLOWED_ORIGIN` environment variable) to your GitHub Pages origin so
CORS is locked down in production, per spec section 38.

### 3. Point the frontend at it

In `app.js`:

```js
const WORKER_URL = "https://wow-gear-check.yourname.workers.dev";
```

Demo mode automatically turns off once this is set.

### 4. Verify the Warcraft Logs query against a live response

The GraphQL query in `handleCharacter()` and the `mapWclGearToSlots()`
mapping are written to the documented v2 schema shape, but Warcraft
Logs' exact field names for equipped gear should be confirmed against
a real response before relying on it — the query in the code has a
`// NOTE` marking this. Section 9 of the spec has the docs link.

### 5. BiS data — what's real and what to double-check

`data/bis.json` is populated with real item IDs pulled from Wowhead's
Phase 3/4 Arms Warrior guides and Warcraft Tavern's Phase 3/4
Destruction Warlock and Beast Mastery Hunter guides. A few things
worth knowing before treating it as final:

- **One weapon build per spec.** Arms Warrior uses the two-handed
  "Slam" build, Destruction Warlock uses the staff build (Zhar'doom
  main-hand, Wand of the Forgotten Star ranged), and Beast Mastery
  Hunter uses the two-handed melee-weave build. The dual-wield /
  off-hand alternatives mentioned in the source guides aren't
  included — the app's `weaponConfig` model supports one build per
  spec for this MVP.
- **Rank 2+ items** are each guide's next-listed alternative, not
  independently simulated — they're reasonable "still an upgrade
  over nothing" fallbacks rather than a rigorously-ranked DPS order.
- Sourced in August 2026 — reconfirm against the live guides
  (linked in the dataset's `_readme` field) if a content patch has
  landed since.

The structure (ranked arrays with `itemId` + `rank`) already supports
adding more ranks, alternate builds, or additional specs without any
code changes — it's a data-only task from here.

## How the comparison engine works

Three inputs, one engine (spec section 47):

```
Warcraft Logs  →  what the character currently has
User selection →  which phase + spec to evaluate against
BiS dataset    →  what they should have for that phase + spec
```

Single-item slots (head, chest, weapons, etc.) are compared directly:
equipped item ID is either in the BiS list (🟢 BiS) or it isn't
(🔴 Upgrade → shows the top-ranked recommendation).

Trinket and Finger both go through the same generic
`resolveMultiSlot()` function rather than separate hardcoded logic,
per spec section 19:

1. Any equipped item that's on the ranked BiS list gets its own
   position, best rank first.
2. Remaining positions get filled with the next-highest-ranked BiS
   item the character doesn't already own.
3. An item the character already has is never recommended again to
   fill another identical slot.

## What's deliberately out of scope right now

Matches spec section 43: additional phases/expansions/classes beyond
the initial three, live WoWHead scraping, accounts, database, custom
caching, saved characters/gear history, realm autocomplete, and
class-aware spec filtering (the dropdown currently shows all three
specs with a ✓ hint next to the ones matching the detected class —
full filtering is flagged as post-MVP in section 44 and the
`CLASS_SPEC_MAP` config in `app.js` is already shaped for it).
