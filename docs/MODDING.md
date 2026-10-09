# Modding OMORI in the browser

Mods never touch your game folder. They are layered on top of it in the browser, and every profile keeps its own saves, so trying a mod can't hurt the ones you already have.

## For players

1. Start the game (`start.bat`) and **drag a mod `.zip` (or a mod folder) onto the page**. Or press **F8** → *choose a zip…*.
2. Choose what to do with it:
   - **Try in a new profile** (recommended): makes a separate profile with its own saves. You can copy your current saves into it to continue where you left off, or start fresh.
   - **Add to this profile**: turns it on here. In the *Original game* profile this asks first and takes a backup.
3. The page reloads and the mod is active. Press **F8** any time to manage things.

**Profiles** (like Minecraft launcher profiles). *Original game* holds the saves you had before mods existed. Each other profile has its own save storage and its own list of enabled mods; the mod library is shared. Switching profiles never overwrites anything: the profile you leave gets an automatic backup first. `?profile=<id>` in the address opens one directly.

**Backups.** Automatic before switching or deleting a profile, and before enabling a mod in the original one. You can also back up manually, download saves as a `.zip`, and import them. The last 5 per profile are kept. Backups live in your browser's storage, so *Download saves* is the way to keep a copy outside it.

**When something breaks.** A red badge on the Mods tab means a mod reported an error; the panel names the mod and shows the message. A broken mod never stops the game from starting. Add `?mods=0` to the address to start with no mods at all. Errors are also written to `latest.log` next to the server.

**OneLoader / GOMORI mods** (`manifestVersion: 1`) install the same way. See *Compatibility* below for what is and isn't supported.

## For mod authors

```
bun run mod dump          # decrypt the game into ./dump (json / yml / js) so you can read it
bun run mod find "STEAK"  # grep the dump: shows file:line
bun run mod new my-mod    # scaffold ./mods/my-mod
bun run mod check my-mod  # validate + dry-run every edit against the real game files
bun run mod pack mods/my-mod   # -> my-mod.zip to share
```

Mods in `./mods` (folders or `.zip`) are the **dev folder**: they show up in the library on every load. Tick *Load every mod from the dev folder automatically* in a profile, and open the game with `?hot=1` to reload whenever you save a file.

### Layout

```
my-mod/
  mod.json
  files/      full replacements, mirroring the game's www/ folder
  patches/    edits to existing game files (survive game updates better than replacing)
  scripts/    JavaScript that runs in the browser
```

`mod.json`: `id` (lowercase, `a-z 0-9 . _ -`), `name`, `version`, optional `description`, `author`, `dependencies: ["other-id"]` (loaded first; the mod is disabled with a clear message if missing), `loadAfter: [...]`, and `scripts: [{ "file": "scripts/a.js", "phase": "post-plugins" }]` (otherwise every `scripts/*.js` runs at `post-plugins`). Unknown keys produce a warning, so typos get caught.

### The game's files are encrypted; you edit plain ones

You write plain files; the loader decrypts, edits and re-encrypts for you.

