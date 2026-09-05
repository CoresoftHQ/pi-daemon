# pi-daemon — implementation plan

Companion to [the specification](spec.md). Ten milestones, each independently demonstrable, each
with acceptance criteria that are testable rather than aspirational.

**Status (2026-09-05): approved; M0 complete — GO (results in
[`spike/README.md`](../spike/README.md)); M1 complete, CI matrix green on the `develop` branch;
M2 complete; M3 complete; M4 complete apart from its human security review and the manual
browser-over-`tailscale cert` check. M5 is next.**

---

## Sequencing

Two unproven claims carry the whole design, and both are settled before any structure exists.

1. **That the daemon can implement the server half of `pi-protocol`.** Pi publishes the schemas
   and a client but no server, so nothing has ever validated that pairing. If it fails, the
   two-surface design collapses.
2. **That `pi --mode rpc` is a sufficient substrate.** Spec §2.1 chooses a supervised subprocess
   over importing the SDK, against pi's own documented recommendation. Whether RPC mode's
   vocabulary really covers what Surface A must produce — a `SessionSnapshot` with a monotonic
   `revision`, transcript items, phase — is a matter of evidence, not argument.

Both are M0. Everything after it assumes M0 said yes.

Auth arrives at M4, after the wire works. M1–M3 run with a static development token from config:
that lets the protocol work be judged on its own, and makes M4 a replacement of one marked seam
rather than a retrofit through moving code.

```
  M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6 ─▶ M7 ─▶ M8 ─▶ M9
  ▲           ▲     ▲            ▲           ▲
  │           │     │            │           └─ terminals; the one native addon
  │           │     │            └─ contract published; clients repo can start
  │           │     └─ first end-to-end: a real client drives a real session
  │           └─ runners supervised and projected, no network involved
  └─ go / no-go on the load-bearing claims
```

---

## M0 — Feasibility, in throwaway code

**Purpose.** Answer both questions in the sequencing note before committing to anything.

**Result: GO** (2026-09-04, Windows, pi 0.84.4). Items 1–7 and 9 verified; item 8 verified
headless-to-headless, browser check pending. Measured: ~100 MB RSS per runner, 0.5–1 s warm
spawn (cold first start ~30 s), ~450 ms rehydrate, first token 1.2–2.9 s. Two findings change
later milestones: upstream `node-pty` ships **no Linux prebuild**, so M1 must pick between our
own prebuilds, a multiarch fork, or the sidecar; and moving a session works by explicit file
path, not by id (spec §11.9). Full table in `spike/README.md`.

**Build.** One scratch directory, nothing published, nothing structured.

1. Spawn `pi --mode rpc` in a temp workspace. Drive `prompt`, `steer`, `follow_up`, `abort`,
   `get_state`, `get_entries`, `set_model`. Confirm the JSONL splitter handles fragmentation and
   a `U+2028` inside a JSON string without desynchronising.
2. **Project RPC events into a `SessionSnapshot` with a monotonic `revision`**, and feed the
   result to pi's own `applyTranscriptSnapshot` / `applyTranscriptProgress` reducers. This is the
   crux: if `agent_start` / `message_update` / `tool_execution_*` / `agent_end` cannot be mapped
   onto pi-protocol's transcript items faithfully, §2.1 is wrong.
3. Stand up a WebSocket server speaking framed CBOR via `encodeServerMessage` and a client-message
   decoder, and drive it from a real `PiClient` — `hello`, `create`, `attach`, `prompt`, `abort`,
   `detach`.
4. Relay one `extension_ui_request` out and an `extension_ui_response` back, using an extension
   loaded with `-e` that calls `ctx.ui.confirm()`. Confirm the runner blocks until answered.
5. Kill the runner mid-turn. Confirm the daemon notices, the process tree dies with it, and a
   respawn with `--session <id>` recovers the history.
6. Measure: runner RSS, spawn-to-first-token latency, and RSS across five concurrent runners.
7. **Load `node-pty` from its prebuilt binary, with no compiler present**, on the Windows, macOS,
   and Linux CI images. Open a shell, resize it, close it, confirm the tree is gone. This is the
   claim behind spec §2.2's install guarantee.
