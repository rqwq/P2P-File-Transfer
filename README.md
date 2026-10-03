# P2P File Transfer

Serverless, peer-to-peer file transfer for Windows. Users create or join
"rooms" (persistent group identities) and exchange files and text chat
directly with each other — no central server. Discovery, NAT traversal and
transport all happen peer-to-peer over HyperDHT, or directly over a
Radmin VPN / Hamachi adapter, selectable per room.

> **License** — source-available, All Rights Reserved. The repository is
> public for transparency and review only; it is **not open source**. No
> license to use, copy, modify, compile or redistribute is granted.
> Forking via GitHub's UI grants no rights beyond viewing on GitHub. The
> only authorized distribution channel is this project's own GitHub
> Releases page. The full End User License Agreement is in
> [LICENSE](LICENSE) and in the app's About / License panel. Contact for
> licensing questions / abuse reports: Discord `.extremism`.

## Quick start

```sh
npm install       # native modules build for Electron automatically
npm run dev       # development (never obfuscated)
npm run typecheck
npm run smoke     # pure-logic tests: ban parser, room codes, path safety, framing, HWID vector
npm run build     # production build (obfuscated)
npm run check:build
npm run dist      # package the NSIS installer
```

## Architecture

- **Renderer** — React UI (dark-only, sky-blue accent, macOS-style
  frameless titlebar). Zero filesystem/network access; talks to the main
  process exclusively through a narrow, typed `contextBridge` API with
  allowlisted methods and channels.
- **Main process** — window/tray, SQLite databases (room roster cache,
  per-room chat, creator-authoritative ban lists), settings, HWID
  identity, receive-folder lock, the runtime integrity gate,
  auto-updater, and every disk write with path validation.
- **Net worker** (`utilityProcess`) — all networking and protocol parsing
  (Hyperswarm, wire framing, chunk transfer engine, chat sync, VPN TCP
  transport), isolated from window/update code. Every inbound wire
  message is validated against a Zod schema before use; frames from
  peers not yet TOFU-trusted are held until the user decides.
- **Identity** — HWID = SHA256 of `{motherboard serial}-{processorId}-{first
  disk serial}-{first enabled NIC MAC}`, computed on first launch,
  DPAPI-cached, verified on every launch (mismatch → blocking rebuild
  screen). Network identity is an ed25519 keypair; room codes encode the
  creator's public key (base58), never an IP.
- **Transfers** — single files or whole folder trees, 512KB chunked with
  per-chunk SHA-256 and whole-file verification, chunk-level checkpoint
  state for resume after connection drops, sender pacing at
  min(receiver's per-transfer cap, local global cap), Windows-style
  collision suffixes, `wx` no-clobber writes, Mark-of-the-Web
  (`Zone.Identifier`) on every received file, and previews that stream
  the entire file into RAM (per spec — `ERR: not enough memory` when it
  won't fit). Room-wide task rows carry **no filenames at all**: only
  the two parties ever see them, so the redaction (spec 8.6) cannot be
  disabled by a modified client.
- **Moderation** — creator-authoritative ban list (SQLite, private to the
  creator), moderators cache bans offline and push them on the creator's
  reconnect ping via additive upserts, ban checks (HWID OR IP) run before
  anything else on join, and being banned wipes all room-local data.

## Build & packaging pipeline

- Production bundles are obfuscated (`javascript-obfuscator` via a Vite
  plugin, production only; the hot-path net worker chunk gets a lighter
  profile), then `check:build` verifies every chunk still parses and
  ESM wiring agrees.
- `@electron/fuses` (afterPack): RunAsNode off, NODE_OPTIONS off,
  `--inspect` off, cookie encryption on, embedded asar-integrity
  validation on, OnlyLoadAppFromAsar on.
- CI (`.github/workflows/release.yml`) publishes every `release**` push
  as a GitHub pre-release, stamped `<major.minor>.<run number>`, and
  uploads `app.asar`'s SHA-256 as the `asar.sha256` release asset.
- The packaged app re-hashes its own `app.asar` at startup (via
  `original-fs`) and compares against that asset; a mismatch or an
  unknown version shows the separate "unofficial copy" warning window,
  which has only two IPC handlers. Network errors pass so offline users
  are not locked out. Fill in `REPO_OWNER`/`REPO_NAME` in
  `src/shared/constants.ts` once the repository exists — until then,
  auto-update and the gate no-op.

## Known gaps (explicit, per the threat model)

- **asarUnpack-ed natives sit outside app.asar** (`sodium-native`,
  `better-sqlite3`), so the asar-integrity fuse does not cover them.
- **DHT-relayed connections** may expose the relay's IP rather than the
  peer's; ban matching on IP accepts this false-positive trade-off (HWID
  is also self-reported — identity rebuild after a ban is an accepted
  trade-off per spec 4.2).
- The **integrity gate is a second line of defense**, not a guarantee:
  someone who strips the gate from their own rebuild gets no warning.
  Code signing is the real fix and is out of scope for v1.
- **Unbans by moderators while the creator is offline** are broadcast but
  not merged into the authoritative DB until the creator returns (bans
  sync on the reconnect ping; unbans rely on the creator seeing the
  broadcast).
- A **sender's interrupted transfer** resumes automatically while its
  app stays running (peer reconnect); after the sender's own restart the
  task is reattached in a paused state and re-offered to the receiver
  when they reappear.

## Testing with an emulated second user

Two real app instances can run side by side on one machine to exercise the
full P2P flow (create/join rooms, chat, transfers, previews, bans):

```sh
npm run user2                      # "TestUser2"
node scripts/test-second-user.mjs --name Alice   # more users, own sandboxes
node scripts/test-second-user.mjs --name Alice --fresh   # wipe + regenerate
```

The script launches the real app with:

- **its own userData directory** (`--user-data-dir`), so the instance gets
  separate settings, HWID cache, ed25519 keypair, room/chat/ban databases
  and a separate single-instance lock;
- **a compiled PowerShell shim first on PATH** that answers the app's
  HWID hardware query (`Win32_BaseBoard` …) with different, realistically
  formatted and persisted values — a genuinely different "machine", so
  ban-by-HWID behaves like two physical computers — while delegating
  every other PowerShell use (e.g. the receive-folder lock helper) to
  the real `powershell.exe` unchanged. No app code is modified.

The shared LAN IP between the two instances is itself realistic: it
exercises the spec's "HWID OR IP" ban matching exactly as two machines
behind one NAT would. Each sandbox suggests a receive folder under
`.test-users/<name>/received` (the folder picker defaults there in the
setup gate).

## Environment notes (github.com unreachable)

This machine currently cannot reach `github.com` (codeload tarballs,
prebuilt binary downloads). The workaround used here:

```sh
npm install --ignore-scripts
cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
cd ../better-sqlite3 && npx --yes node-gyp@10.3.1 rebuild --release \
  --runtime=electron --target=$(node -p "require('electron/package.json').version") \
  --dist-url=https://artifacts.electronjs.org/headers/dist
```

(npm's injected `node-gyp@9.4.1` defaults to the ClangCL toolset, which is
not installed; node-gyp 10.3.1 uses plain MSVC. `python -m pip install
setuptools` provides the `distutils` shim node-gyp needs on Python ≥3.12.)
On machines with normal GitHub access, plain `npm install` fetches the
Electron prebuilds directly and none of this is needed.