| In your mod | Edits the game file |
|---|---|
| `data/Items.json` | `data/Items.KEL` |
| `maps/map5.json` | `maps/map5.AUBREY` |
| `data/Quests.yml` | `data/Quests.PLUTO` |
| `languages/en/<name>.yml` | `languages/en/<name>.HERO` (all dialogue) |
| `js/plugins/<name>.js` | `js/plugins/<name>.OMORI` (the game's own plugins) |
| `img/…`, `audio/…`, `movies/…`, `fonts/…`, `js/rpg_*.js` | same path (served by a service worker) |

Putting a file under `files/` replaces the game file. Adding a name the game doesn't have creates a new one (a new map, a new language file).

### Patches (`patches/<path>.patch.json` or `.merge.json`)

- **JSON / YAML targets**: `*.patch.json` is an [RFC 6902 JSON Patch](https://jsonpatch.com) array; `*.merge.json` is an RFC 7386 merge patch.
  `patches/data/Items.json.patch.json`:
  ```json
  [ { "op": "test",    "path": "/2/name", "value": "COLD STEAK" },
    { "op": "replace", "path": "/2/name", "value": "WARM STEAK" } ]
  ```
  Start with a `test` op: if a game update changes the data, you get an error instead of silently patching the wrong thing.
- **JS targets** (`js/plugins/*.js`, `js/rpg_*.js`): `*.patch.json` is a list of `{ "find", "replace", "all"?, "regex"?, "flags"?, "optional"? }`. A `find` that doesn't match is an error.
- Several mods can patch the same file; patches apply in load order. Two full replacements of the same file conflict: the later wins and a warning is logged, so prefer patches.
- A patch that fails is **skipped and logged** (mod, file, op number, reason); the rest of the mod still loads.

### Scripts and the `OmoriMod` API

Scripts are classic browser scripts, and **all mods' scripts share one global scope**: wrap yours in `(() => { ... })();` or a top-level `const mod` will clash with another mod's and the later one fails to load. Boot phases: `early` (before any game code), `pre-plugins`, `post-plugins` (default: the game's classes exist, nothing has started), `ready`. Types: `types/omori-mod.d.ts`.

```js
(() => {
const mod = OmoriMod.scope();                       // bind logs and errors to your mod

mod.on('map:setup', mapId => { /* ... */ });        // also: scene:goto, game:new, game:load, game:save
mod.hook(Game_Party.prototype, 'gainGold', function (orig, amount) {
  return orig(amount * 2);                          // wraps the original method safely
});
mod.command('mymod.heal', (args, interp) => { /* event Plugin Command */ });
mod.warn('shows in the panel'); mod.error(err, 'while doing X');
})();
```

```js
// Settings: appear on the Settings screen's Mods tab, saved per profile.
const power = mod.settings.add({ id: 'power', type: 'slider', label: 'Power', min: 0, max: 10, default: 5,
  onChange: v => { /* runs on load and on every change */ } });
power.get();   // current value
// also type: 'toggle' (default: boolean) and type: 'choice' (options: [{ value, label }])
```

`type: 'action'` adds a button instead of a value: `mod.settings.add({ id: 'go', type: 'action', label: 'Do it', button: 'Go', run() { ... } })`.

**New Game+** is an example mod built on all of this (`examples/newgame-plus`): *Settings > Mods > Start New Game+*, or the plugin command `ngplus.start`, begins the story again and carries over
levels/experience, learned skills, equipment, items and gold (each has its own toggle). It saves a checkpoint of the game you are leaving first, so nothing is lost; from the title screen it uses your most recent save.
It also keeps a cycle counter (`NewGamePlus.cycle()`), stored in the save.

Everything done through `mod.*` is wrapped: an exception is reported against your mod and the game carries on (a hook that throws runs the original instead and switches itself off after 10 errors). Uncaught errors and rejections in your script are attributed to the mod from the stack trace (`omori-mod://<id>/<file>` appears in DevTools as the source name, so you can set breakpoints in it). Game errors and `console.error/warn` are forwarded to `latest.log` too.

Debugging tips: F9 is the built-in debug panel (teleport, switches, variables, items). `$gameVariables`, `$gameSwitches`, `$dataMap` etc. are available in the DevTools console. Story mods are mostly dialogue (`languages/en/*.yml`), map events (`maps/*.json`) and common events (`data/CommonEvents.json`): `dump` and `find` show how the base game does it.

## Making new maps and events (no RPG Maker, no Tiled)

A map is three things the game reads: Tiled-format tile layers (`maps/map<ID>.json`), RPG Maker map data with events
(`data/Map<ID>.json`), and an entry in `data/MapInfos.json`. You describe the map in one small file and the compiler writes all of them.

```
bun run mod new my-story
bun run mod map show --game 13                      # ASCII picture of a real map: # blocked, . drawn, letters = events with a legend
bun run mod map new my-story 1001 "My Street" 34x12 # starter mods/my-story/maps/1001.spec.json
bun run mod map build my-story                      # compile every maps/*.spec.json into files/, languages and patches
bun run mod map show my-story 1001                  # look at the result
bun run mod check my-story                          # also dry-runs the specs; map errors fail the check
```

Use ids of 1000 or more (the game uses up to 999). The compiler refuses an id the game already uses.

`maps/1001.spec.json`:

```json
{
  "id": 1001, "name": "MY STREET", "size": [34, 12], "tilesFrom": 13,
  "stamps": [{ "from": 13, "rect": [3, 9, 34, 10], "at": [0, 1] }],
  "blocked": ["#.#"],
  "bgm": "some_bgm_name",
  "events": [
    { "name": "Guide", "x": 12, "y": 6, "sprite": "FA_KEL", "pages": [
      { "do": [ { "say": ["Hello!", "Talk to me again."] }, { "self": "A" } ] },
      { "if": { "self": "A" }, "do": [ { "say": "Welcome back." } ] }
    ] },
    { "name": "Exit", "x": 32, "y": 6, "trigger": "touch", "do": [ { "transfer": { "map": 13, "x": 11, "y": 10 } } ] }
  ]
}
```

- **Art**: you do not pick tile ids. `stamps` copy a rectangle (every layer, collision included) from any existing map, remapping tileset ids for you.
  Find rectangles with `map show --game <id>` (it has a coordinate ruler). `tilesFrom` chooses the base map whose tilesets and layer structure are used.
- **Collision**: `blocked` rows set `#` blocked / `.` open on top of what was stamped; other characters leave a tile alone.
- **Your own tiles**: put a PNG of 32x32 tiles at `files/img/tilesets/MYTILES.png`, list it as `"tilesets": [{ "name": "MYTILES" }]`, and place tiles with
  `"paint": [{ "layer": "ABOVE ALL - IV", "tileset": "MYTILES", "tiles": [[0, 1], [2, 3]], "at": [14, 2] }]`
  (`tiles` is a grid of local tile numbers, left to right and top to bottom in the PNG, `null` = leave empty; or `"tile": 0` with a `rect`/`at` to fill). `paint` also works with the game's own tilesets.
  Layer names are the game's (`GROUND - I` ... `ABOVE ALL - IV`); a wrong name lists the valid ones. Use `blocked`, not `paint`, for collision.
- **Editing a game map**: `"base": 217` with `"id": 217` changes that map in place. Its tiles, collision and events are kept; your `stamps`/`paint`/`blocked` are applied on top,
  `events` are added (new ids after the existing ones) and `"removeEvents": [2]` deletes events by id. `"base": 13` with a new `id` clones a map under a new id instead.
  Replacing a game map writes the whole map file, so two mods that edit the same map conflict (the build warns). `examples/edit-demo` does this.
- **Events**: `trigger` is `action` (default), `touch`, `event-touch`, `auto` or `parallel`; `priority` is `below`, `same` or `above`; several `pages` work like RPG Maker pages.
  A page `if` supports `switch` (one or two), `self`, `item`, and `variable: [id, ">=", n]` (the only comparison RPG Maker pages have). Use an `{ "if": ..., "then": [...] }` command for anything else.
- **Commands** (`do`): `say`, `switch`, `variable` (`op`: set/add/sub), `self`, `gold`, `item`, `transfer`, `wait`, `se`, `bgm`, `common`, `plugin` (any plugin command, e.g. `"CallEvent 2, Page 2"`), `script`, `comment`, `fade`, `erase`, and `if`/`then`/`else`.
  `say` text is written to `languages/en/<mod>_map<ID>.yml` and shown with the game's own `ShowMessage`.
- **Sprites**: use a game sprite name (`FA_KEL`) or add your own PNG at `files/img/characters/NAME.png` (works with no atlas step; `!`/`$` name prefixes keep their normal meaning).
- The build **warns** about: touch events on blocked tiles, unknown sprites, transfers to maps that do not exist, unknown common events and out-of-range switches.
  It **fails** (and writes nothing) for bad ids, sizes, stamp rectangles, events outside the map and page conditions RPG Maker cannot express.
- `examples/story-demo` is a complete working example; `test/story-demo.ts` plays it in a real browser.

## Checkpoints

Debug panel (**F9**) > *checkpoints*: capture the whole game under a name, see every switch/variable/item/level/location difference between a checkpoint and now,
restore it, or export/import it as a file. Restoring first takes an automatic "(auto) before restoring ..." checkpoint (the newest 10 are kept), and it is refused
if the checkpoint is corrupt or incomplete. Checkpoints are stored per profile. A checkpoint is the same data as a save file, so it keeps working for anything a save does.

**Story beats.** *Settings > Gameplay > Record story beats as checkpoints* (off by default) saves a checkpoint named `[beat] Day1FA - Hobbeez`, `[beat] Day2DW - Swim`, ... the first time each of the game's
story switches turns on (about a hundred of them, plus the ending flags), once the current event has finished so the state is stable. One normal playthrough builds a library you can jump around in
(F9 > checkpoints, with a name filter). A full-game checkpoint is gzipped to roughly 30 KB, so 200 of them fit easily; the newest 200 beats are kept.

**Shipping checkpoints in a mod.** The *script* button next to a checkpoint downloads a ready-made mod script that calls `OmoriMod.checkpoints.register(name, data)`. Drop it in the mod's `scripts/` folder
and that checkpoint shows up (tagged with the mod's name, read-only) for everyone who enables the mod. This is how a "skip to the end" mod is built:

1. Play normally with beat recording on; use *capture* for anything the beats miss (the start of the final chapter, say).
2. In the panel, press *script* on the checkpoint you want to offer, and save it as `scripts/end-stage.js` in your mod.
3. Add a button for it:

```js
(() => {
  const mod = OmoriMod.scope();
  mod.settings.add({ id: 'skip', type: 'action', label: 'Skip to the final chapter', button: 'Skip', run: () => OmoriMod.checkpoints.restore('Final chapter') });
})();
```

Restoring takes an automatic undo checkpoint first, and the real saves are never touched (use a profile to be extra safe).

**Routes.** The game tracks the story with named flags, not a chapter variable; `docs/STORY-MODEL.md` documents what they are and how this tooling uses them. In short: checkpoints show their story position and route,
the header counts story beats captured, `OmoriMod.checkpoints.compare(a, b)` gives the flag differences between two checkpoints, and `forge(base, patch, name)` builds a new checkpoint by patching flags
(ids or exact names), which is how you recreate a route without replaying it.

From a mod script (or a test): `await OmoriMod.checkpoints.capture('before boss')`, `.list()`, `.restore('before boss')`, `.diff('before boss')`, `.remove(...)`.
Diffing two moments of a real playthrough is how you find out which flags a chapter really sets, instead of guessing.

## Settings (for everyone)

Press **F10** at any time, or choose *Options* on the title screen or in the in-game menu. It replaces the game's built-in options screen. Tabs: Gameplay, Display, Audio, Controls, Accessibility, Mods (settings added by mods) and System. Search with `/`; keyboard (↑↓ ←→ Enter Esc, `[` `]` for tabs), mouse and gamepad all work. Every setting has a ↺ reset button.

Everything the original options screen controlled is still on the game's own `ConfigManager`, so existing saves and config files keep working. Additions:

- **Gameplay**: game speed (up to 3x), hold **F** to fast-forward (2x to 8x), battle text speed, menu animations, battle camera, skip the intro screens (including the content warning, so off by default), warn before closing the tab mid-game.
- **Display**: fullscreen, widescreen maps, render quality (1x to 4x), smooth or sharp pixel scaling, FPS counter, hide idle cursor, screenshots (**F7**).
- **Audio**: the four game volumes, plus what to do when the tab loses focus (pause, which is the original behavior; run muted; keep playing).
- **Controls**: rebind keyboard keys (several per action, conflicts handled, required actions can't be left without a key) and gamepad buttons; button prompts can follow the device you last used.
- **Accessibility**: screen effects on/off and strength, visual filters, and a one-click *Reduce flashing & motion*. These options existed in the game but were never shown.
- **System**: export/import all settings as a file, reset everything (saves untouched), copy diagnostics for bug reports, load game / return to title.

Settings are stored in the game's config file (`omoriWeb` section), which lives in the active profile's own save storage, so each profile has its own settings.

## Notes for AI agents

- Don't read the game folder directly: run `bun run mod dump` once and read `./dump` (plain JSON/YAML/JS), then `bun run mod find <text>`.
- Prefer `patches/` with a leading `test` op over `files/` replacements.
- Loop: edit → `bun run mod check <mod>` (must exit 0) → open `http://127.0.0.1:8080/?hot=1` → read `latest.log` (every mod error and game error lands there with the mod id).
- To verify in a real browser, `test/mods.ts` shows the pattern: install a zip through the panel's file input, reload, and assert on game globals (`$dataItems`, `SceneManager._scene`).
- For new maps/NPCs/dialogue write a `maps/<id>.spec.json` and run `bun run mod map build <mod>` (see "Making new maps and events"); use `mod map show` to look at a map as text instead of guessing tile ids.
- To test from a known game state, use `OmoriMod.checkpoints` (capture once, restore at the start of each test run).
- Never edit anything under `OMORI.Build.*`; it is the player's install and is read-only by design.

## Compatibility with OneLoader / GOMORI

Supported, from the v1 manifest schema: `files.data`, `data_pluto`, `text`, `maps`, `plugins` (full replacements; files found at `<folder>/<name>` or `<name>`), `files.asyncExec` with `runat` mapped to boot phases (`pre_plugin_injection` → `pre-plugins`, `pre_game_start` → `post-plugins`, the others → `early`), and loose asset overrides (`img/`, `audio/`, …).

Not supported yet; the mod loads and the unsupported part is skipped with a visible warning: the legacy delta formats (`*_delta`: `.jsond`, `.ymld`, `.jsd`), `image_deltas` (`.olid`), `plugin_parameters`, `exec` and the `*_require` run-at modes (Node scripts). Mods that depend on those will only partly work.

This was built against the published manifest schema and tested with synthetic v1 zips. It has **not** been tested against mods downloaded from the wild yet. If one misbehaves, `latest.log` and the Mods panel say which part was skipped.

## How it works

- `src/mods/` is shared by the browser and Bun: manifest parsing, the patch engine, AES-CTR with the game's own key (read from your `Launch_OMORI.bat`), and the engine that answers "what are the bytes of game file X with all mods applied?".
- In the page, `src/client/shim/fs.ts` asks the engine on every read of an encrypted file, so the game's own loader gets modded data without knowing. `src/sw.ts` (a service worker) does the same for images, audio and plain scripts.
- Mods are zips in IndexedDB (`omori-mods`); profiles, backups and the active profile live there too. Each profile's saves are in a database of their own (`omori-fs` for the original, `omori-fs:<id>` otherwise).