8. Feed a session of real output through `@xterm/headless`, serialise the buffer, and replay the
   serialised bytes into both `xterm.js` and `ghostty-web` in a browser. The screens must match
   the live one. If they do not, the snapshot design in §5.5 needs a structured fallback.
9. *Probe, not gate:* copy a finished session's JSONL into the session directory for a
   **different** workspace path and open it with `pi --session <id>` from that directory. Note
   whether pi accepts a recorded `cwd` that differs from the actual one. Ten minutes; it decides
   how much "context intact" a future workspace move (spec §11.9) can promise.

**Acceptance.** `RemoteSession.create()` → `submit()` → streamed transcript → `abort()`, through
our server, with pi's client library unmodified, backed by a real subprocess. The reducers
produce a transcript matching a fixture. A `ctx.ui.confirm()` round-trips. Measured memory and
latency are within the §2.1 estimate, or the estimate is corrected. The PTY addon loads without a
compiler on all three images, and a serialised snapshot reproduces a screen in two emulators.

**Exit conditions.** If (2) fails, revisit Surface A. If (6) is far worse than estimated,
reconsider in-process hosting or runner reuse (spec §11.3) before M1. If (7) fails on any
mainstream platform, the PTY moves into a per-platform sidecar binary before M7 is planned in
detail.

---

## M1 — `os`, and the runner supervisor

**Purpose.** The two riskiest mechanical things, together, because the supervisor is what exposes
the platform differences.

**Result (2026-09-05, Windows):** `packages/daemon/src/os` and `src/runners` exist with 51
tests (48 pass, 3 platform skips) running under Node's type stripping with no build step; a
fake `pi` (`test/fake-pi.mjs`) lets the runner suite run with no pi installed. Verified here:
tree-kill takes a runner's tool child; drive-letter case canonicalises equal; a junction out of
the root is refused; reserved Windows names are rejected; the named-pipe endpoint accepts
`net.connect(path)` (loopback fallback not needed); JSONL survives `U+2028` and byte-level
fragmentation; a dead runner turns dialog answers into `false`, not exceptions. The Linux
`node-pty` prebuild decision is deferred to M7 with the multiarch fork as the default choice;
the systemd and launchd adapters are unit-tested by rendered output and round-trip on CI when
`PI_DAEMON_SERVICE_TESTS=1`.

**Build.** `os`: directory resolution, argv spawn, `pi` binary discovery including the Windows
shim, process-tree kill, path canonicalisation, atomic write, debounced watch with a polling
fallback, single-instance lock with port-probe liveness, service adapters (systemd user unit +
linger, LaunchAgent, Windows scheduled task and Service), JSON-line log rotation.

`runners`: spawn, the JSONL codec, command correlation, event dispatch, graceful stop then
tree-kill, crash detection, restart-on-attach.

**Acceptance.** Suite green on a Windows / macOS / Linux matrix. Specific cases: a runner's tool
children die with it — spawn a runner, have it start a long-running child, kill the runner,
assert nothing is orphaned. A drive-letter case difference canonicalises equal. A symlink out of
a root is detected. A reserved Windows name is rejected as a directory. `install` → `status` →
`uninstall` round-trips on each platform. A named-pipe endpoint accepts a `net.connect(path)`
client on Windows — the spec's one explicitly unverified claim (§9), with loopback TCP as the
documented fallback if it fails.

---

## M2 — `sessions`: state, events, leases

**Purpose.** A session layer fully exercisable with no network and no live model.

**Result (2026-09-05):** `packages/daemon/src/sessions` — canonical `SessionState` with
`revision`; the projector ported from the spike with pi's rules baked in (user items have no
`item_finished`; history keeps pi's durable entry ids via `get_entries`); the event log with one
global `seq`, a ring bounded by count and bytes, `since` replay, and gap detection; leases;
the dialog relay table (first answer wins, runner death closes the dialog); `Session` with
`runId` minted at `agent_start` and returned from `prompt`; `SessionHost` with idle eviction,
an LRU runner cap, rehydration on attach, crash → `interrupted`, and a catalog that reads only
session-file headers. 27 tests against the fake `pi`, no network.

