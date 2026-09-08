# Changelog

## 1.0.0 — 2026-09-07

The first release. A cross-platform daemon that runs [Pi Coding Agent](https://pi.dev)
sessions as supervised subprocesses and serves them, plus workspaces, files, and terminals, to
any client over pi's own remote-session protocol and a JSON API. See
[docs/overview.md](docs/overview.md) for how it works and [docs/operating.md](docs/operating.md)
before exposing it to a network.

### Supported pi

`>=0.84.0 <0.86.0`, detected at start and reported in `GET /v1/capabilities`. CI runs the
daemon's runner and pi-protocol server against the real pi at both ends of the range (0.84.0
and 0.85.1) on every push. A pi upgrade inside the range needs no daemon release; one outside
it makes `pi-daemon doctor` warn and the daemon still try.

### Platforms

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Node | 22.19+, 24 | 22.19+, 24 | 22.19+, 24 |
| Service | systemd user unit, `enable-linger` | LaunchAgent | logon scheduled task (no admin); no boot-time Service in 1.0 |
| PTY | forkpty, prebuilt (glibc and musl, x64 and arm64) | forkpty, prebuilt | ConPTY, prebuilt |
| Local endpoint | Unix socket, 0600 | Unix socket, 0600 | named pipe |
| Install | no compiler on any of them | | |

### Capabilities

What `GET /v1/capabilities` can list, and when it moves to `absent`:

| Feature | Present when |
| --- | --- |
| `dialogs` | always: pi's `extension_ui_request` relayed verbatim, first answer wins |
| `fork`, `sse`, `groups`, `files`, `diff` | always |
| `files.write` | `files.write` is true in the config (default) |
| `worktrees` | `git` is on PATH |
| `terminals` | `terminals.enabled` is true and the PTY addon loaded; the reason is logged otherwise |

Always absent in 1.0: `commandRuns`, `push`, `containers`, `turnResume`, `terminalPersistence`.

Limits, all in the config and in `capabilities.limits`: 8 runners, 16 terminals, 10 000
scrollback lines, 4 MiB per served file, 30 minutes idle before a runner is evicted, a 2 000
event replay ring, 8 MiB frames.

### Surfaces

- **pi-protocol** (`/pi/v1/socket`, subprotocol `pi.v1`, and the local endpoint): the server
  half of `@earendil-works/pi-protocol` 0.84.4, driven in CI by pi's own `PiClient`. Leases are
  all shared, as the protocol has no exclusive attach.
- **`/v1`** JSON: sessions and every RPC command that has a name, projects, workspaces, groups,
  worktrees, the read-write file API with `ETag`/`If-Match`, terminals, devices, pairing, and
  one event stream over WebSocket or SSE with a global sequence and `since` resume. The contract
  is `@coresoft-hq/pi-daemon-contract` 1.0.0: TypeBox schemas and OpenAPI 3.1 generated from
  them.

### Measured

- A runner is about 100 MB RSS and starts in 0.5–1 s warm.
- An idle terminal costs the daemon about 13 MB RSS on Windows (0.5 MB of it heap); a full
  10 000-line scrollback at 120 columns adds about 4 MB.
- Soak (fake pi, Windows): 8 runners at the cap with LRU eviction and deliberate crashes,
  16 terminals at the cap with one streaming to nobody, five event clients and five terminal
  clients flapping every two seconds. Five minutes with a forced GC before every sample:
  retained heap flat between 20 and 30 MB throughout; RSS 270 → 377 MB (V8's reserved heap and
  ConPTY buffers, back to 272 MB after stop); zero orphaned processes and zero open handles after
  stop; the event ring stayed bounded. Runner churn alone over a minute: RSS flat at 94 MB. The
  24-hour run is the operator's to launch:
  `node --conditions=development --expose-gc scripts/soak.mjs --minutes 1440`.
- Fuzzing: framed CBOR (truncation, coalescing, oversized and 4 GiB declared lengths, nesting
  to 5 000, malformed UTF-8, unknown properties, random bytes) and JSONL (random chunking through
  multi-byte characters, `U+2028`/`U+2029`, garbage lines) — no crash, no phantom record, and a
  good client is served after every round.

### Installing

One line per platform installs the CLI; `pi-daemon setup` then registers the service (`install`
remains as an alias). The release workflow builds a self-contained npm tarball (the contract
package and `typebox` bundled, so `npm i -g pi-daemon-<v>.tgz` works without the registry
scope), a Windows portable zip with its own `node.exe` for winget, checksums, and a GitHub
Release; `install.sh` and `install.ps1` install from those, downloading Node on Linux when the
machine has none. The Homebrew formula and winget manifests live under `packaging/`.

### Fixed during hardening

- The daemon imported `typebox/value` without declaring `typebox` as a dependency; the
  monorepo hid it. Found by installing the tarball into a fresh prefix, which CI now does.

- node-pty left one pipe handle open per closed terminal on Windows, and a terminal whose shell
  exited on its own kept its ConPTY alive until the record was deleted. Both released now.
- WebSocket servers accepted `ws`'s default 100 MiB messages before validation; the event and
  terminal sockets are capped at 64 KiB and 1 MiB, the pi-protocol socket at the frame limit.
- Local endpoints are `chmod 0600` on POSIX.

### Not in 1.0

Command runs, push notifications, containers, turn resume after a daemon restart, terminal
survival across a daemon restart, workspace search, scoped pairing, multi-user. Each is an open
question in [docs/spec.md §11](docs/spec.md) with the reasoning.
