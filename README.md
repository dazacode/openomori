# omori-web

A browser port of **your own copy** of OMORI (the Steam/NW.js build). This repo contains only the port's
code. **It contains no game files**; you point it at your install and it runs the game in Chrome.

OMORI is © OMOCAT / its publisher and is not included, redistributed or licensed here.

## Run

Requires [Bun](https://bun.sh), Chrome, and a legitimately obtained OMORI install (the folder with
`OMORI.exe` and `www/`).

    set OMORI_DIR=C:\path\to\OMORI.Build.xxxx      (defaults to ..\OMORI.Build.8879120)
    bun install
    bun run start                                    # or start.bat  ->  http://127.0.0.1:8080/

The server only listens on 127.0.0.1 and serves your install read-only. Saves are written to the
browser's IndexedDB, never to the game folder. The decryption key the game uses is read from your own
`Launch_OMORI.bat` at startup; it is not stored in this repo.

## What it does
- **Runs the stock game in a browser.** Shims the NW.js/Node APIs the game expects (`src/client/shim/`):
  an `fs` backed by HTTP reads + IndexedDB writes, AES-256-CTR via aes-js, `nw`, `process`.
- **Fills the window.** Map scenes render a wider view (more world at the sides, same height); menus, title and
  battles stay 4:3 and their bars take the picture's edge colour. `?wide=0` turns widescreen off.
- **Centres cutscene pictures** in the wide view and blacks out the extra world behind full-screen stills.
- **Sharper picture.** Internal resolution is 1-3x (`?q=1..4`), smoothly downsampled, instead of the stock
  stepped `pixelated` scaling.
- **Debug panel.** `F9` or `` ` ``: teleport to any map, edit switches/variables, give items, heal, no-clip,
  common events, render scale. `?debug=0` disables it.

## Steam stub
The game refuses to start unless Steamworks initialises. `src/client/shim/nw.ts` stubs it offline
(`initAPI()` returns true; achievements and cloud saves are no-ops). This exists so a player who owns the
game can run their own copy outside Steam's launcher. Use it with a copy you own.

## Layout
    src/server.ts            Bun static server (/__config key, /__ls listing, Range, case-insensitive paths)
    src/client/entry.ts      bundle entry
    src/client/boot.ts       loads the game's scripts in order, then runs Scene_Boot
    src/client/shim/         fake Node/NW.js
    src/client/display.ts    widescreen, supersampling, bar colour
    src/client/cutscene.ts   picture-layer centring
    src/client/debug.ts      debug panel
    test/                    Chrome end-to-end tests (`bun run test`; needs Chrome + a GPU)

## Status / limits
- Tested on Windows + Chrome with the Steam build v1.0.8 (title, intro, maps, dialogue, debug jumps).
  Battles, long play sessions and audio were not tested. Touch/mobile is untested.
- Maps keep the width they were built with: resizing the window on a map letterboxes until the next map change.
- Widescreen can reveal parts of a map not meant to be seen (`?wide=0` to disable).
- Startup takes ~25 s, about half of it the game's own splash screens.
