# How OMORI tracks the story, and how to manage routes with it

This is what the game's own data says about story progress, routes and endings, and the tooling built on it.
Everything below was derived from the Steam build (v1.0.8) by scanning every map event and common event
(`bun run mod routes` regenerates it from your install, as a report or `--json`). Where a claim is an inference
rather than something the data states, it says so.

## 1. There is no "chapter" variable; the story is a block of switches

- `Save Menu Chapter` (variable 23) is only ever set to 3 and `Title Screen Progress` (variable 6) is never set by an event.
  `Progress Variable` (variable 4) is only ever set to 0 or 1. None of them track the story.
- Progress lives in the **spine**: 99 switches (ids 961 to 1059) named `<Day|Sun|Ni><n><FA|DW> - <scene>`, in the order the
  developers authored them: `Day0DW-…`, `NiFA-…`, `Day0FA - …`, `Day1FA - …`, `SunFA1 - …`, `NiFA1 - …`, `Day1DW - …`, `Day2FA - …`,
  `SunFA2 - …`, `NiFA2 - …`, `Day2DW - …`, `Day3FA - …`. (FA = Faraway Town, the real world; DW = the Dreamworld; Sun = sunset; Ni = night.)
- 35 of the 99 are **never set by any event** (names reserved for scenes that were cut, or set some way the scan cannot see).
  The other 64, plus the late-game phase and ending switches below, are the beats a play-through can actually produce (75 flags in total).
- `Day3FA - Hero's Breakfast` (1059) and `Day2DW - Saved Basil?` (1057) are the most-used of all the story flags (433 and 344 pages/branches test them;
  `Day2FA - Errand List` is close behind at 339). They are where the world visibly changes, which makes them the natural checkpoints for a route library.

## 2. After the spine: phase flags, endings, route counters

