# How OpenOMORI works

OMORI is an [RPG Maker MV](https://tkool.jp/mv/index.html) game packaged for desktop with [NW.js](https://nwjs.io/), which is Chromium plus Node.js.
Almost all of the game is JavaScript and data that already runs in a browser; what it relies on from the desktop shell is small: Node's `fs`, `path` and `process`, a few `nw` calls, and Steam initialisation.
OpenOMORI keeps the game's code and data untouched and replaces that thin layer.

```
 your OMORI folder (read-only)          Bun dev server (127.0.0.1)                  Chrome tab
 ┌──────────────────────────┐   HTTP    ┌─────────────────────────┐   HTTP    ┌─────────────────────────────┐
 │ www/ js, data (.KEL …),  │ ───────▶  │ static files, case-fix, │ ───────▶  │ shims: fs, nw, process, ...  │
 │ img, audio, languages    │           │ Range, /__config, /__ls │           │ the game's own scripts       │
 │ Launch_OMORI.bat (key)   │           │ /__mods/*, /__story.json│           │ mod engine, settings, tools  │
 └──────────────────────────┘           └─────────────────────────┘           │ saves → IndexedDB            │
                                                                              └─────────────────────────────┘
```

## Pieces

| Part | Where | What it does |
|---|---|---|
| Dev server | `src/server.ts` | Serves your install read-only on `127.0.0.1` (case-insensitive paths, HTTP Range for audio and video), the built client bundle, a directory listing, the decryption key, the dev mods folder, and the story scan. Asks for the game folder on first run (`src/gamedir.ts`). |
| Shims | `src/client/shim/` | A fake `fs` (reads over HTTP, writes to [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)), `path`, `process`, `nw`, AES-256-CTR via [aes-js](https://github.com/ricmoo/aes-js), and a stub for Steam so a retail copy can start outside Steam's launcher (achievements and cloud saves are no-ops). |
| Boot | `src/client/boot.ts` | Loads the game's scripts in their original order, installs the mod runtime, patches, settings and debug tools at the right points, then starts the game's `Scene_Boot`. |
| Display | `src/client/display.ts`, `cutscene.ts` | Widescreen map view (more world at the sides, same height), 1x to 4x internal resolution with smooth downsampling, and centring of cutscene pictures in the wide view. |
| Mod engine | `src/mods/` | Shared by Bun and the browser. Parses `mod.json`, applies JSON/merge patches and text patches, encrypts and decrypts, and answers "what are the bytes of game file X with all mods applied?". |
| Mod runtime | `src/client/mods/` | Profiles and backups in IndexedDB, the mod manager UI (F8), the `OmoriMod` scripting API with error attribution, OneLoader compatibility. |
| Service worker | `src/sw.ts` | Serves mod-replaced images, audio and plain scripts, so the game loads them like its own. |
| Settings | `src/client/settings/` | A registry of settings that the F10 screen renders, stored in the game's own config file so they follow the profile. Mods can add settings. |
| Map and event compiler | `src/mods/mapkit.ts` | Turns a `maps/<id>.spec.json` into the Tiled map, RPG Maker event data, dialogue and `MapInfos` patch. |
| Checkpoints and routes | `src/client/checkpoints.ts`, `checkpoint-core.ts`, `story-model.ts` | Whole-game snapshots, diffing, restore, forging, story beats and route labelling. |
| Story scanner | `src/mods/storyscan.ts` | Reads every map event in your install and indexes how the story flags are set and used (`bun run mod routes`). |
| CLI | `src/cli.ts` | `dump`, `find`, `new`, `check`, `pack`, `map …`, `routes`. |

## The game's files

The game's data is encrypted and its extensions say what is inside:

| Game file | Plain form you edit in a mod |
|---|---|
| `data/Items.KEL` | `data/Items.json` |
| `maps/map5.AUBREY` | `maps/map5.json` (a [Tiled](https://doc.mapeditor.org/en/stable/reference/json-map-format/) map) |
| `languages/en/<name>.HERO` | `languages/en/<name>.yml` |
| `js/plugins/<name>.OMORI` | `js/plugins/<name>.js` |
| `data/*.PLUTO` | `data/*.yml` |
| images and audio (`.rpgmvp`, `.rpgmvo`) | PNG / OGG at the same path |

The key comes from your own `Launch_OMORI.bat` (the game's launcher passes it on its command line). The server reads it when it starts and hands it to the page on `127.0.0.1`; nothing is written to disk or to this repository.

## Mods in the loading path

1. Mods live as zips in IndexedDB (or in the dev folder). A profile lists which are enabled and owns its own save database.
2. When the game reads an encrypted file, the fake `fs` asks the mod engine for the bytes with every enabled mod applied, so the game's loader never knows.
3. Patches that no longer match the game (a `test` op that fails, a `find` that is missing) are skipped and reported against the mod; the rest of the mod still loads.
4. Mod scripts run in phases (`early`, `pre-plugins`, `post-plugins`, `ready`) through the `OmoriMod` API, which wraps hooks and handlers so one broken mod logs an error instead of ending the game.

## Why the story tools work the way they do

Checkpoints are the game's own save contents (`DataManager.makeSaveContents`) gzipped, plus a readable digest for diffing, so anything a normal save keeps, a checkpoint keeps. Restoring goes through the game's own load path. Story and route logic is keyed on the **names** of flags in the game's database, so it does not depend on ids staying the same. Details and the research behind it are in [STORY-MODEL.md](STORY-MODEL.md).

## Tests

`bun run test` builds, then runs the unit tests (`bun test src`) and a set of end-to-end scripts in `test/` that start the server and drive real Chrome with [Puppeteer](https://github.com/puppeteer/puppeteer): boot, the debug panel, checkpoints, mods, settings, the example mods. They need Chrome and your OMORI install; CI runs only the checks that need neither.
