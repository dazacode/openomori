# Map editor

A visual editor for OpenOMORI mod maps. No RPG Maker, no Tiled.

```
bun run start          # then open http://127.0.0.1:8080/editor/
```

It is a front end for the map compiler (`src/mods/mapkit.ts`). It reads and writes `maps/<id>.spec.json` in a mod, and asks the
compiler what the result looks like, so the picture you see is what the game gets. You can still edit the spec by hand.

## Using it

1. Pick a mod (any folder in `mods/` or `examples/` with a `mod.json`; make one with `bun run mod new my-story`).
2. **MAP ▾ → New map**, or **Edit a game map** (replaces the game's map as a whole file).
3. **STAMP** is the quickest route to good-looking maps: pick a rectangle on any game map, click to copy it onto yours.
   Tiles *and* walls come across, with the tileset ids already remapped.
4. **TILES** + Brush/Rectangle/Fill paint single tiles. **Walls** (C) blocks and opens tiles. **Events** (N) places NPCs, doors and triggers.
5. **SAVE** (Ctrl+S) writes the spec. **BUILD ▶** (Ctrl+B) saves and compiles the mod's maps into the files the game reads. Reload the game tab to see it.

`?` in the editor lists every key.

**Maps made by a mod's own scripts** (SUNBURN's, for example) are listed under *View only* in the MAP menu. You can look at them, hide layers and
browse their events, but not edit them: their build scripts rewrite the files, so an edit here would be lost on the next run.

## Making it easier

- **Starting points** when you make a map: Blank, A street, A park, A house interior. Each is copied from the game's own maps.
- **Ready-made pieces** in the STAMP tab (houses, a basketball court, rooms with stairs…), with pictures. Pick a rectangle on any game map and
  **SAVE AS A PIECE** to keep your own (`maps/pieces.json` in the mod). The built-in ones live in `editor/library.json`.
- A **NEXT** strip under the tabs says the next sensible step (place a piece, add walls, add a person, add an exit, save, build). Untick *Tips* to hide it.
- Walls, events and tiles all have one-key tools; `?` lists them.

## Working with Claude

The **CLAUDE** tab turns what you want in plain words into a request you paste into Claude Code, with the file path, the map and your current
selection filled in. Claude edits the spec file; the editor reloads it by itself (and asks first if you have unsaved edits). Claude can look at
the map with `bun run mod map shot`. See `AGENTS.md`.

## Maps made by a mod's own scripts

Listed under *View only* in the MAP menu. **EDIT THIS MAP** takes one over: your edits are kept as a spec laid on top of the script's output, and
the scripts keep working (SUNBURN's `tools/lib.ts` and `tools/build.ts` know about this). **GIVE BACK TO THE SCRIPTS** undoes it.

## What is saved

Painted tiles are saved as `paint` entries tagged `"editor": true`; the editor turns exactly those back into editable tiles on
the next load and leaves hand-written `paint` entries alone. Erasing uses `{ "erase": true, "rect": [...] }`. Collision edits
become `blocked` rows (`#` blocked, `.` open, blank = leave alone). Events are stored as normal event specs, as `pages`.

## Safety

- Writes go only to `maps/<id>.spec.json` and the compiler's own outputs inside the chosen mod. The game install is never written.
- Write requests need an `x-omori-editor` header, which a web page on another origin cannot send, so a random site cannot edit your mods through the local server.
- The build refuses to overwrite a `patches/data/MapInfos.json.patch.json` that lists maps the compiler did not make
  (for example SUNBURN's, which registers its own maps), and new ids are never taken from maps another tool already built.
- The game's maps and images are encrypted; the server decrypts them for the page on demand and nothing from the install is stored in this folder.

## Layout

| File | Job |
|---|---|
| `server.ts` | HTTP API (mods, game maps, decrypted tileset and sprite images, preview, save, build) |
| `public/spec.js` | Pure helpers: tile overrides ⇄ `paint`, collision grid ⇄ `blocked`. Unit tested (`spec.test.ts`) |
| `public/store.js` | State, undo history, every edit |
| `public/canvas.js` | The map view, tools and mouse handling |
| `public/panels.js`, `events.js`, `commands.js` | The right-hand tabs, the event form, the step editor |
| `public/main.js` | Top bar, dialogs, keys |

Deep links: `/editor/?mod=NAME&map=ID` opens a map, `&game=ID` shows a game map read-only.

Tests: `bun test editor` (helpers) and `bun run test/editor.ts` (drives the real page in Chrome against a throwaway mod).
`bun run test/editor-shots.ts` writes screenshots of the dialogs to `test/out/`.

## Not done yet

Autotiles and shadows (use stamps), importing RPG Maker projects, move routes for wandering NPCs, picking audio from a list, shops and battles as steps, and editing the *steps* of events a script made (you can move, remove and add events on a taken-over map, but their dialogue stays the script's).
