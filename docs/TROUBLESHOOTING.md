# Troubleshooting

## "OMORI folder not found"

OpenOMORI needs your own copy of the game: the folder that contains `OMORI.exe` and a `www` folder (with `www/data` and `www/js` inside).

- Run `bun run start` from a terminal and paste or drag the folder in when asked. The answer is remembered in `.omori-dir` (delete that file to be asked again).
- Or set the `OMORI_DIR` environment variable to the folder (`set OMORI_DIR=C:\path\to\OMORI` on Windows, `export OMORI_DIR=...` elsewhere).
- Or put this project next to a folder whose name starts with `OMORI`; it is found automatically.
- Pointing it at the `www` folder itself works too.

If there is no terminal to ask on (for example a CI job), set `OMORI_DIR`.

## "no 32-char key found" / "cannot read ...Launch_OMORI.bat"

The game's data is decrypted with a key that the game's launcher passes on its command line. OpenOMORI reads it from `Launch_OMORI.bat` in your install. If your copy has no such file, or it has no `--<32 hex characters>` argument, the tools cannot decrypt the data. Make sure you point at a complete install; builds that keep the key elsewhere are not supported yet (issues welcome).

## The page stays black, or errors appear

- Use a current Chrome or another Chromium browser. Other browsers are untested.
- Start-up takes about 25 seconds the first time (half of it is the game's own splash screens).
- Open the browser console (F12). Errors from mods are also written to `latest.log` in the project folder with the mod's id.
- `?mods=0` in the address starts with no mods at all; `?debug=0` disables the F9 panel; `?wide=0` turns widescreen off.

## Port 8080 is already in use

`bun run src/server.ts 9000` starts it on another port (then open <http://127.0.0.1:9000/>).

## Where are my saves? Can I move them?

In your browser's storage (IndexedDB), under the active profile, not in the game folder. The Mods panel (**F8**) has *Download saves (.zip)* and *Import saves…*, and switching profiles backs up the one you leave. The debug panel (F9) *game* tab can delete every save in this browser; it asks first. Clearing the site's data in your browser also deletes saves, so export first.

## A mod does nothing or fails

- `bun run mod check <mod>` validates it and dry-runs every edit against your real game files; fix whatever it reports.
- The Mods panel (F8) shows each mod's errors. A patch that fails is skipped and the rest of the mod still loads.
- Mod scripts share one global scope: wrap yours in `(() => { ... })();` or a top-level `const` can clash with another mod's.
- If two mods replace the same file, the later one wins and a warning is logged; prefer patches.

## `bun run mod map build` says a map or tileset is wrong

The messages name the map, the field and what to do. Use `bun run mod map show --game <id>` to look at a real map as text (with a coordinate ruler) when choosing stamp rectangles, and `bun run mod map show <mod> <id>` to look at what you built. See [the map compiler guide](MODDING.md#making-new-maps-and-events-no-rpg-maker-no-tiled).

## Tests

- `bun test src` runs the unit tests. Tests that read your install are skipped when it is not found.
- `bun run test` also needs Chrome (set `CHROME` to its path if it is not in the default Windows location) and a GPU-capable session; run the `test/*.ts` scripts one at a time on a low-memory machine.
- The example map mods are generated: `bun run mod map build story-demo` and `bun run mod map build edit-demo` before running `test/story-demo.ts` (`bun run test` does this for you).