**Build.** Session registry keyed by pi's `sessionId`; the canonical state producer (snapshot +
`revision`, progress); the event log with one global monotonic `seq`, a bounded ring, `since`
resume, and `snapshot.required` on underrun; leases (exclusive/shared, per-connection ownership,
invalidation); the pending-dialog table with relay semantics (§7.2); idle eviction and the
session cap.

**Testing without a model.** The subprocess architecture makes this easier than it would
otherwise be: tests substitute a **fake runner** — a small script that speaks the RPC protocol
from a recorded script of events — for the real `pi`. No provider credentials, no network, fully
deterministic, and it exercises the real JSONL path rather than a mock of it. A separate suite,
gated behind an env var and run nightly, drives a real `pi` against a real provider to assert the
recordings still match reality.

**Acceptance.** Fixture-driven coverage of: a turn completing with zero attached clients; `seq`
monotonicity and gapless replay from any watermark; `snapshot.required` on a stale watermark;
lease refusal semantics; eviction after idle and transparent rehydration with full history; a
relayed dialog blocking the runner and resolving on the first answer, with later answers getting
`409`; a runner crash marking one session `interrupted` and leaving others untouched.

---

## M3 — Surface A

**Purpose.** First genuine end-to-end: a real client, on another machine, driving a real session.

**Result (2026-09-05):** `packages/daemon/src/serve` — a transport-neutral pi-protocol server
core over a `ByteDuplex` seam (WebSocket with upgrade-time auth and subprotocol, the local
socket / named pipe, and an in-memory pair for tests); the CBOR encoder over M2's state, with
our item types now mirroring pi's discriminated unions so the structural pin is a real check;
a single-root workspace resolver standing in for M6. The conformance suite drives the server
with pi's own `PiClient` — 17 cases: hello and version refusal, create/attach/detach, streaming
with authoritative snapshots and transient progress, `invalid_request` for a `cwd` outside the
root, `busy`, `not_found`, `not_implemented` for a disabled command, an unattached mutation
refused, oversized-frame disconnect, slow-consumer disconnect, reconnect with `revision`
fencing, and both real transports. Two findings folded into the spec: the wire `attach` has no
lease mode, so Surface A attachments are all shared (§4.4); and pi-client's Unix transport
helper refuses Windows even though the named pipe works (§4.1). Auth is a static token until M4.

**Build.** The pi-protocol server — WebSocket with binary frames, the local socket/named pipe,
`hello` version negotiation, request correlation, mapping onto pi's seven error codes, frame-limit
enforcement, per-connection lease tracking, backpressure — plus the CBOR encoder over M2's state
producer, and `cwd` validation against the workspace registry (a stub until M6). Auth is a static
config token, clearly marked.

**Acceptance.** A **conformance suite** driven by pi's own `PiClient`: every command, both
transports, both lease modes, all seven error codes, oversized-frame rejection, reconnect with
`revision` fencing. Manually: a laptop on the tailnet drives a session on another machine, and
killing the client mid-turn then reconnecting resumes the same turn.

This suite is also the standing regression gate for every future `pi` version bump.

---

## M4 — Access

**Purpose.** Make the daemon safe to expose, and delete the static token.

**Result (2026-09-05):** `packages/daemon/src/access` — device tokens `pid_<id>_<secret>` with
sha256 at rest, constant-time verify, and a burned comparison for unknown ids; the device
store written atomically at 0600 with the first device as owner; pairing codes (Crockford
base32, 120 s, single-use, five attempts, one active, a `--confirm` hook, the QR payload with
`fp` and `daemonId`); connect tickets (30 s, single-use, peer-bound, dropped on revocation); a
fixed-window limiter with `peek`; the authenticator (bearer everywhere, tickets on upgrades
only, failure lockout, tailnet identity additive with an optional allowlist that can refuse and
never admit); `/v1/pair/redeem`, `/v1/connect-tickets`, `/v1/devices` with the last-owner
guard; revocation closing a device's live protocol connections; TLS material for
`self-signed` (pure-JS `selfsigned`, SANs, reuse while valid) and `tailscale-cert`, with the
SPKI fingerprint. Tailnet identity comes from `tailscale status --json` rather than the
LocalAPI socket, which spares three per-platform socket paths. 16 tests. **Not done:** the
adversarial review is a human gate, and the browser-over-`wss://` check needs a tailnet with
HTTPS certificates enabled, which CI does not have — both carried to M9's release checklist.

