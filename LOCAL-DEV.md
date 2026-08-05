# OpenChat local dev bring-up

Clean, repeatable startup for the local OpenChat replica + frontend + desktop exe. Generic — nothing
app-specific here. (App integrations that co-deploy onto this replica document their own steps; e.g.
the IOU app in `IOU/docs/local-dev-runbook.md`.)

## The environment, and why it spans WSL + Windows

| Layer | Runtime | Port | Brought up by |
|-------|---------|------|---------------|
| Replica + all canisters | **WSL** dfx 0.31.0-beta.1 (pocket-ic) | 8080 | `scripts/local-up.sh` |
| Frontend (Svelte/vite) | **Windows** node | 5003 | `frontend/app/build_dev.sh` |
| Desktop exe (Tauri/WebView2) | Windows | — (CDP 9222) | `Start-Process …\target\debug\open-chat.exe` |

The exe loads its UI from the live `:5003` dev server (`devUrl`), so all three must be up.

## Steps

1. **Replica + canisters** (WSL terminal you keep open):
   ```sh
   bash scripts/local-up.sh
   ```
   Clean-starts the replica on `:8080` and deploys everything. Prints the fresh canister ids.

2. **Frontend `:5003`** (Windows / Git Bash — *not* WSL):
   ```sh
   cd frontend/app
   tr -d '\r' < build_dev.sh > build_dev.sh.lf && mv build_dev.sh.lf build_dev.sh   # ensure LF
   bash ./build_dev.sh
   ```

3. **Desktop exe with remote debugging** (PowerShell):
   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
   Start-Process <open-chat>\target\debug\open-chat.exe
   ```

## Gotchas (each of these has cost a full debugging cycle)

- **pocket-ic beta instability.** The replica dies under load over long uptime and leaves an orphan;
  `dfx start` then returns `400 Bad Request` on `/instances`. No state survives → always
  `--clean` (which `local-up.sh` does). **Canister ids are non-deterministic across `--clean`** —
  re-read `.dfx/local/canister_ids.json` every time; never hardcode.
- **Backgrounded processes get torn down if the launching shell is a one-shot.** `setsid nohup … &`
  inside a single `wsl -d Ubuntu -e bash -lc '…'` is severed when that call returns. Run long-lived
  processes (dfx, vite) from a shell that stays open (a real terminal, or a persistent background task).
- **`build_dev.sh` must be LF.** A CRLF copy breaks under bash (`$'\r': command not found`, mangled
  `NODE_OPTIONS`/`ENV_FILE`). `tr -d '\r'` fixes it. (This file is a local, uncommitted dev toggle —
  e.g. `OC_MOBILE_LAYOUT` — so don't commit it.)
- **Run vite via Windows node, not WSL.** `frontend/node_modules` holds `@rollup/rollup-win32-x64-msvc`;
  under WSL/linux vite dies with `Cannot find module @rollup/rollup-linux-x64-gnu`.
- **Restart the `:5003` vite after every `--clean`.** `vite.config.ts` → `initEnv()` (rollup.extras.mjs)
  bakes every `OC_*_CANISTER` from `.dfx/local/canister_ids.json` at startup; a stale vite points the app
  at wiped canisters and every call 500s. It logs `UserIndexCanisterId:` etc. at boot — grep to confirm.
- **Build the inference exe with `CARGO_PROFILE_DEV_DEBUG_ASSERTIONS=false`** (from `frontend/src-tauri`):
  `CMAKE_GENERATOR="Visual Studio 17 2022" CARGO_PROFILE_DEV_DEBUG_ASSERTIONS=false cargo build --features inference`.
  The env var is REQUIRED for on-device **vision**: `llama-cpp-sys-2`'s build.rs links the *debug* Windows
  CRT (`msvcrtd`) whenever `debug_assertions` is set — even though it builds llama.cpp itself in Release —
  and that debug CRT's `_get_osfhandle` fail-fasts (`0xc0000409`) while clip loads the mmproj projector,
  hard-crashing the app on the first image. Turning `debug_assertions` off drops the debug-CRT link (the
  exe then uses the release CRT and handles images). It MUST be profile-wide (the env var), not
  `[profile.dev.build-override]`-only — a build-override-only toggle desyncs tauri's ACL proc-macro from
  its runtime → `error[E0063]: missing referenced_by` in `tauri::generate_context!`. Dev mode (loads live
  `:5003`) is unaffected — tauri gates that on the `custom-protocol` feature, not `debug_assertions`.
  Verify: `dumpbin -dependents target\debug\open-chat.exe` shows `ucrtbase`/`VCRUNTIME140.dll`, NOT
  `ucrtbased`/`vcruntime140d`. (Text-only inference never loads a projector, so it never hit this.)
  A `--release` exe bundles a frozen frontend with baked ids and doesn't need the env var.
- **After `--clean`, the cached session is dead** (`Failed to get updates from User canister`). In the
  app: Main menu → Sign out → **Create account**. "Sign in" hangs forever trying to load the wiped account.
- **On-device `/ai`** is a client-side composer command, *not* a bot/slash command — it never appears in
  the `/` autocomplete. Type `/ai <prompt>` and send. Needs a model downloaded + selected (Profile →
  Model Manager) and the inference-enabled exe.

## Local-only AI app-card release gates

The in-chat app-card protocol is generic, but its unfinished capabilities must be explicitly enabled
for local testing. Add only the capabilities you are testing to `frontend/.env`:

```dotenv
OC_LOCAL_AI_APP_CARDS_ENABLED=true
OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED=true
OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED=true
OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED=true
```

Values are exact and case-sensitive: only lowercase `true` enables a switch. All switches also require
`OC_BUILD_ENV=development`, `OC_DFX_NETWORK=local`, and a browser hostname of `localhost`, `127.0.0.1`,
or IPv6 loopback. Production/testnet bundles compile these switches to `false`; exposing the Vite dev
server on a LAN address does not activate them. Restart the frontend after changing the environment.

The master and content-attestation switches are required before either final confirmation or private
context can activate. These are client release brakes, not security authority: backend content
attestation and the corresponding viewer/card/app-bound server grants are still mandatory.
