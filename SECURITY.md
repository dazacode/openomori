# Security

## How OpenOMORI is meant to be run

- The server listens on `127.0.0.1` only and serves your OMORI install read-only. Do not expose it to a network.
- It hands the game's decryption key (read from your own `Launch_OMORI.bat`) to the page on the loopback interface. The key is never written to disk by this project or committed.
- Mods run as JavaScript in the page with full access to the game and the page's storage. **Only install mods you trust.** Mods are applied in memory and never modify your install, and each profile has its own saves, but a mod's script can read and change anything in the page.

## Reporting a vulnerability

Please report problems privately through GitHub: **Security > Report a vulnerability** on this repository (private vulnerability reporting). If that is unavailable, open an issue asking for a private contact without including details. Expect an acknowledgement within a few days. This is a volunteer project, so fixes are best effort.

Examples of things worth reporting: the server reading files outside the game folder, the key being exposed beyond loopback, a mod archive escaping its extraction folder, or a way for a web page from another origin to talk to the local server.