**Build.** Device store (`pid_<id>_<secret>`, `sha256` at rest, constant-time compare, atomic
owner-only writes); pairing codes (Crockford base32, 120 s, single-use, attempt-capped) and QR
rendering with certificate-fingerprint channel binding; `POST /v1/pair/redeem`; connect tickets;
device list and revoke with live-connection termination; roles; rate limits with backoff. TLS:
`tailscale-cert`, `self-signed` with pinning, `off`. Bind modes including tailnet-address
resolution via the local Tailscale API, and the optional tailnet-user allowlist as an additive
check.

**Acceptance.** Pair a device from a QR code end to end. A code fails on second use, after 120 s,
and after five bad attempts. A revoked device's live socket closes within a second. A ticket fails
on second use and after 30 s. A wrong-host fingerprint aborts redemption client-side. With
Tailscale absent, `bind: tailscale` fails with a clear message and `doctor` explains it. **A
browser reaches the daemon over `wss://` with a `tailscale cert` and no interstitial** — the
concrete test of spec §6.5, and the thing the whole web-client requirement rests on.

**Gate.** Does not close without an adversarial pass over token handling, the pairing window, and
the upgrade path.

---

## M5 — `pi-daemon-contract` and Surface B

**Purpose.** The JSON surface, and the published contract other repositories build against.

**Build.** The contract package: request/response shapes, the `/v1` event envelope, runtime
schemas, OpenAPI generated from those schemas rather than maintained beside them. In the daemon:
the `/v1` routes from spec §5.1 except workspaces, the event stream over WebSocket with the SSE
fallback, mutable subscriptions, `since` resume, `Idempotency-Key` on prompt, the dialog relay
route, the JSON encoder over M2's producer, and `/v1/capabilities` with detected `pi` version and
supported range.

**Acceptance.** A **dual-encoding conformance test**: one fixture turn encoded both ways,
asserting CBOR and JSON carry the same transcript and the same `revision` — the standing guard
that makes §5.3's duplication safe. A `curl`-only client can create a session, prompt, stream
events, and answer a dialog. SSE resumes correctly across a dropped connection. Published at
`0.1.0`.

**Handoff.** `pi-ade` and the other clients can start here and proceed in parallel with M6–M9,
which add capabilities rather than breaking changes. M6 is the milestone the ADE actually waits
on, since it needs the worktree and file model; M5 alone is enough to begin the session and
transcript UI, and M7 adds the terminal.

---

## M6 — `workspaces`

**Purpose.** Make `pi-ade` possible: from "start a task" to "session in a clean tree", with the
files visible.

**Build.** Project and workspace registry with canonical paths and atomic persistence; groups
(§3.1) as registry metadata with membership on the item, `?group=` filters on the list routes,
the expanded `GET /v1/groups/:id`, and `group.changed`; repository
and linked-worktree discovery at registration; worktree create (branch + directory +
registration) and remove with attached-session refusal; git status summary with a debounced
watcher and cache invalidation; session enumeration per workspace by reading the session directory
and header lines only (§2.2); the real `cwd`-to-workspace resolution that M3 stubbed; the spawn
confinement of §7.3 — workspace as spawn cwd, tool set pinned by `--tools` / `--exclude-tools`.

The file surface (§5.4): `tree` with depth cap, paging, and ignore-awareness; `file` with
sniffing, `ETag`, `Range`, `If-None-Match`, and the size cap; `diff` via `git diff` for a path or
the tree; `PUT` / `DELETE` / `mkdir` / `move` with `If-Match`, atomic replace via `os`, mode
preservation, and the root / `.git` refusals; `workspace.files_changed` off the existing watcher
with `origin` and `deviceId`, and the Linux listed-directories-plus-polling strategy; the
`files.write: false` switch.

**Acceptance.** Registering a repository discovers its existing worktrees. Creating a worktree
yields an immediately usable workspace and a session in it. A branch name legal in git but illegal
as a Windows directory (`aux/fix`, a trailing dot) is rejected with a clear message *before*
`git worktree add` runs. Removal refuses while attached and succeeds with `force`. A group holds a project and a worktree
of a *different* project at once; an item is in two groups and appears under both filters;
deleting the group deletes nothing and both items list under `?group=none`. Status reflects
an external `git commit` within the debounce window on all three platforms.

