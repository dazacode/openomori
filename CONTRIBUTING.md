# Contributing to OpenOMORI

Thanks for helping. This is an early-stage project, so small, well-tested changes and clear bug reports are the most useful things.

## The one rule: no game content

**Never commit anything that comes from the game**: no files from `www/`, no decrypted `dump/` output, no screenshots with game artwork, no dialogue copied from the game, no decryption keys, no tile or event data copied from game maps. The repository must stay code and original documentation that works with a copy the user owns.

- `dump/`, `.omori-dir`, `test/out/` and the generated example map output are git-ignored for this reason. Do not force-add them.
- Examples and tests must use their own art (see `examples/story-demo/make-art.ts`) and generate anything map-shaped from a spec at build time.
- UI screenshots for the docs are taken with the game canvas hidden (`scripts/make-screenshots.ts`).
- If you are unsure whether something is game content, leave it out and ask in the pull request.

## Setup

```
git clone https://github.com/dazacode/openomori.git
cd openomori
bun install
bun run start        # asks for your OMORI folder the first time
```

Useful commands:

| Command | What it does |
|---|---|
| `bun run typecheck` | TypeScript, no emit |
| `bun test src` | unit tests (those that read your install are skipped without one) |
| `bun run test` | build, unit tests, then the Chrome end-to-end scripts in `test/` (needs Chrome and your install) |
| `bun run dev` | rebuild on change and restart the server |
| `bun run mod check` | validate the example mods |

On a low-memory machine, run the `test/*.ts` scripts one at a time: `bun run test/checkpoints.ts`.

## Making a change

1. Open an issue first for anything larger than a fix, so the direction can be agreed.
2. Keep changes focused. Match the surrounding code's style, comment density and naming.
3. Add or update a test: a unit test in `src/**/*.test.ts` where the logic is pure, an end-to-end script in `test/` where it needs the real game.
4. Update the docs in `docs/` (and the README's feature list if you add a feature). Docs state only what is true and tested; say so when something is an inference.
5. `bun run typecheck` and the tests you touched must pass.

## Mods and examples

Example mods live in `examples/` and are validated by `bun run mod check`. Map-compiler output (`files/maps`, `files/data`, `files/languages`) is generated and git-ignored: commit the `maps/*.spec.json`, not the build output.

## Reporting bugs

Use the bug report form. The most helpful reports include the game build, browser and version, what you did, what you expected, and the relevant lines of `latest.log`. Please do not attach game files or save files.

## Conduct

Be kind and assume good faith. This is a fan project about a game many people find personal; keep discussion respectful.
