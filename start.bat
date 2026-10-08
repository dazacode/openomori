@echo off
cd /d "%~dp0"
if not exist node_modules bun install
bun run build.ts || exit /b 1
start "" http://127.0.0.1:8080/
bun run src/server.ts 8080