**Write tests**: a `PUT` without `If-Match` on an existing file is `428`; with a stale `ETag` it is
`412` and the file is untouched; a replace of an executable keeps the mode on POSIX; a crash
injected between temp-write and rename leaves the original intact; `DELETE` on a directory
without `recursive` is `409`; `DELETE` on a symlink removes the link and not the target; `DELETE`
on `.git` and on the root are `403`; `move` across the boundary is `403`; every write produces
`files_changed` with `origin: "api"` and the caller's `deviceId`; with `files.write: false`
all four routes are `403 write_disabled`. Session enumeration
for a workspace with 500 sessions stays fast, because it reads header lines and not transcripts.

**File-boundary tests**, as a named list because this is where the daemon is the boundary: `..`
in a path; an absolute path; a drive-relative path (`C:foo`) on Windows; a symlink inside the
workspace pointing outside it, both as a `tree` entry and as a `file` target; a symlink chain;
a path that differs only by case on a case-insensitive filesystem; a UNC path; a path containing
`U+2028`. Each returns `403` and none touches the target. Plus: a 100 MB file returns `413` and
serves a `Range`; a binary file is sniffed as octet-stream; `If-None-Match` on an unchanged file
returns `304`; listing a tree with 50,000 entries pages and never allocates the whole listing;
an external edit to an open file produces `workspace.files_changed` within the debounce window
on all three platforms.

---

## M7 — `terminals`

**Purpose.** The ordinary shell, from a phone or a browser, and the one native addon done
carefully.

**Build.** Lazy loading of `node-pty` with the `terminals` capability flipping to `absent` on
failure; spawn with shell selection, workspace cwd, `TERM`, and the scrubbed environment; the
screen model interface with the `@xterm/headless` implementation and bounded scrollback; the
binary WebSocket stream with the JSON control frames; snapshot-on-attach via serialised VT;
multi-client fan-out with per-connection bounded buffers and slow-client disconnection; resize
coalescing; close-then-grace-then-tree-kill; `terminal.*` events; `maxTerminals`; the
`terminals: false` switch.

**Acceptance.** Open a terminal from the JSON API, attach from a browser with `ghostty-web` and
from `xterm.js`, type into both, see both update. Disconnect the browser, run `top` for a minute,
reattach: the snapshot shows the live screen and scrollback with no replay. A client throttled to
1 KB/s while `yes` runs is disconnected with a reason and the PTY never stalls. Closing a terminal
whose shell has a stuck child leaves no orphan on any platform. `env` inside the shell shows no
daemon token or path. On an image without the prebuilt binary, the daemon starts, `capabilities`
lists `terminals` under `absent`, and `POST …/terminals` is `501` with a message naming the
addon. Memory per idle terminal is measured and recorded in the release notes.

---

## M8 — Operations

**Purpose.** The daemon behaves like a daemon.

**Build.** The CLI: `serve`, `install`, `uninstall`, `start`, `stop`, `status`, `logs`, `pair`,
`doctor`. Single-instance enforcement; graceful shutdown with the drain window, `daemon.shutdown`,
then tree-kill; the loopback control endpoint for signal-less Windows shutdown; log rotation in
anger; eviction and the session cap tuned under real memory pressure.

**Acceptance.** Installed on each platform, the daemon survives logout (with linger on Linux) and
starts at logon. A second `serve` refuses, naming the running pid and port. `stop` drains
in-flight turns to a persisted boundary or reports that it could not, and leaves no orphaned
runners or tool children. After `kill -9` of the daemon, no runner survives, sessions list and
rehydrate with full history, and the turn that died reports `interrupted`. `doctor` correctly
diagnoses: no `pi` on `PATH`, `pi` outside the supported range, old Node, no authenticated
provider, port in use, unwritable data directory, missing Tailscale, expiring certificate, service
not installed, clock skew.

---

## M9 — Hardening and release

**Purpose.** Earn the version number.

