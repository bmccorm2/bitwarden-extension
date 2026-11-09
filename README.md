# Lightwarden

A small Bitwarden browser extension for one account on a self-hosted Vaultwarden server (default `https://vault.mccormick.sh`). It lists the vault, lets you view, edit, create, trash and restore items, fills logins and TOTP codes with a shortcut, and offers to save new or changed passwords.

## Install

### Chrome / Arc / Chromium

```fish
bun install
bun run build
```

Open `chrome://extensions` (Arc: `arc://extensions`), turn on **Developer mode**, click **Load unpacked**, and pick `.output/chrome-mv3`. After a rebuild, click the reload icon on the extension card.

### Firefox (signed, unlisted)

1. Get AMO API keys at <https://addons.mozilla.org/developers/addon/api/key/> (log in, then **Generate new credentials**).
2. Add them to `.env.local`:
   ```
   AMO_JWT_ISSUER=user:12345:678
   AMO_JWT_SECRET=...
   ```
3. Build and sign: `bun run sign:firefox`. The signed `.xpi` is written to `.output/signed/`. Bump `version` in `package.json` before each new signing; AMO rejects a version it has already signed.
4. Install it: open `about:addons`, click the gear icon, choose **Install Add-on From File…**, and pick the `.xpi`.
5. Grant site access. In Firefox, MV3 host permissions are opt-in, and without them autofill and the save banner do nothing. Open `about:addons` → Lightwarden → **Permissions** and turn on **Access your data for all websites**.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Chromium with the extension loaded and hot reload |
| `bun run build` | Chrome build in `.output/chrome-mv3` |
| `bun run build:firefox` | Firefox MV3 build in `.output/firefox-mv3` |
| `bun run zip:firefox` | Zip the Firefox build |
| `bun run sign:firefox` | Build and sign an unlisted Firefox `.xpi` |
| `bun run test` | Unit tests (vitest + happy-dom) |
| `bun run check` | `svelte-check` type check |
| `bun run smoke` | Read-only login + sync against the server with the test account in `.env.local` |
| `bun scripts/seed-test.ts` | Seeds the **test account** with items the extension can't create (passkey, per-item key). Refuses any other account |

## Autofill shortcut

The default is `Cmd+Shift+L` on macOS and `Ctrl+Shift+L` elsewhere. If another extension already uses it, set it yourself at `chrome://extensions/shortcuts` (Arc: `arc://extensions/shortcuts`; Firefox: `about:addons` → gear icon → **Manage Extension Shortcuts**).

- The first press fills the matching login you used most recently.
- Pressing again on the same page within 15 s fills the next match. A toast shows `Name (2/3)`.
- If the login has a TOTP secret, the current code is copied to the clipboard.
- If the page has a one-time-code field but no password field, the shortcut fills the TOTP code instead.
- Lightwarden never fills iframes from another site.
- While locked, the shortcut opens the unlock screen. The toolbar icon shows a padlock while locked.

## Passkey sign-in (Chromium only)

When a site asks for a passkey (`navigator.credentials.get`), Lightwarden shows a picker with the matching passkeys from your vault.

- Pick a row to sign in, or choose **Use browser passkey** (or press Esc / ×) to hand the request to the browser's own dialog, unchanged.
- While locked, the picker offers **Unlock** (opens the popup). The list appears once the vault is unlocked.
- If no passkey matches, the browser's dialog opens straight away.

Limits:

- Sign-in only. Registering a passkey (`create()`) always goes to the browser or OS.
- Lightwarden never writes to the vault here, so the signature counter is never updated. Passkeys with a non-zero counter are listed but disabled ("Counter-based passkey not supported"). Passkeys created by Bitwarden use counter 0.
- Only ECDSA P-256 passkeys.
- The passkey autofill dropdown (`mediation: 'conditional'`) is left to the browser.
- Not in the Firefox build: Firefox supports main-world content scripts only from version 128.

## Security model

| Where | What |
|---|---|
| `storage.session` (memory only; cleared when the browser closes; content scripts can't read it) | The decrypted user key, access and refresh tokens, the server password hash (used to log in again when a refresh token expires), and pending save/update banners |
| `storage.local` (disk) | The **encrypted** sync data (profile, folders, ciphers), email, KDF parameters, server URL, device ID, `lastUsed` (when you last filled each item, local only), `neverDomains`, `undo` (the last 100 encrypted originals), and `pendingAt` (a timestamp only) |

- The vault locks when the browser closes, or after a period of inactivity if you set one in Settings (popup use, the shortcut and banner clicks count as activity). **Lock** clears the session. **Log out** also deletes the local cache.
- Unlocking decrypts the cached key locally, so it works offline. Login and sync then continue in the background.
- Only PBKDF2-SHA256 accounts are supported. Crypto uses Web Crypto only.
- The popup and content scripts never receive the user key. A content script only receives the values for the fill it asked for.
- **Passkeys:** a small script in the page wraps `navigator.credentials.get` and forwards requests to the content script. The page can see and forge these messages, so all checks run in the background. It takes the frame origin from the browser's sender info (never from the page), checks that the `rpId` is the frame's host or a parent domain and not a public suffix, and requires https (or `http://localhost`). It signs only with a passkey that matches that `rpId`. Private keys are decrypted and used in the background only. The picker lives in a closed shadow root and ignores untrusted (scripted) clicks.
- The service worker exposes `globalThis.lightwarden` (`autofill`, `reloadCache`) for the e2e harness. Only extension contexts can reach it.

### Write safety

- `src/lib/api.ts` can only call the endpoints on its allowlist. Anything else throws before any network call.
- **Dev write lock:** a normal build only allows writes for `LW_TEST_EMAIL` from `.env.local`. To allow writes for every account, build with `LW_RELEASE=1 bun run build`.
- Every update starts from the original encrypted item and re-encrypts only the fields you changed. Before sending, a pre-flight check compares the payload with the original. Passkeys, the item key, attachments, unknown fields and password history must come through unchanged.
- After a write, Lightwarden decrypts the server's copy and compares it with what was meant to be saved.
- Before every update, trash or restore, the original is saved to the local undo store. The item view's **Revert to previous version** writes it back.
- Writes run one at a time and are never retried, except to refresh the token after a 401.
