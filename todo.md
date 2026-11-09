# Lightwarden: minimal Bitwarden browser extension for a self-hosted Vaultwarden

## Goal
Build a small, fast browser extension (Chromium first, then Firefox) for one Bitwarden account on Bryan's Vaultwarden server. It lists all vault items, lets you view, edit, create and trash them, fills logins and TOTP codes with a keyboard shortcut, and shows a banner on the page offering to save new logins or update changed passwords. It replaces the official extension, which is too bloated.

## Context
- **Server:** `https://vault.mccormick.sh`, Docker image `vaultwarden/server`, version 2026.6.0, behind Cloudflare.
  - The API is at `/api` and identity at `/identity`.
  - `GET /api/config` and `GET /api/alive` work without authentication.
- **Account facts for `bryan@mccormick.sh`, read from the server DB on 2026-11-09:**
  - KDF is **PBKDF2-SHA256 with 600,000 iterations**. No account on the server uses Argon2id.
  - No 2FA on the vault login.
  - 589 active items: about 580 logins, 8 cards, 3 identities and 1 secure note. 47 have TOTP, 24 have passkeys, 34 are in the trash.
  - 7 folders, 0 attachments, 0 SSH keys, no organizations.
  - 26 items server-wide have a per-item `key` (an item-level key wrapped by the user key). These must decrypt and re-encrypt correctly.
