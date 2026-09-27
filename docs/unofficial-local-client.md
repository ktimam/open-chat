# Unofficial local client

This is an experimental frontend profile, not an official OpenChat release. It uses
the checked-in official canister IDs without deploying modified OpenChat canisters.
Public branding, hosting and native Android authentication are separate release gates.

## Start and sign in

From the repository root, with the frontend dependencies installed:

```sh
node scripts/start-unofficial-local.mjs --port 5190 --layout v2
```

Use `http://localhost:5190`. The server binds loopback only. `--layout v1` selects the
classic interface; v2 uses the responsive mobile interface at mobile widths. This
profile ignores inherited environment retargeting, disables official OTA and supplies
the official service public key through a verified, read-only query.

Choose **Sign in with an existing passkey**. A passkey already linked for localhost
can be selected in the browser even if it was created on another localhost port.
It must be available in that browser/device; a desktop passkey is not automatically
available on a phone. If no linked passkey exists, the separate explicit linking flow
uses an official account-linking code and a confirmation before adding a credential.
It never automatically creates a new OpenChat account or retries a consumed code.

In the separate local-test APK, enter your existing username and choose
**Continue in browser to sign in or link**. Complete the passkey or explicit linking
step yourself in the local browser page. Each request expires after two minutes;
the adopted session is memory-only and expires no later than five minutes from
starting that request, not five minutes after successful sign-in. After expiry,
sign in again explicitly. A linked credential is not deleted when this session ends.

## Private apps

1. In the receiving app, explicitly export its local setup catalog and processor.
   A private catalog can contain the app's private vocabulary/defaults; keep it private.
2. In **Private apps**, import the catalog, select its app/action and import the
   matching processor. The declared hash verifies an exact file, not publisher trust.
   No app code or metadata is fetched automatically during message processing.
3. Select an available local model, or a supported local-reader mode, and use
   **Propose** on one text or image message. Both UIs share this pipeline; app
   proposals do not currently accept voice messages.
   App prompts, labels, rules, extraction and normalization remain app-owned.
4. Edit and review the complete local draft. Nothing is posted to the chat or sent
   to the app for card verification. Editing invalidates the previous approval.
5. Confirm the full request, including its destination and recipient review label.
   A separate browser relay displays it again and asks before opening the receiving
   app. In the local-test APK, first pair that relay as described below.
6. Review the actual account/destination inside the app, then explicitly save there.
   **Received** is not **saved**; the latter means the app reports that it saved.

Per-chat app opt-in enables suggestions from imported declarative rules for fresh
messages only. It does not grant the app access to chat history. Models do not run
merely to display a suggestion.

### Local-test APK browser handoff

After **Send reviewed request**, the APK displays an exact localhost browser URL
and a one-use pairing code. Choose **Copy pairing code** and **Open local browser**,
enter the code only on that displayed page, then select **Load reviewed draft**.
The URL itself contains neither the code nor the draft. Copying is optional and
explicit; your device clipboard may retain the code after it expires.

The code expires after two minutes and can claim the approved draft only once.
After a successful claim, the browser has up to ten minutes to complete delivery.
Review every field and the destination again before opening the receiving app.
The receiving app asks you to allow the one-time connection before it receives the
approved payload. Review its actual account and destination, then save there.
**Received** does not mean that anything has been saved.

Discarding the draft or changing account cancels the pending native handoff. Data
already handed to the receiving app cannot be recalled. If the outcome is uncertain,
check the app before choosing the explicitly confirmed retry with the same import
ID. There is no automatic retry or automatic browser/clipboard action.
**Close** only hides the workspace; use **Cancel / discard local draft** to cancel
pending work.

### Process with AI and `/ai` are chat actions

**Process with AI** runs local inference on the selected message, then automatically
posts its answer as a normal reply to the current chat. It does **not** open a private
draft or provide an app-delivery review step. `/ai` likewise posts its output to chat.
Local inference therefore does not mean the resulting answer stays only on-device;
chat participants can see the posted answer. Do not use these actions when you want
an unsent private app proposal; use **Propose** instead.

Voice messages are supported by **Process with AI** when a compatible model's
optional audio support is enabled. This does not add voice input to app proposals.

This prototype keeps imports, per-chat opt-ins and private drafts in page memory.
Reload/logout/account change discards them: re-import the app catalog and processor,
reselect the app/action and restore any chat opt-ins. Downloaded model caches are
separate and are not deleted when changing apps or models. An uncertain delivery is
never retried automatically. Check the receiving app first, then use **Retry the same
reviewed request** if the draft is still available, preserving its import ID. Create
a new draft only after checking that the earlier request was not already saved.

## Boundaries and developer checks

- The client and worker both reject unsupported custom-registry/card APIs in this
  profile. The bundled frontend catalog replaces custom-backend model discovery.
- Imported processors run in a bounded, opaque-origin worker with network/storage
  blocked. This is not a hard CPU/memory quota or protection from browser compromise.
- In the localhost browser profile, the model page stays cross-origin isolated.
  Only the exact fixed relay routes use non-isolated headers; those routes bypass
  the service worker's document cache. The local-test APK WebView is a separate
  secure-context profile and does not require cross-origin isolation: its local
  inference runtime uses single-threaded WASM support alongside WebGPU. Imported
  app processors still run in the separately isolated, network-blocked sandbox.
- The handoff binds exact origin, popup and fresh nonce. It does not authenticate a
  destination pathname, receiving account, or the honesty of an approved app.
- The relay holds only approved data and severs its opener to the main client. The
  app cannot gain the main client's chat access through that opener chain.

See `frontend/app/src/utils/localAppDrafts.md` and `isolatedAppProcessor.md` for the
protocol and threat boundaries. Run frontend `npm run typecheck`,
`npm run typecheck:agent` and `npm test`; relay, worker and both-UI wiring regressions
are part of the default suite. Real browser navigation tests must use a normal HTML
navigation Accept header, not only plain fetch/HEAD checks.

Synthetic browser coverage is not proof of real model accuracy, existing-account
sign-in, ledger delivery or native APK behavior. Keep these acceptance gates separate.
