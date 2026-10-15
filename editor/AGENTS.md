# Working on maps as an agent

The map editor and you edit the **same file**, `maps/<id>.spec.json` in a mod. The page reloads it within about two seconds of a save, so the
person sees your changes appear and can keep adjusting by hand. They are usually not experienced with RPG Maker: explain in plain words, keep
changes small, and say what you did.

## The loop

1. **Read** the spec (`maps/<id>.spec.json`). Format: "Making new maps and events" in `docs/MODDING.md`.
2. **Look** at it: `cd browser && bun run mod map shot <mod> <id> --zoom 0.5 --out /tmp/m.png`, then read the PNG.
   Yellow numbers on the edges are tile coordinates. Walls are tinted red, events are numbered boxes or their sprites.
3. **Find things to copy**: `bun run mod map list <words>` finds game maps by name; `bun run mod map shot --game <id> --zoom 0.5 --out /tmp/g.png`
   shows one with tile numbers, so a stamp rectangle `[x, y, w, h]` can be read off the picture. Ready-made pieces: `editor/library.json`.
4. **Edit the spec** (stamps first, then `blocked` rows, then `events`). Prefer **stamps** from real game maps over painting single tiles.
5. **Look again** (step 2) and fix what is off. Check `bun run mod check <mod>`: map errors fail it.
6. Tell the person to press **BUILD** in the editor (or run `bun run mod map build <mod>`) when they are happy, then reload the game and press F9 to teleport.

## Rules

- Edit only the spec. Never hand-edit `files/` for a spec map (BUILD rewrites it) and never touch the game install.
- Map ids are 1000 or higher and must not collide with another map in the mod (`files/maps/map<id>.json`, even ones other tools built).
- If the person has **unsaved edits** in the editor, saving over their file loses them. The prompt they paste tells you; if it says so, ask them to save first.
- Do not run `bun run mod map build` on a mod whose maps are built by its own scripts (SUNBURN): it refuses to overwrite a MapInfos patch it did not write, which is correct. Those maps are **taken over** in the editor instead (see below).
- Dialogue text in `say` is the person's story. Draft at most; they decide what is said (see the `omori-modding` skill).

## Maps another tool builds (SUNBURN)

SUNBURN's maps come from `omori-fanfic-mod-project/tools/parts/*/build.ts`. In the editor a person can press **EDIT THIS MAP** on one. That:

- copies the script's output to `maps/.base/<id>.tiled.json` and `<id>.data.json` (not `map<id>.json`/`Map<id>.json`: those are the same name on macOS and Windows), and
- writes `maps/<id>.spec.json` with `"snapshot": true`. Your edits (stamps, `paint`, `blocked`, `events`, `removeEvents`, `moveEvents`) sit on top of the snapshot.

`tools/lib.ts` (`writeOut`/`copyOut`) sends a taken-over map's script output to the snapshot instead of `files/`, and `tools/build.ts` merges the
spec back on top at the end. So script changes and hand edits both survive. Do not delete `maps/.base`. **GIVE BACK TO THE SCRIPTS** in the MAP tab undoes it.
Events the script made keep their steps; you can move (`moveEvents`) or remove (`removeEvents`) them, and add new ones, but their dialogue is the script's.

## Spec extras the editor understands

- `paint` entries with `"editor": true` belong to the editor (it rewrites them on save). Hand-written `paint` entries are left alone.
- `paint: { layer, erase: true, rect }` clears tiles.
- `blocked` rows: `#` blocked, `.` open, anything else leaves the tile alone.
- `moveEvents: { "<eventId>": [x, y] }` moves a base map's event, keeping its pages. Only for maps with `base` or `snapshot`.

## Commands

| | |
|---|---|
| `bun run mod map list [text]` | find game maps by name or number |
| `bun run mod map shot <mod> <id> [--zoom 0.5] [--out f.png] [--grid] [--no-walls] [--no-events] [--no-ruler]` | picture of a mod map |
| `bun run mod map shot --game <id> ...` | picture of a game map |
| `bun run mod map show <mod> <id>` / `--game <id>` | ASCII picture, no browser needed |
| `bun run mod map build <mod>` / `bun run mod check <mod>` | compile / validate |

`map shot` needs Google Chrome (set `CHROME` to its path if it is somewhere unusual).