- Full CI matrix: three platforms, two Node minors, and the **oldest and newest supported `pi`**
  — the version range in `capabilities` is a promise and needs testing at both ends.
- **Fuzz the decode paths.** Framed CBOR from untrusted bytes (truncation, coalescing, oversized
  declared lengths, deep nesting, malformed UTF-8, unknown properties) and JSONL from a runner.
  The CBOR path is the only attacker-reachable parser; the JSONL path is where a
  desynchronisation would silently corrupt state.
- **Soak, 24 hours.** Several sessions and several terminals, a client reconnecting on a flaky
  link, forced evictions and rehydrations, deliberate runner crashes, a terminal left streaming
  with no client attached. Watch for orphaned processes, fd leaks, ring growth, and scrollback
  memory.
- Load: 8 concurrent runners at the cap, 16 terminals at the cap, 5 clients on one session and
  on one terminal, sustained streaming.
- Second security review across the whole surface.
- Operator documentation: the §7.1 statement, threat model, tailnet and TLS setup, what the daemon
  deliberately does *not* decide (approvals, trust), recovery from a lost owner device.
- `1.0.0`, with the capability matrix and the supported `pi` range in the release notes.

**Acceptance.** No crash from either fuzzer. No growth and no orphans in the soak. Documentation
reviewed by someone who did not write it.

---

## Risks

| Risk | Handling |
| --- | --- |
| **RPC mode carries no explicit compatibility guarantee.** It is documented and used by real integrations, which is why §2.1 leans on it, but it is not a versioned contract. | Supported-range check in `doctor` and `capabilities`; the M3 conformance suite as the upgrade gate; CI at both ends of the range. Whether to also ship a known-good pinned `pi` as a fallback install is open (spec §11.6). |
| **pi-protocol is experimental with no compatibility guarantees.** | It is a small standalone package, pinned exactly. Same conformance gate. Accepted — the alternative is a protocol no other client knows. |
| **A process per session may cost more than estimated.** | Measured in M0, before structure exists. Bounded by eviction and the session cap. Runner reuse via `new_session` / `switch_session` is the documented fallback, at the cost of the isolation §2.1 was chosen for. |
| **Orphaned tool children.** Killing a runner without its tree leaks processes slowly and looks like a memory leak. | A first-class M1 acceptance criterion on all three platforms, and a soak assertion in M8. |
| **JSONL desynchronisation.** Pi's docs warn `readline` is not protocol-compliant. | Hand-rolled splitter, fuzzed in M8, with the `U+2028` case tested from M0 onward. |
| **RPC mode may not express something Surface A needs.** | M0 point 2 answers this before commitment. `not_implemented` is a conforming answer for a genuine gap. |
| **The PTY addon's prebuilds may not cover a platform.** `node-pty` compiles when no prebuild matches, which would break the no-compile-step install. | Verified in M0 on all three CI images before anything depends on it. Lazy-loaded behind a capability so the daemon still starts. A per-platform sidecar binary is the documented fallback. |
| **Terminals die with the daemon.** Sessions survive a restart; shells do not. | Stated in §5.5 and `capabilities.absent`; a tmux-style holder process is spec §11.2, not silently promised. |
| **Two encodings will drift.** | One producer, two thin encoders, and the M5 dual-encoding test as a standing gate. |
| **No sandbox: a token is host code execution.** | Stated rather than mitigated away (§7.1). Confinement bounds what the daemon starts; approvals are pi's; containers are the real answer and are v2. |
| **Scope creep from v2.** | §1.2 and §11 name what is not being built, and `capabilities.absent` makes each absence a fact clients can read. |

---

## What "done" means for v1

A phone on a tailnet can: pair by scanning a QR code; list projects; create a worktree; start a
session in it; browse the tree, open a file, and fix a typo in it; open a shell and run the tests;
send a prompt; watch the turn stream; answer a question the agent asks; approve a
command that the operator's own pi configuration decided to gate; lock the screen for an hour;
come back to a finished turn and an intact transcript.

A browser can be attached to that same session throughout, over `wss://` with no certificate
warnings, in either encoding. `pi-ade` can show the tree, open and edit files, see the diff of what the
agent changed, and give you a terminal in the worktree, from another machine.

And killing one session's runner does not disturb any of it.