- **Stack:**
  - Language and framework: TypeScript, [WXT](https://wxt.dev) (Manifest V3), Svelte 5 (runes) for the popup only, via `@wxt-dev/module-svelte`. The content script is plain TypeScript with no framework.
  - Styling: Tailwind v4 via `@tailwindcss/vite`, lucide icons via `@lucide/svelte`.
  - Libraries: `tldts` for base-domain matching. Tests use `vitest` with `happy-dom`.
  - Package manager: **bun**.
  - Crypto: Web Crypto only (PBKDF2, HMAC, AES-CBC). No crypto libraries.
- **Commands:**
  - `bun run dev` loads Chromium with the extension.
  - `bun run build` builds Chrome; `bun run build:firefox` builds Firefox.
  - `bun run zip:firefox` packages the Firefox build.
  - `bun run test` runs vitest. `bun run check` runs `svelte-check`.
- **Browsers:** Bryan's daily browser is Arc. Dev runs in Chromium at `/Applications/Chromium.app` (Google Chrome is not installed).
  - `web-ext.config.ts` (gitignored) points WXT at Chromium and keeps a persistent dev profile in `.wxt/chrome-data`.
  - Arc installs the extension by loading `.output/chrome-mv3` unpacked at `arc://extensions`. Shortcuts are set at `arc://extensions/shortcuts`.
- **User environment:** the shell is fish, so any command for the user must be fish-compatible.
- **Theme:** copy `~/.pi/agent/skills/dark-theme/tailwind.css` into `src/assets/tailwind.css` and install `@fontsource-variable/open-sans`.
  - Follow the rules in `~/.pi/agent/skills/dark-theme/SKILL.md`: 13px base, tangerine accent, compact rows, Lucide icons at 14px.
  - Use tokens only, never hard-coded hex values.
  - Follow the OS light/dark setting (no toggle needed).
- **Folder layout:**
  ```
  wxt.config.ts
  src/
    entrypoints/
      background.ts          # service worker: session, sync, API, commands, message router
      popup/                 # Svelte app (index.html, main.ts, App.svelte, views/*.svelte)
      content.ts             # autofill + form-submit capture + banner/toast (all frames)
    lib/
      crypto.ts              # KDF, HKDF-expand, EncString encrypt/decrypt
      api.ts                 # HTTP client for /identity and /api
      session.ts             # unlock/lock/login, key storage
      vault.ts               # cache, sync, decrypt, build/encrypt cipher payloads
      match.ts               # URI matching
      totp.ts                # RFC 6238 + otpauth parsing
      generator.ts           # password generator
      fill.ts                # DOM field detection + value setting (used by content.ts)
      messages.ts            # typed message contracts between popup/content/background
      types.ts               # API + decrypted model types
    assets/tailwind.css
  tests/                     # vitest
  ```

## Decisions
1. **Name:** "Lightwarden". **Server URL** is a setting, defaulting to `https://vault.mccormick.sh`.
2. **One account at a time.** Use only the account the user logs in with. Never call admin endpoints or touch other accounts.
3. **Item types:** support all four types in use: Login (1), Secure Note (2), Card (3) and Identity (4). Support view, create, edit, move-to-trash, restore from trash, and assign to a folder.
   - Folder create, rename and delete are out of scope; the web vault covers them.
   - **Skip attachments and SSH keys** (type 5). If an SSH-key item ever shows up, list it read-only by name.
4. **Passkeys are read-only in the vault.** Show "Passkey: yes (created <date>)" on the login. Never modify `login.fido2Credentials`. Since M10, Lightwarden **signs in** with passkeys already in the vault (Decision 20), but it never creates or stores passkeys.
5. **KDF:** implement PBKDF2-SHA256 only, using the iteration count from prelogin. If prelogin returns `kdf: 1` (Argon2id), show the error "Argon2id not supported".
6. **Lock when the browser closes, or after inactivity.** Keys live in `chrome.storage.session`, which is memory-only and cleared when the browser closes.
   - **Optional auto-lock** (Settings → "Lock after inactivity"): off by default; 1, 5, 15, 30 min, or 1, 4, 8 h. It uses a `chrome.alarms` timer that restarts on any popup action, the autofill shortcut, or a banner click. The setting is stored in `storage.local` as `lockAfter` (minutes; 0 = off).
   - The "Lock" button clears the session. "Log out" clears the session **and** the local cache.
7. **Offline cache:** store the **encrypted** `/api/sync` response in `chrome.storage.local`, together with the email, KDF params and server URL.
   - Unlock decrypts the cached protected user key locally, then logs in and syncs in the background.
   - Sync triggers:
     - on unlock;
     - when the popup opens, if the last sync was more than 5 minutes ago;
     - the manual refresh button;
     - after a write, by merging the returned cipher into the cache.
8. **Autofill shortcut:** command `autofill`, suggested `Command+Shift+L` (mac) and `Ctrl+Shift+L` (other).
   - **The first press** fills the most recently used login that matches the page.
   - **Each further press** on the same tab and page origin within 15 s fills the next match in most-recently-used order, wrapping around. There is no picker UI.
   - A small toast on the page shows `"<item name> (2/3)"`.
   - **Most-recently-used order:** a local map `lastUsed[cipherId] = epochMs` in `storage.local`, updated on every fill. It is never sent to the server. Ties sort by item name.
9. **TOTP:**
   - Show the live code with a countdown in the item view, plus a copy button.
   - After the shortcut fills a login that has TOTP, copy the current code to the clipboard.
   - On a page with no password field but with a one-time-code field, the shortcut fills the TOTP of the most recently used matching login (cycling the same way).
10. **Site matching** follows each URI's `match` value. `null` means the default, Base domain.

    | Value | Meaning |
    |---|---|
    | 0 | Base domain (eTLD+1 via `tldts`) |
    | 1 | Host (host + port) |
    | 2 | Starts with |
    | 3 | Exact |
    | 4 | Regular expression |
    | 5 | Never |

    - Ignore non-http(s) URIs such as `androidapp://`.
    - Equivalent domains are not used (sync with `excludeDomains=true`).
11. **Save/update banner:** an in-page banner (closed shadow DOM, top-right, themed) with these buttons:
    - **Save**, when no matching login has that username;
    - **Update**, when a matching login has the same username but a different password;
    - **Never for this site**, which stores the hostname in `storage.local` `neverDomains`;
    - **×** to dismiss.

    The banner only appears when the vault is unlocked. It never appears if the captured password equals the stored one.
12. **Updates go to the password history.** Updating a password prepends `{ lastUsedDate: <now ISO>, password: <EncString of old password> }` to `passwordHistory` (keep at most 5) and sets `login.passwordRevisionDate` to now.
13. **Delete means move to trash**, via `PUT /api/ciphers/{id}/delete`. Restore uses `PUT /api/ciphers/{id}/restore`. Never delete permanently.
14. **Password generator** in the create/edit form.
    - Options: length (default 20, range 8–128), uppercase, lowercase, digits, symbols (all on by default), and at least one of each enabled set.
    - Use `crypto.getRandomValues` with rejection sampling (no modulo bias).
    - No passphrases.
15. **Password re-prompt:** if an item has `reprompt: 1`, preserve the field but do not enforce the prompt.
16. **Firefox:**
    - Build with WXT's Firefox target (MV3).
    - Sign it as an **unlisted** add-on on AMO with `web-ext sign --channel=unlisted`, using the API key and secret from `.env.local`.
    - Document how to grant host permissions in Firefox, where MV3 host permissions are opt-in.
17. **Testing against the server:** use a **throwaway test account** created by Bryan, with credentials in `.env.local` as `LW_TEST_EMAIL` and `LW_TEST_PASSWORD`. That file is gitignored.
    - **Never** use `bryan@mccormick.sh` in automated tests or scripts.
    - Bryan does the final manual check on his real account.
18. **Version control:** `git init` at the start. **Do not commit** until Bryan approves each milestone.
19. **No data loss (top priority).** Other people use this server. Bryan's own vault must never lose data. The rules are:
    - **Endpoint allowlist.** `api.ts` may only call the endpoints listed in the Protocol reference. Any other path throws before any network call. A unit test must check this. Never call bulk, purge, permanent-delete, account, folder-write, organization or admin endpoints.
    - **Read-only until M5.** M1–M4 make no write calls at all.
    - **Write lock.** Dev builds block every write unless the logged-in email equals `LW_TEST_EMAIL` from `.env.local`. Writes for other accounts are only enabled in a release build, after Bryan approves M5–M7.
    - **Pre-flight check.** Before every create or update request, deep-compare the payload with the original encrypted cipher. Every field the user didn't edit must be identical, byte for byte. `fido2Credentials`, `key`, `attachments` and `passwordHistory` must never be dropped or shortened, except for the history trim in Decision 12. On any mismatch, abort the write and show the error.
    - **Post-write check.** After a write, decrypt the cipher the server returns and compare it with the intended values. On any mismatch, show a clear error and keep the original in the undo store.
    - **Local undo store.** Before every update, trash or restore, save the original encrypted cipher in `storage.local` under `undo`, keeping the last 100. The item view gets a "Revert to previous version" action that writes it back with a normal update.
    - **Server backup.** Bryan's vault DB is backed up before the first write test (see M5).
    - **One write at a time.** Writes run one after another. They never retry automatically, apart from the 401 token refresh.

20. **Passkey sign-in (M10).** Lightwarden answers `navigator.credentials.get()` with passkeys from the vault. It never handles `create()`, so registering a new passkey still goes to the browser or OS.
    - **No vault writes.** The signature counter is never updated. Only passkeys whose decrypted `counter` is `0` are offered; Bitwarden-created passkeys use 0. A passkey with a non-zero counter is listed but disabled, with the note "Counter-based passkey not supported".
    - **Always ask.** Every request shows an in-page picker; nothing is signed without a trusted click (`event.isTrusted`) on a picker button.
    - **Fallback.** The picker always has "Use browser passkey". Choosing it, closing the picker, or any internal error passes the original request to the browser's own `navigator.credentials.get`, unchanged.
    - **Conditional mediation** (`mediation: 'conditional'`, the passkey autofill dropdown) is passed straight to the browser and not intercepted.
    - **Locked vault.** The picker says "Lightwarden is locked" with [Unlock] and [Use browser passkey]. Unlock opens the popup (same as the locked shortcut). The picker reloads its list once the vault is unlocked.
    - **Trust boundary.** The page controls the main-world script and can send it anything. The background must compute the origin from `sender.url` and `sender.frameId`, never from page data, and check `rpId` itself (see the Protocol reference).

## Protocol reference (implement exactly)
All JSON from Vaultwarden 2026.x is camelCase. Before use, normalize response keys to lowerCamelCase recursively, to be safe.

**Prelogin:** `POST {server}/identity/accounts/prelogin` with body `{"email": "<email>"}`. The response has `kdf` (0), `kdfIterations`, `kdfMemory` and `kdfParallelism`.

**Keys** (email = `email.trim().toLowerCase()`):
- `masterKey = PBKDF2-SHA256(password (UTF-8), salt = email (UTF-8), iterations, 32 bytes)`
- `serverHash = base64(PBKDF2-SHA256(masterKey, salt = password (UTF-8), 1 iteration, 32 bytes))`
- Stretch with HKDF-**Expand only**; do **not** use Web Crypto's HKDF, which also runs the extract step:
  - `encKey = HMAC-SHA256(masterKey, utf8("enc") || 0x01)`
  - `macKey = HMAC-SHA256(masterKey, utf8("mac") || 0x01)`
- `userKey = decrypt(profile.key / token response "Key", {encKey, macKey})` is 64 bytes: `enc = [0..32)`, `mac = [32..64)`.
- **Per-item key:** if `cipher.key` is not null, `itemKey = decrypt(cipher.key, userKey)` (64 bytes). Use `itemKey` for **every** encrypted field of that cipher. Otherwise use `userKey`.

**EncString type 2** (`AesCbc256_HmacSha256_B64`) has the format `"2." + b64(iv) + "|" + b64(ct) + "|" + b64(mac)`.
- Decrypt:
  1. Check that `HMAC-SHA256(macKey, iv||ct)` equals `mac`, using a constant-time comparison.
  2. Then AES-256-CBC decrypt with `encKey` (PKCS7).
- Encrypt: use a random 16-byte IV, then compute the MAC as above.
- Throw on any other type prefix. Types 0 and 4 are not expected here.

**Login:** `POST {server}/identity/connect/token`, `Content-Type: application/x-www-form-urlencoded`. Fields:

| Field | Value |
|---|---|
| `grant_type` | `password` |
| `username` | email |
| `password` | serverHash |
| `scope` | `api offline_access` |
| `client_id` | `browser` |
| `deviceType` | 2 (Chrome) or 3 (Firefox) |
| `deviceIdentifier` | UUID v4, generated once and kept forever in `storage.local` |
| `deviceName` | `chrome` or `firefox` |

- Send the header `Auth-Email: base64url(email)`.
- The response includes `access_token`, `expires_in`, `refresh_token` and `Key`.
- A 400 response with `error_description` means a bad password. Show "Invalid email or master password".

**Refresh:** the same endpoint with `grant_type=refresh_token`, `client_id=browser` and `refresh_token`.
- Refresh when the access token has less than 60 s left, or on a 401 (retry once).
- Store the tokens in `storage.session`.

**Sync:** `GET {server}/api/sync?excludeDomains=true` with `Authorization: Bearer <token>`. Use these fields of the response: `profile` (including `key`), `folders`, `ciphers`.

**Cipher write:**
- Create: `POST /api/ciphers`.
- Update: `PUT /api/ciphers/{id}`.
- **Also required (found during M5 testing):** `encryptedFor: <profile.id>` on every create and update. Vaultwarden (web-v2025.6+) rejects bodies without it with HTTP 422. Leaving out `archivedDate` un-archives the item, so it must be passed through.
- The body is the cipher object, with every encrypted value as an EncString: `type`, `folderId`, `name`, `notes`, `favorite`, `reprompt`, `key`, `login | secureNote | card | identity`, `fields`, `passwordHistory`, `lastKnownRevisionDate`.
- On update, send `lastKnownRevisionDate = cipher.revisionDate` from the cache.
- If the server returns 400 "out of date", sync and then show "Item changed elsewhere; reloaded. Re-apply your edit."
- **When editing, start from the original encrypted cipher object.** Re-encrypt only the fields the user changed, using that cipher's key, and pass every other field through unchanged, including `fido2Credentials`, `key`, `archivedDate` and unknown fields.
- **New items:** set `key: null` (no per-item key) and `secureNote: {type: 0}` for notes.

**Trash:**
- Move to trash: `PUT /api/ciphers/{id}/delete`.
- Restore: `PUT /api/ciphers/{id}/restore`.
- Items in the trash have `deletedDate` set.

**Custom fields:** `type` is 0 (text), 1 (hidden), 2 (boolean) or 3 (linked). `name` and `value` are EncStrings.

**Passkeys (`login.fido2Credentials[]`, M10):**
- Every field is an EncString (decrypt with the cipher's key) except `creationDate`. The fields are `credentialId`, `keyType` (`public-key`), `keyAlgorithm` (`ECDSA`), `keyCurve` (`P-256`), `keyValue`, `rpId`, `rpName`, `userHandle`, `userName`, `userDisplayName`, `counter` (decimal string) and `discoverable` (`"true"`/`"false"`).
- `keyValue` is the private key as base64url **PKCS#8**. Import it with `crypto.subtle.importKey('pkcs8', …, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])`. Skip any passkey that isn't ECDSA P-256.
- `credentialId` is either a GUID string, whose raw ID is the GUID's 16 bytes in order (hex digits without dashes), or `b64.<base64url>`, whose raw ID is the decoded bytes.
- `userHandle` is base64url; return its decoded bytes.
- **rpId check:** `rpId = options.publicKey.rpId ?? frameOrigin.hostname`. The frame origin must be `https:` (or `http://localhost`). `rpId` must equal the frame's hostname or be a parent domain of it, and must not be a public suffix (use `tldts`: `getDomain(rpId)` must not be null). Otherwise reject with `SecurityError`.
- **Matching:** a passkey matches when its decrypted `rpId` equals the request's `rpId`. If `allowCredentials` is non-empty, keep only passkeys whose raw ID is in it. If it's empty, keep only `discoverable === "true"`.
- **clientDataJSON:** the UTF-8 bytes of `{"type":"webauthn.get","challenge":<base64url(challenge)>,"origin":<frame origin>,"crossOrigin":<frame is cross-origin to top>}`, keys in that order. For a cross-origin iframe, also add `"topOrigin":<top origin>`.
- **authenticatorData** (37 bytes): `SHA-256(utf8(rpId))` (32), then flags `0x1D` (UP | UV | BE | BS), then the counter as 4 bytes big-endian (always 0).
- **Signature:** `ECDSA-SHA256` over `authenticatorData || SHA-256(clientDataJSON)`. Web Crypto returns raw `r||s` (64 bytes), which must be converted to **ASN.1 DER** before returning it.
- **Returned credential:** an object with own properties `id` (base64url raw ID), `rawId`, `type: 'public-key'`, `authenticatorAttachment: 'platform'`, `response` (`clientDataJSON`, `authenticatorData`, `signature`, `userHandle` as ArrayBuffers), plus `getClientExtensionResults() → {}` and `toJSON()` (the WebAuthn JSON form). Set its prototype to `PublicKeyCredential.prototype`, and `response`'s prototype to `AuthenticatorAssertionResponse.prototype`, so `instanceof` checks pass. Use own properties because the prototype getters throw on foreign objects.

## Tasks
Mark each task `- [x]` in this file as soon as it is done.

### M1: Scaffold
- [x] 1. `git init`. Scaffold WXT (Svelte template) **into a temp dir** with `bunx wxt@latest init /tmp/lw-scaffold -t svelte --pm bun`, then copy the files into the repo. Never use `--force` here.
- [x] 2. Set WXT `srcDir: 'src'`. Add the Tailwind v4 plugin and the theme file (see Context), plus `.gitignore` entries for `.env.local`, `.output` and `.wxt`.
- [x] 3. Set up the manifest in `wxt.config.ts`:
  - `name: "Lightwarden"`
  - `permissions: ["storage", "tabs", "clipboardWrite", "scripting", "alarms"]` (`scripting` re-injects the content script into tabs opened before a reload; `alarms` runs the auto-lock timer)
  - `host_permissions: ["<all_urls>"]`
  - a `commands.autofill` entry with the suggested keys from Decision 8
  - a content script on `<all_urls>` with `all_frames: true` and `run_at: document_idle`
  - popup size 380×560
- [x] 4. Add the `test` script (vitest + happy-dom) and the `check` script. `bun run build` and `bun run test` must both pass on the empty scaffold.

### M2: Crypto, TOTP, matching (pure, unit-tested)
- [x] 5. `src/lib/crypto.ts` must export:
  - `deriveMasterKey(password, email, iterations): Promise<Uint8Array>`
  - `serverHash(masterKey, password): Promise<string>`
  - `stretch(masterKey): Promise<SymKey>`
  - `decryptEnc(enc: string, key: SymKey): Promise<Uint8Array>`
  - `decryptStr(enc, key): Promise<string>`
  - `encryptStr(plain: string, key: SymKey): Promise<string>`
  - `encryptBytes(bytes, key): Promise<string>`
  - `symKeyFromBytes(64 bytes): SymKey`

  Here `SymKey = { enc: Uint8Array, mac: Uint8Array }`.
- [x] 6. Tests in `tests/crypto.test.ts`:
  - encrypt/decrypt round trip;
  - a tampered MAC throws;
  - wrong-type prefix throws;
  - a `stretch` result matches a manual HMAC calculation;
  - PBKDF2 output for a fixed input matches a value computed independently in the test with Node `crypto.pbkdf2Sync`.
- [x] 7. `src/lib/totp.ts`:
  - `parseTotp(s)` accepts a raw base32 secret (spaces allowed, case-insensitive) or `otpauth://totp/...?secret=&algorithm=&digits=&period=`.
  - `generateTotp(spec, nowMs) -> { code, remaining }` uses Web Crypto HMAC with SHA-1, SHA-256 or SHA-512.
  - Tests use the RFC 6238 vectors (SHA-1 secret `12345678901234567890`, T=59 → `94287082`, 8 digits).
  - A `steam://` secret returns `null` and the UI shows "unsupported".
- [x] 8. `src/lib/match.ts`:
  - `matches(pageUrl: string, uri: {uri: string, match: number|null}): boolean` implements Decision 10.
  - `matchingLogins(pageUrl, ciphers)` excludes items in the trash.
  - In `tests/match.test.ts`, test each match type, including subdomain → base domain (`login.example.co.uk` vs `example.co.uk`), port handling for Host, invalid regex → false, and Never.
- [x] 9. `src/lib/generator.ts`: `generatePassword(opts)` implements Decision 14, with tests for length, required sets and character sets.

### M3: Session, login, sync, cache (background)
- [x] 10. `src/lib/api.ts`: `prelogin`, `login`, `refresh`, `sync`, `createCipher`, `updateCipher`, `trashCipher`, `restoreCipher`, with key normalization and the refresh-on-401 behavior.
- [x] 11. `src/lib/session.ts`:
  - **States:** `loggedOut | locked | unlocked`.
  - **`unlock(password)`:**
    1. If there is no cache, call prelogin, then login, then sync.
    2. Otherwise derive the keys from the cached KDF params and decrypt the cached `profile.key`. A wrong password shows the error "Invalid master password".
    3. Then log in and sync in the background. An offline failure is not fatal.
  - **Session storage:** store `userKey` (base64) and the tokens in `storage.session`. Call `storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})` so content scripts cannot read it.
  - Also provide `lock()` and `logout()`.
- [x] 12. `src/lib/vault.ts`:
  - Keep an in-memory decrypted index in the service worker. Rebuild it from the cache plus the session key whenever the worker wakes and the index is empty.
  - Decrypt fields lazily where cheap. List rows need name, username, first URI, type, folder, favorite and deleted.
  - Provide `getItem(id)`, which fully decrypts one item, and `save(draft)`, `trash(id)`, `restore(id)`.
  - Merge server responses into the cache.
- [x] 13. `src/entrypoints/background.ts`: a message router with typed messages from `messages.ts`, covering state, unlock, lock, logout, sync, list, get, save, trash, restore, generate, totp, the fill request, the capture event and the banner action. Popup and content scripts never get the user key.

### M4: Popup: list and view
- [x] 14. Login/unlock screen: server URL field (prefilled), email and master password. Once a cache exists, show password only, plus a "Log out" link.
- [x] 15. List view:
  - search box (autofocus) filtering by name, username and URIs;
  - a "This site" section at the top (matches for the active tab);
  - filter chips for All, Logins, Cards, Identities, Notes and Trash;
  - a folder dropdown and favorites first.
  - Rows show the type icon, name and username.
  - Keyboard: ↑/↓ moves the selection, Enter opens the item.
  - Toolbar: sync (spinner while running), new, lock and settings.
  - It must stay responsive with 600+ items (no virtualization needed; check it).
- [x] 16. Item view:
  - Every non-empty field gets a copy button. Passwords and hidden fields are masked with show/hide.
  - Show the live TOTP code with a countdown ring (`--running`), the URIs as links, custom fields, the passkey line (Decision 4), notes, folder, and the revision date.
  - Buttons: Edit and Move to trash. In the Trash view, the button is Restore instead.
- [x] 17. Settings: server URL, the shortcut name with a link to `chrome://extensions/shortcuts` (Chrome) or a note about `about:addons` (Firefox), a "Never for this site" list with remove buttons, Lock, and Log out.

### M5: Edit and create
- [x] 17a. **Before any write test**, ask Bryan to confirm that a fresh backup of `/opt/vault/db.sqlite3` exists on `vps`. Taking it is Bryan's call; do not run anything on the server yourself. A baseline backup already exists at `vps:~/vault-backups/db_20261109_162729.sqlite3`, taken with `vaultwarden backup`, integrity check ok.
  - Done 2026-11-09 at Bryan's request: `vps:~/vault-backups/db_20261109_171440.sqlite3` (`vaultwarden backup`, integrity ok, 664 ciphers, 4 users).
- [x] 17b. Build the Decision 19 safeguards first, with tests: the endpoint allowlist, the write lock, the pre-flight deep-compare (fixtures: a cipher with passkeys, a cipher with a per-item key, a cipher with password history), and the undo store.
- [x] 18. Edit/create form for each type. All forms include name, folder, favorite, notes and custom fields (add/remove, types text/hidden/boolean; linked fields are shown read-only).
  - **Login:** username, password with generator popover, TOTP secret, URIs (add/remove, match dropdown).
  - **Card:** cardholderName, brand, number, expMonth, expYear, code.
  - **Identity:** title, first/middle/last name, address1–3, city, state, postalCode, country, company, email, phone, ssn, username, passportNumber, licenseNumber.
  - **Note:** notes only.
- [x] 19. Save follows the edit rules in the Protocol reference. Changing a login password applies Decision 12.
  - After saving, the list and item view update without a full sync.
  - Show the out-of-date error message on conflict.

### M6: Autofill shortcut
- [x] 20. `src/lib/fill.ts`: field detection.
  - **Password fields:** visible `input[type=password]` elements. Visible means size > 0 and not `display:none` / `visibility:hidden`.
  - **Username field:** the nearest preceding visible input in the same form (or document order) of type text/email/tel, or with `autocomplete` username/email.
  - **Username-first pages** (no password field): the visible input with `autocomplete=username|email`, `type=email`, or name/id matching `/user|email|login/i`.
  - **TOTP field:** `autocomplete=one-time-code`, or name/id/placeholder matching `/otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|security.?code|code/i` with `maxlength` 6–8 or `inputmode=numeric`. Also handle split 6-box OTP inputs (6 adjacent `maxlength=1` inputs) by filling one digit per box.
  - **Setting values:** use the native `HTMLInputElement.prototype.value` setter, then dispatch `input` and `change` (bubbling) so React and Vue pages pick it up. Focus the field first.
  - **Custom fields:** fill text inputs whose `name` or `id` equals a custom field name, case-insensitive.
- [x] 21. Command flow in the background:
  1. On `commands.onCommand('autofill')`, get the active tab and its URL, and compute matches.
  2. Apply the cycling state per Decision 8, kept in memory as `tabId → {origin, ids, index, at}`.
  3. Send `fill` to frames of the tab whose origin matches the item, top frame first. Never fill cross-site iframes.
  4. On success, update `lastUsed`, show the toast, and copy the TOTP via the content script with `navigator.clipboard.writeText` (fall back to `document.execCommand('copy')` with a hidden textarea).
- [x] 22. TOTP page (no password field, OTP field present): fill the code instead of the login. The fill reply from the content script states which mode applied.
- [x] 23. Toasts (shadow DOM, auto-hide after 2.5 s):
  - when locked: "Lightwarden is locked. Open the popup to unlock."
  - when nothing matches: "No logins for <host>"
  - when no fillable fields are found: "No fillable fields"
- [x] 24. `fill.ts` tests with happy-dom fixtures: a standard login form, a username-first page, a React-style controlled input (value setter + event), a single OTP input, a 6-box OTP, and hidden fields being ignored.

### M7: Save/update banner
- [x] 25. Capture in `content.ts`:
  - on `submit` (capture phase) of any form containing a filled password field;
  - on click of a submit-like button (`button[type=submit]`, `input[type=submit]`, or a button whose text matches `/log ?in|sign ?in|continue|next|submit/i`) inside or near such a form;
  - on Enter in a password field.

  Send `{url, username, password}` to the background. Ignore fields where `autocomplete=new-password` appears together with a second password field that has a different value (password-change forms). For those, capture the **new** password as an update of the current matched login.
- [x] 26. Background:
  - Ignore the capture if the vault is locked, the host is in `neverDomains`, or the password is empty.
  - Otherwise decide save, update or none (Decision 11) and store `pending[tabId]` for 60 s.
  - The content script asks for pending on load and after capture, so the banner survives the post-login navigation. Clear pending once it is shown and acted on, or dismissed.
- [x] 27. Banner actions:
  - **Save** creates a login with name = host without `www.`, the username, the password, and the URI `https://<host>` with match null.
  - **Update** applies Decision 12 to the matched cipher.
  - **Never** adds the host to `neverDomains`.
  - Show a confirmation toast afterwards.

### M8: Firefox
- [ ] 28. `bun run build:firefox` produces a working MV3 build. Set `browser_specific_settings.gecko.id = "lightwarden@mccormick.sh"` and `strict_min_version` "121.0".
  - Check that `storage.session`, `commands` and the clipboard all work in Firefox.
- [x] 29. Add `bun run sign:firefox`, which runs `web-ext sign --channel=unlisted` with `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from `.env.local`.
  - In `README.md`, document how to get AMO API keys, how to install the signed `.xpi`, and how to grant "Access your data for all websites" in `about:addons`.

### M9: Finish
- [x] 30. `README.md` covers install (Chrome unpacked from `.output/chrome-mv3`; Firefox signed xpi), the dev commands, the shortcut, and the security model (what is stored where).
- [ ] 31. Run all acceptance criteria against the test account. Ask Bryan to do the manual check on his real account (read-only actions first: unlock, list, view, TOTP, fill). *(Test-account part done 2026-11-09: 25/25 live write checks, verified with an independent decryptor and in the web vault; 41/41 browser checks; offline unlock. Waiting on Bryan's manual check.)*

### M10: Passkey sign-in (Decision 20)
- [x] 32. **Pure code first, with tests** in `src/lib/passkey.ts` and `tests/passkey.test.ts`:
  - `rawCredentialId(credentialId)` for both GUID and `b64.` forms;
  - `checkRpId(rpId, frameUrl)`: allowed for the same host or a parent domain; rejected for a public suffix, an unrelated domain, or `http:` (except localhost);
  - `clientDataJSON(...)` byte layout, including the cross-origin iframe case;
  - `authenticatorData(rpId)`: 37 bytes, flags `0x1D`, counter 0;
  - `rawToDer(sig)`: include an `r` with a high bit set (needs a leading 0x00) and a short `r` (leading zero bytes stripped);
  - an end-to-end check: generate a P-256 key, export it as PKCS#8, sign an assertion with `passkey.ts`, convert DER back to raw, and verify with Web Crypto.
- [x] 33. **Main-world script** `src/entrypoints/webauthn.content.ts`: `world: 'MAIN'`, `runAt: 'document_start'`, `allFrames: true`, `matches: ['<all_urls>']`.
  - Wrap `navigator.credentials.get`. Pass through any call without `publicKey`, or with `mediation: 'conditional'`.
  - Otherwise, send the request to the isolated content script via `window.postMessage` and wait for a reply. Send `challenge`, `rpId`, `allowCredentials` IDs (as base64url), `userVerification` and a random request ID; the `ArrayBuffer`s must be base64url-encoded.
  - Handle the reply: build the credential (Protocol reference), throw the given `DOMException` name, or call the original `get` for fallback.
  - Honour `options.signal`: on abort, close the picker and reject with `AbortError`.
  - Keep a reference to the original `get` before wrapping. Don't touch `create`.
- [x] 34. **Isolated content script** (`content.ts`): accept only `postMessage` events with `event.source === window` and the expected message shape, then forward them to the background as `passkeyGet`. Show the picker (task 36) and return the result to the main world.
- [x] 35. **Background** (`passkeyGet`, `passkeySign`):
  - Compute the frame origin, and whether it's cross-origin to the top, from `sender.url` and `sender.tab.url`. Run `checkRpId`.
  - If locked, reply `{ locked: true }`.
  - Otherwise list the matching passkeys as `{ cipherId, credIndex, itemName, userName, disabled }`. Send no keys to the content script.
  - `passkeySign` re-runs the checks, decrypts `keyValue` in the background only, signs, and returns the assertion parts. Then call `markUsed(cipherId)`.
  - Add `openUnlock`, which calls the existing `openUnlock()` for the picker's Unlock button.
  - Add all three message types to `CONTENT_TYPES` and `messages.ts`.
- [x] 36. **Picker** in `page-ui.ts`: closed shadow DOM, styled like the save banner, centred on the page.
  - Title "Sign in with a passkey · <rpId>", one row per passkey ("<userName> · <itemName>"), and a "Use browser passkey" button. Esc or ✕ means fallback.
  - When locked, show the locked state with [Unlock] and [Use browser passkey]. Unlock sends `openUnlock`; then poll `passkeyGet` every second for up to 2 minutes, and refresh the list when it's unlocked.
  - Ignore clicks where `event.isTrusted` is false.
  - If no passkey matches, skip the picker and fall back at once.
- [x] 37. **Manifest:** WXT registers `world: 'MAIN'` content scripts on Chromium (Chrome 111+). Firefox supports them from 128; ask Bryan before raising `strict_min_version`, and until then exclude the main-world script from the Firefox build.
- [ ] 38. **Live test** with the test account: Bryan creates a passkey on https://webauthn.io in the test vault using the official Bitwarden extension, then disables that extension. In Chromium, sign in on webauthn.io with Lightwarden. Check that the "Use browser passkey" fallback still opens the browser's own dialog, and that the passkey in the web vault is unchanged afterwards (same counter, no new revision).
- [ ] 39. Update `README.md` (passkey sign-in, its limits, and the security model) and tick this milestone. *(README done 2026-11-09. Local browser e2e passed 17/17 with a real P-256 passkey injected into the local cache only, so no server write: picker, Esc fallback, SecurityError for a foreign or public-suffix rpId, AbortError, conditional pass-through, no-match fallback, signature verifies, and a counter-based passkey is shown disabled. Waiting on task 38.)*

## Acceptance criteria
- `bun run check`, `bun run test` and `bun run build` and `bun run build:firefox` all succeed with no errors.
- With the test account, in Chromium:
  - Login works; the popup lists all items; search finds an item by username.
  - TOTP codes match the web vault's codes.
  - Create, edit, trash and restore are each reflected in the web vault at `https://vault.mccormick.sh` after a refresh.
  - Editing a login that has a passkey leaves the passkey intact in the web vault.
  - An item with a per-item key can be viewed and edited, and the web vault still decrypts it afterwards.
- After a browser restart, the popup shows the unlock screen, and unlocking works offline: with Wi-Fi off, cached items are still visible.
- On a test login page with two saved logins, `Cmd+Shift+L` fills login A. A second press within 15 s fills login B, and a third fills A again. The toast shows `(n/2)`, and the TOTP is copied when the login has one.
- Submitting a new login on a page shows the Save banner, even across a redirect. Saving creates the item. Submitting with a changed password shows Update, and saving adds a password history entry. "Never for this site" suppresses future banners.
- The decrypted user key and the tokens are never in `storage.local`. Inspect it to confirm: only encrypted sync data, the email, KDF params, server URL, device ID, `lastUsed`, `neverDomains` and `lockAfter`.

## Out of scope
- Argon2id, organizations and collections, Send, attachments, and SSH keys.
- Creating or storing passkeys (`navigator.credentials.create`), updating passkey counters, and conditional (autofill) passkey UI. Sign-in with existing passkeys is in scope (M10).
- Folder create, rename and delete; permanent delete; empty trash.
- Account registration, changing the master password, emergency access, and 2FA on the vault login.
- PIN or biometric unlock, and the notifications websocket (live sync).
- Inline autofill menus or icons in fields, autofill on page load, and context menus.
- Equivalent domains, Steam TOTP, and passphrase generation.
- Any server-side change on the VPS. Never run commands on `vps`; backups are Bryan's job (task 17a).
- New dependencies beyond those listed in Context, plus `web-ext` as a dev dependency.

## Follow-ups for Bryan (not for the implementer)
- [ ] Set `SIGNUPS_ALLOWED=false` on the `vault` container on `vps`. Right now it's unset, and Vaultwarden then allows open public registration. Recreate the container afterwards, then confirm that https://vault.mccormick.sh/#/signup refuses new accounts.
- [ ] When the extension is done, delete the test account `bryan+lwtest@mccormick.sh`.

## Notes / risks
- **Who can be affected:** the server only lets the logged-in account change its own items. Other users' items are encrypted with their own keys and owned by them, so the extension cannot read or change them. The risk is to the logged-in vault only, which is why Decision 19 exists.
- **Data loss:** sending a cipher without its `fido2Credentials`, `key` or `passwordHistory` silently deletes them on the server. Always start from the original encrypted object (see the Protocol reference). Test this on the throwaway account first.
- **Per-item keys:** encrypting a field of a keyed cipher with the user key makes it unreadable. Always use the cipher's own key.
- **MV3 service worker:** the worker gets killed when idle. Never rely on module globals for keys; reload from `storage.session`. The cycling state may be lost, and that is fine.
- **Cloudflare:** it sits in front of the server. If requests from the extension get bot-challenged (an HTML 403 or 503 response), report it to Bryan rather than working around it. The fix belongs in Cloudflare (a WAF skip rule for `/api` and `/identity`).
- **Shortcut conflicts:** `Cmd+Shift+L` may conflict with the official Bitwarden extension or other shortcuts. Chrome then ignores the suggestion, and the user sets it at `chrome://extensions/shortcuts`.
- **Clipboard:** writing from a content script needs page focus, which is true right after the shortcut. If it fails, show the toast "TOTP: 123 456 (copy failed)".
- **Passkeys (M10):** the main-world script runs in the page, so treat everything from it as untrusted. Private keys never leave the background. A bug in `rpId`/origin checks would let one site get a signature for another, which is why task 32 tests them before any UI work.
- **Content-script hygiene:** never log secrets. The content script receives only the values for the fill it requested.