| Kind | Names (as in the game's database) |
|---|---|
| Phase switches | `[Basil Memories]`, `[Something Battle]`, `[Blackspace]`, `[Stranger Battle]`, `[Omori Battle]`, `[Omori's Castle]`, `[Final Memories]` |
| Ending switches | `[Neutral: Epilogue]`, `Mari [Neutral Epilogue]`, `[True: Stab End]`, `[True: Bad End]`, `[Beat Boss Rush]` |
| Route counters (variables) | `[BS_NEUTRAL_PATH]`, `[BS_TRUE_PATH]`, `Stab_Counter`, `BASIL_END`, `Ending Variable`, `World Value (WS/FA/DW/BS)` |

What the data states:

- `[BS_NEUTRAL_PATH]` and `[BS_TRUE_PATH]` are **step counters through the Black Space maps**, assigned constants as the player advances
  (neutral: 0 to 10, 17, 20, 21; true: 9 to 16, 18, 19, 20, 25). Many events are gated on them (118 and 17 places).
- `[True: Stab End]` is set in one place: the `BED` event in Player's Home (Night), on its `[Something Battle]` page.
- `[True: Bad End]` is **tested in about 26 places and set by no event, script command or plugin in this build.** It is a dead flag as shipped;
  endings that depend on it can only be reached by setting it yourself (see `forge` below).
- `[Neutral: Epilogue]` is set from many places (10 setters) and tested in about 180.
- `BASIL_END` is set to 1, 2 or 3 in the "plant heart" common event, depending on which of three fear switches
  (`Day0FA - Throw Up`, `NiFA-FearofSpiders`, `Day0DW-FearofDrowning`) are off at that moment.
- **The Stab system**: switches `STAB Toggle` (4) and `TAG Toggle` (5), variable `Stab_Counter` (1 to 8) and the `★ Stab Function` common event.
  `Stab_Counter` gates the White Space door (`Day0DW - Capt. Spaceboy & Stab_Counter>=3`).
- `World Value (WS/FA/DW/BS)` (variable 22) is assigned 1 to 4 and read in 43 places; its name lists the four worlds (White Space, Faraway, Dreamworld, Black Space).

What the data does **not** say: which player choice sends the game down which route. That is decided across many events, and reading it
out of the command lists is error-prone. The reliable way to find a fork is empirical: record both sides and diff them (section 4).

## 3. The game's own story ladders ("hubs")

An RPG Maker event has pages; the **last page whose conditions hold wins**. The game uses this heavily: 14 events have 6+ pages each gated by
a different story switch, so the page order is the game's own ranking of story positions at that spot. The scanner lists them
(`bun run mod routes`). The important ones:

- `BED` (Player's Home, Night), the night-scene dispatcher: `Day0DW-Basil and Mari` < `Day0FA - Throw Up` < `NiFA1 - Go to Player home` <
  `NiFA-FearofSpiders` < `Day0DW-FearofDrowning` < `SunFA2 - Drop off Basil` < `[Something Battle]` < `Day2DW - Saved Basil?` < `[Neutral: Epilogue]`.
- `The Door` and `LAPTOP` (White Space): `Day0DW - Basil Gets Kidnapped` < `Day0FA - Throw Up` < `Day0DW - Capt. Spaceboy & Stab_Counter>=3` <
  `Day2DW - Saved Basil?` < `[Something Battle]` < `[True: Bad End]`; and for the laptop `[True: Stab End]` < `Day2DW - Saved Basil?` < `[Omori's Castle]` < `[True: Bad End]` < `[True: Stab End]`.
- Neighbour's Room (Hero, Kel, Aubrey, the teleport to White Space) and the Forest Playground mirror: the same pattern.

Order in a ladder is priority, not strictly chronology, and it differs from hub to hub (in the bed ladder `[Something Battle]` is below
`Saved Basil?`; at the White Space door it is above). Treat ladders as "what the game checks, in what order", not as a timeline.

The developers also left **test rooms** (maps 1, 5 and 6) full of events that set story flags directly (`Seat 1` turns on
`[Neutral: Epilogue]`; `stab`, `Something (True)`, `Basil` set whole groups). They are partial, and no longer maintained, but they show which flags the devs
considered "the state at this point".

## 4. Managing routes with it

The model is implemented in `src/client/story-model.ts` and keyed by the flags' **names**, so it survives id changes between builds.

**Where am I?** `OmoriMod.checkpoints.routes.current()` returns the furthest spine beat that is ON, the phase and ending flags, the non-zero route
counters, whether Basil was saved, the world, and a route label (`true` if a `[True: …]` ending or `[BS_TRUE_PATH]` progress exists, `neutral` for the neutral equivalents,
otherwise `undecided`). The label follows the developers' own flag names; it is a convenience, not a reading of the plot.

**Record a library.** *Settings > Gameplay > Record story beats as checkpoints* saves a checkpoint the first time each spine, phase or ending switch turns on,
and each new high of `[BS_NEUTRAL_PATH]` / `[BS_TRUE_PATH]` (`[beat] BS_TRUE_PATH 7`). In the debug panel's *checkpoints* tab,
each checkpoint shows its story position and route, **Order: by route** groups them into route lines (same decisions so far), and the header shows
**Story beats captured: N of 75** with a *show missing* list: that is your to-do list for completing a route.

**Recreate a route without replaying it.**

1. Play to just before a fork with recording on, and *capture* it by name (`before the fork`).
2. Continue down route A. Restore `before the fork`, play route B. Both lines are now in the library, each from the fork on.
3. `await OmoriMod.checkpoints.compare('A end', 'B end')` returns the exact switch/variable differences as a patch `{ switches, variables }`.
   (Scratch variables such as `Always Temporary #n` are filtered out.) That patch is the recipe for the difference between the routes.
4. `await OmoriMod.checkpoints.forge('some recorded checkpoint', patch, 'name')` writes a **new** checkpoint: a copy of the base with the patch applied.
   Keys can be ids or exact names (`'Day2DW - Saved Basil?': true`); unknown or ambiguous names are rejected, an empty patch is rejected, and the base is never touched.
   Forged checkpoints are tagged *forged* with what was changed. This is also how to reach states the game never sets itself, such as `[True: Bad End]`.
5. Ship the ones you want with a mod (`OmoriMod.checkpoints.register`, see `docs/MODDING.md`), so players of the mod can jump to "start of Day 3, neutral route" or "final chapter".

**Limits to keep in mind**

- A forged state is exactly as consistent as the flags you changed: if a route also depends on items, party level, map position, self-switches or something a
  plugin keeps, the patch must include or inherit them. `compare` lists those too (it shows items, levels and location as well), but verify by playing a little from a forged checkpoint.
- Beats the game turns on by scripts or plugins rather than events are not in the scan's "settable" list, so coverage can under-count them.
- The scan needs the dev server (`/__story.json`) and the player's own game files; nothing from the game is stored in this repository.

## 5. Reproducing the research

```
bun run mod routes dump/story-model.md      # the full report (spine, phase/ending flags, counters, hubs)
bun run mod routes --json                    # the same as data
bun test src/mods/storyscan.test.ts          # includes checks against your install (e.g. "[True: Bad End] is never set")
```
