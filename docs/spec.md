# pi-daemon — specification

Version 1, draft for approval. Derived from the requirements in §1 and from what
[Pi](https://pi.dev) actually forces. Verified against `@earendil-works/pi-coding-agent`
**0.84.4**.

---

## 1. Requirements

Restated from the brief, because everything below is justified against these and nothing else.

1. **One daemon, three operating systems.** Linux, macOS, Windows. Not a port — one build that
   behaves the same on all three.
2. **Remote clients of every shape.** Phones, tablets, laptops, and a web page in a browser.
3. **Drives the pi agent harness**, in the way pi's own remote surface and an ADE need it
   driven. **`pi-ade` is the first ADE client**, and it integrates with this daemon rather than
   with Orca — so projects and worktrees are owned here (§3.1), and the ADE consumes them.
4. **Client neutral.** No client is privileged, no client is required. The clients we build live
   in their own repositories and use the same published contract as anyone else's.
5. **Pairing by code or QR code**, so a phone can be granted access without typing a secret.
6. **Reached over a tailnet.** Tailscale or equivalent is the expected path in.
7. **v1 covers sessions, projects and worktrees, groups, a read-write file API, and terminals.**
   Files: tree, contents, diff, and add / update / delete / move, because an ADE that cannot show
   or change files is not usable. Groups: a logical grouping of projects and worktrees that is
   not folder-based, so a list of thirty things can be read. Terminals: ordinary interactive
   shells in a workspace, as Orca has them. Command runs, schedules, push notifications, and
   unread state are v2.
8. **Tailnet-aware, token-authoritative.** Reachability is never authorisation.

### 1.1 What follows from requirement 2

Requirement 2 is the one that does the most work, because a phone is not a laptop with a smaller
screen. It is a client that disappears without warning, stays gone for hours, returns on a
different network, and cannot hold a socket while backgrounded. So:

- A turn must run to completion with **no client attached at all**. Not "keep the connection
  alive" — the session's lifetime cannot depend on any client existing.
- Reconnection must be a **resume from a watermark**, not a multi-step rejoin.
- Every moment where the agent blocks on a human — a question, a dialog, a dangerous command —
  must be a message on a wire that any client can answer, because the client that started the
  turn is probably not the client that will answer.

### 1.2 Non-goals

- **Not a hosting service.** One daemon, one machine, one owner. No multi-tenancy, and no
  public-internet exposure — Funnel and reverse proxies are unsupported in v1. A *fleet* of
  daemons on several machines is a client-side composition of single-machine daemons, not a
  daemon that knows about other daemons; v1 does not build it but is careful not to rule it out
  (§11.9).
- **Not a sandbox.** Isolation comes from the OS, a container, or a micro-VM (§7).
- **Not a client.** The only UI is a CLI for the operator.
- **Not a fork of, or a patch to, pi.** The daemon drives pi as pi is published.

### 1.3 Prior art, and what is actually novel here

Almost none of the *shape* is. Worth stating, because it means the risky parts are the few places
we differ rather than the design as a whole.

**Orca** already ships this shape. `orca serve` runs a headless per-host runtime; `orca
environment add --pairing-code orca://pair?code=…` saves a remote runtime from a pairing code;
`--mobile-pairing` prints a mobile-scoped pairing QR; `--pairing-address` exists so the advertised
endpoint can be "a reachable LAN, **Tailscale**, SSH-forward, or reverse-proxy endpoint"; and the
runtime serves a web client with pairing data embedded in the URL. It models hosts, projects,
repos, and worktrees as first-class, and it supervises agents as **processes**. Every structural
choice in §2 has a counterpart there, which is a good sign about the choices and a warning against
thinking any of them is clever.

**Pi's published packages** contain no server. `@earendil-works/pi-coding-agent` has no HTTP or
WebSocket listener outside provider OAuth callbacks; `pi-client` and `pi-protocol` are the client
half and the schemas; `pi-web-ui` is a component library, and at 0.75.3 it trails the agent's
0.84.4. So whatever runs pi's web surface, the server side of it is not something anyone can
install — which is exactly the gap §4 fills. (Evidence here is the published artifacts; a hosted
implementation is not visible from outside.)

Two real differences remain, and they are where the argument lives:

**Structured, not a terminal.** Orca drives agents through managed PTYs — `terminal read`,
`terminal send`, `terminal wait --tui-idle` — which is agent-agnostic and works with anything
that has a TUI. This daemon drives pi through its RPC protocol, so it gets typed transcript items,
tool-execution events, and `extension_ui_request` instead of screen text and an idle heuristic.
For requirement 2 that difference *is* the product: a phone can render a real transcript, show a
tool call as a structured item, and answer a dialog with a button rather than by typing into a
scrape. The price is that this works with pi and nothing else, where Orca works with any agent.

**Someone else's protocol on the front door.** Orca's clients speak Orca's own schema. Ours speak
pi's, so pi's client library works against us unmodified (§4) — which is what requirement 4 asks
for and what nothing else currently provides.

One consequence of `pi-ade` sitting on this daemon rather than on Orca: there is exactly one
owner of the worktree and project model for pi work, which is this daemon. The ADE does not keep a
second registry, and nothing in `/v1` assumes a client has one.

---

## 2. Architecture

Two decisions define this daemon. Both are derived here rather than assumed, because both look
obvious in the wrong direction at first.

### 2.1 A session is a supervised `pi` process, not an object in the daemon

Pi can be driven two ways: import `AgentSession` from the SDK and host it in-process, or spawn
`pi --mode rpc` and speak its documented JSONL protocol over stdio. Pi's own documentation
recommends the former for Node applications. **This daemon does the latter**, for reasons that
come from §1.1 rather than from taste.

**Shared fate contradicts the central promise.** Requirement 2 says a turn survives every client
leaving. In-process, one unhandled rejection inside pi, one runaway extension, one OOM on a large
repository takes down the daemon and *every* session on the machine at once. Process-per-session
converts a total outage into one degraded session, and it is the only structure where "sessions
outlive things" is true of the daemon itself.

**Eviction and rehydration become exact.** A session with no attached clients has its process
killed; the session's JSONL file is untouched and remains the source of truth. Attaching again
respawns `pi --mode rpc --session <id>`. Memory is reclaimed by the operating system with
certainty, rather than by hoping a disposed object and its extension graph are collectable. The
session's identity is the file, which is what pi already believes.

**Confinement becomes structural.** RPC mode has no `--cwd` flag; it uses the working directory
it was spawned in. The daemon therefore *sets* the workspace rather than validating a path
argument, and there is no code path where a client-supplied string becomes a working directory.
`--tools` / `--exclude-tools` likewise pin the tool set at spawn, where a client cannot reach.

**The interactive surface already exists.** RPC mode emits `extension_ui_request` on stdout and
accepts `extension_ui_response` on stdin, covering `confirm`, `select`, `input`, and `editor`,
plus fire-and-forget `notify` / `setStatus` / `setWidget`. Every blocking human moment in §1.1 —
the agent's question, an extension's dialog, an approval — is that one documented mechanism, so
the daemon relays instead of implementing (§7.2). In-process it would be three mechanisms — a
custom tool, a supplied UI context, and a tool hook — and the daemon would own the policy behind
all three, which is precisely the thing pi is better placed to decide.

**Coupling gets looser where pi moves fastest.** Pi is at 0.84.4 and its remote protocol is
explicitly experimental with no compatibility guarantees. Importing the SDK means pinning an
exact version and cutting a daemon release for each pi release. Driving the CLI means a
documented protocol, the pi the operator already installed, and the credentials they already
authenticated — the daemon never handles a provider key at all.

**What this costs, stated plainly.** A process per active session — measured in M0 at
~100 MB RSS and 0.5–1 s of warm spawn latency (the first start after install can take ~30 s,
so the daemon warms a runner at startup), bounded by eviction and a session cap. Process supervision, and
tree-kill of a runner *and its tool children* on three platforms (§9). No typed events: the
daemon parses JSONL, and must do so with a hand-rolled splitter, because pi's docs warn that
Node's `readline` is not protocol-compliant — it splits on `U+2028`/`U+2029`, which are legal
inside JSON strings. And it contradicts pi's own recommendation, which is worth weighing: that
recommendation optimises for an application embedding an agent, not for a daemon whose product
*is* isolation and uptime.

```
                       ┌──────────────── pi-daemon (one process) ─────────────────┐
   phone   ─┐          │                                                          │
   tablet   ├─ CBOR ──▶│  access ──▶ serve ──▶ sessions ──▶ runners               │
   browser  │          │                          │            │                  │
   laptop   ├─ JSON ──▶│                     workspaces        │  spawn + JSONL    │
   curl    ─┘          │                          │            ▼                  │
                       │                          os ◀───── pi --mode rpc  × N     │
                       └──────────────────────────────────────────┬───────────────┘
                                                                  ▼
                                                    ~/.pi/agent/sessions/*.jsonl
                                                        (the source of truth)
```

### 2.2 No SDK dependency

Following 2.1 through: the daemon does not import `@earendil-works/pi-coding-agent` at all.

History comes from a runner via the `get_entries` / `get_messages` RPC commands, so the daemon
never parses pi's session format and cannot skew against it. Listing sessions *without* spawning
needs the session directory —
`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`, documented and keyed by working
directory, which conveniently means "sessions in this workspace" is a directory read. The daemon
reads only file names and each file's header line: id, name, timestamps. Not the transcript.
The daemon uses pi's **default** store deliberately — a `--session-dir` of its own would give a
flat layout without the `--<path>--` key (M0), but would also hide daemon sessions from a
terminal `pi`, which §3 promises not to do.

One caveat on "the file is the source of truth": pi's session storage is pluggable —
`@earendil-works/pi-session-backend-sqlite-node` and `pi-storage-sqlite-node` exist — so JSONL
under `~/.pi/agent/sessions` is the *default* backend rather than the only one. Enumeration
(§5.1) reads that layout directly and is the one place that assumes it; if an operator switches
backends, enumeration degrades to what a runner reports and the daemon says so rather than
silently listing nothing.

Total external coupling: the `pi` **binary** at runtime, discovered on `PATH` or configured, with
a declared supported version range checked by `doctor`; `@earendil-works/pi-protocol`, a small
standalone package of schemas, CBOR, and framing, needed only for §4; and one native addon,
below. Node **>= 22.19.0**, ESM, TypeScript.

**One native addon, behind a capability.** Terminals (§5.5) need a pseudo-terminal, and there is
no pure-JavaScript way to open one. The daemon uses `node-pty`, whose install tries a prebuilt
binary first and compiles only if none matches — the same dependency Orca ships, prebuilt. M0
found that upstream 1.1.0 ships prebuilds for Windows and macOS only; **on Linux it compiles**,
so honouring the guarantee below means shipping Linux prebuilds ourselves, using a multiarch
fork, or moving the PTY into the sidecar — a decision M1 makes before M7 depends on it. It is
loaded lazily and only by `terminals`; if the addon is missing or fails to load, the daemon runs
without it and `capabilities.absent` lists `terminals`. So the install guarantee is narrower than
"no native code" and is stated exactly: **no compile step on the three mainstream platforms, and
never a daemon that fails to start because of it.** A per-platform sidecar binary owning the PTYs
is the fallback if prebuild coverage proves worse than expected; plan M0 measures this before
anything depends on it.

### 2.3 Structure

**Two packages.** A package boundary with no second consumer is speculation, and this repository
starts with no code. Exactly one boundary has a real external consumer:

| Package | Why it is separate |
| --- | --- |
| `pi-daemon` | The daemon and its CLI. Internal modules, one build, one service registration. |
| `@coresoft-hq/pi-daemon-contract` | Our `/v1` shapes, schemas, and generated OpenAPI. Published, because clients in other repositories compile against it. |

Internal modules, with dependencies pointing one way — `access → serve → sessions → runners`,
and `workspaces` beneath `sessions`:

Inside `pi-daemon` these are directories, not packages, each named for the one thing it owns:

| Module | Owns |
| --- | --- |
| `runners` | Spawning, supervising, and killing `pi --mode rpc`; JSONL framing; the RPC command/response/event vocabulary. The only place that knows pi exists. |
| `sessions` | Canonical session state and its `revision`, the event log with resume, leases, the pending-dialog table, eviction. |
| `workspaces` | Projects, worktrees, registration, git status, and session enumeration per workspace. |
| `serve` | The two wire encodings (§4, §5) and the event stream. Holds no state. |
| `access` | Devices, tokens, pairing, tickets, TLS, bind selection. |
| `terminals` | PTY spawn and kill, the server-side screen model, the byte stream (§5.5). The only place allowed to import `node-pty`. |
| `os` | Every OS-specific primitive (§9), and the only place allowed to branch on platform. |

Three rules are enforced by an import-boundary lint, because these are the ones that rot
silently: **nothing outside `runners` may know pi exists**, **nothing outside `os` may branch on
the operating system**, and **nothing outside `terminals` may import `node-pty`**. `os` is a directory rather than a package for the reason above — one
consumer, no versioning need — and it gets its own test suite regardless, because it is where
"works on my machine" lives.

Extract further packages when a second consumer appears, not before.

---

## 3. Identity

| Id | Meaning |
| --- | --- |
| `sessionId` | **Pi's own session id**, from pi's session file. Never minted by us. |
| `workspaceId` | A directory the daemon may run sessions in. |
| `projectId` | A git repository, keyed by the canonical path of its main worktree. |
| `groupId` | A named, logical grouping of projects and workspaces. Registry metadata only; no filesystem meaning. |
| `deviceId` | A paired client device, with a role and its own token. |
| `dialogId` | One outstanding `extension_ui_request` awaiting an answer (§7.2). |

Two rules about ids, cheap now and expensive to retrofit. **Every id the daemon mints is random
and globally unique** — a ULID, never a counter and never derived from a path — so a workspace
that is one day moved to another machine keeps its id, and a client holding several daemons never
sees two things with the same name. And **the daemon itself has an id**: `daemonId`, minted once
at install and persisted, with a human name, returned at pairing and in `capabilities`, so a
client that has paired with three machines can tell them apart, address them, and scope what it
stores per daemon. Event `seq` (§5.2) is scoped to one daemon; a client of several holds one
watermark each.

**`sessionId` is pi's, and that is the point.** A session the daemon starts is resumable with
`pi --session <id>` in a terminal, and a session started in a terminal is visible to every paired
client. The daemon adds remote access to pi's sessions; it does not create a parallel universe of
its own.

**Paths are internal, with one imposed exception.** `/v1` names things by `workspaceId` only, so
platform path semantics — case sensitivity, drive letters, separators, length limits, reserved
names — never enter our contract. pi-protocol imposes the exception: `cwd` is optional on
`create` and required on every `SessionSnapshot`, and we cannot change its schemas (§4.3). An
inbound `cwd` is therefore an assertion to check, never an instruction: canonicalise it, require
it to resolve to a registered workspace, otherwise refuse. What the daemon then hands the runner
is the workspace's own canonical path, as a spawn directory.

### 3.1 Projects, workspaces, worktrees

A **project** is a git repository; a **workspace** is a checkout of it. Registering a repository
creates the project, a workspace for its main worktree, and a workspace for each linked worktree
it already has. Creating a worktree through the daemon does branch, directory, and registration
in one call, so a client gets from "start a task" to "session in a clean tree" in one round trip.
Removing one refuses while a session is attached unless forced. Registering a directory that is
not a repository gives a standalone workspace and no project — not everything worth pointing an
agent at is a repo.

**Groups** are how a client keeps a long list readable. A group has a `groupId`, a name, an
optional colour, and an optional sort order; it can hold **projects and workspaces alike**, and an
item can sit in **any number of groups** — a worktree can be in "client X" and in "this week"
at once. Membership is a property of the item (`groupIds` on a project or workspace), so a
project's worktrees do not inherit its groups unless a client puts them there; the daemon does not
guess. Groups are pure registry metadata: they have no folder, they move nothing, and deleting one
removes only the grouping — the members stay registered and appear under "ungrouped". They are
flat in v1; nesting would be additive. Every list route takes `?group=<id>` or `?group=none`, and
`GET /v1/groups/:id` returns the group with its members expanded, which is the call an ADE's
sidebar actually makes.

A workspace is the unit of confinement (§7) and of session enumeration (§2.2). A session belongs
to exactly one.

This model is sized for `pi-ade`, which is the consumer that actually needs it: a phone can live
with "start a session somewhere sensible", an ADE cannot. It is also why files (§5.4) hang off a
`workspaceId`: the registered root is the only thing the daemon will ever serve bytes from.

---

## 4. Surface A — pi's session protocol

`@earendil-works/pi-protocol` **v1, unmodified**: a four-byte big-endian length followed by one
definite-length CBOR item. Pi publishes the schemas and a client (`PiClient`, `RemoteSession`)
but ships no server, so the daemon implements the missing half. Requirement 4 is why: a client
speaking this protocol is talking a contract that someone other than us versions and documents,
and pi's own client library drives the daemon with no adapter.

### 4.1 Endpoints

| Transport | Address | For |
| --- | --- | --- |
| WebSocket, binary frames | `wss://<host>:<port>/pi/v1/socket` | Every network client, browsers included |
| Local socket | Unix domain socket, or a Windows named pipe | Same-machine clients. Filesystem permissions are the boundary; no TLS, no token |

`pi-client` ships the Unix-domain transport and a `ByteTransportFactory` seam, so a browser
client writes about twenty lines of WebSocket factory and nothing else.

### 4.2 Message set

Client: `hello` carrying `PROTOCOL_VERSION`, then correlated requests wrapping `list`, `create`,
`attach`, `detach`, `prompt`, `steer`, `abort`, `set_model`, `set_thinking`.

Server: `hello` or `hello_error`, correlated `response` envelopes, and `event` envelopes carrying
`session_snapshot`, `session_progress`, `session_removed`, `server_snapshot`. Errors use pi's
seven codes: `version`, `busy`, `session_locked`, `not_found`, `invalid_request`,
`not_implemented`, `internal_error`.

**Snapshots are authoritative; progress is a hint.** `SessionSnapshot` carries a monotonic
`revision` and is the only thing a client may reduce into state. Progress — `item_started` /
`item_updated` / `item_finished`, `assistant_delta` — exists so a UI can paint a streaming turn.
The daemon holds to this on the producing side too: it emits no progress that a later snapshot
will not confirm.

### 4.3 What adopting someone else's schemas costs

1. **It cannot be extended.** The schemas reject unknown object properties — no extra field, no
   new message type. Everything pi's protocol does not model must live somewhere else, which is
   *why* there are two surfaces (§5). Not a preference.
2. **`cwd` is on the wire**, handled as in §3.
3. **Authentication completes before protocol bytes** — pi-protocol's own rule. For WebSocket
   that means the HTTP upgrade (§6.4).
4. **`not_implemented` is a legitimate answer**, which is how the daemon stays conforming while
   declining something an operator has locked down.
5. **Frame limits are configuration, not negotiation.** Both ends must agree; the daemon
   advertises its limit (§10) and defaults to 8 MiB against pi's 16 MiB ceiling.

### 4.4 Leases

Pi's client already models this, so the daemon implements the server half. One **exclusive** lease
or any number of **shared** leases per session; exclusive acquisition fails while any lease
exists, shared fails while an exclusive one does, and the error is `session_locked`, reflected in
`SessionSnapshot.locked` / `.attached`. A mutating command without a suitable lease is refused,
not queued — two phones fighting over one turn is a thing to surface, not to serialise.
Disconnection releases that connection's leases and **does not** stop a running turn (§8).

### 4.5 The gap

pi-protocol does not model: `followUp`, queue modes, compaction, tree navigation and forking,
renaming, bash execution, session statistics, `ask_user`, extension dialogs, tool approvals,
project trust, projects and worktrees, authentication, pairing, or device management. RPC mode
covers most of it, so the gap is a wire-format gap rather than a capability gap — which is
exactly the shape of Surface B.

---

## 5. Surface B — the daemon API

JSON over HTTP under `/v1`, plus one event stream. Defined in `pi-daemon-contract`, additive
within a version, `/v2` for anything breaking.

### 5.1 Routes

Most session routes are a thin, named mapping onto an RPC command, which is why the surface is
broad without being deep.

| Route | Backed by |
| --- | --- |
| `GET /v1/health` | — Unauthenticated. Liveness and version only |
| `GET /v1/capabilities` | — The document in §10 |
| `POST /v1/pair/redeem` | — Unauthenticated by construction; rate limited |
| `GET /v1/devices` · `DELETE /v1/devices/:id` | — Owner only; revocation closes live connections |
| `POST /v1/connect-tickets` | — Single-use ticket for a browser's Surface A upgrade |
| `GET /v1/projects` · `GET /v1/workspaces` | Registry + git summary; `?group=<id>` or `?group=none` to filter |
| `PATCH /v1/projects/:id` · `PATCH /v1/workspaces/:id` | Set `groupIds`, and a display name |
| `GET /v1/groups` · `POST /v1/groups` · `PATCH /v1/groups/:id` · `DELETE /v1/groups/:id` | Groups (§3.1). Delete removes the grouping, never a member |
| `GET /v1/groups/:id` | The group with its projects and workspaces expanded |
| `POST /v1/workspaces` · `DELETE /v1/workspaces/:id` | Registration. Never deletes anything on disk |
| `POST /v1/projects/:id/worktrees` · `DELETE .../:workspaceId` | git worktree add / remove |
| `GET /v1/workspaces/:id/status` | Branch, ahead/behind, dirty summary; watcher-invalidated cache |
| `GET /v1/workspaces/:id/tree` | Directory listing under a relative path (§5.4) |
| `GET /v1/workspaces/:id/file` | File contents, bounded, with `ETag` and `Range` (§5.4) |
| `GET /v1/workspaces/:id/diff` | Unified diff for one path or the working tree (§5.4) |
| `PUT /v1/workspaces/:id/file` · `DELETE /v1/workspaces/:id/file` | Create or replace, and delete, with `If-Match` (§5.4) |
| `POST /v1/workspaces/:id/mkdir` · `POST /v1/workspaces/:id/move` | Directories and renames, inside the workspace (§5.4) |
| `POST /v1/workspaces/:id/terminals` · `GET /v1/terminals` · `GET /v1/terminals/:id` | Open and inspect terminals (§5.5) |
| `DELETE /v1/terminals/:id` · `POST /v1/terminals/:id/resize` | Close and resize (§5.5) |
| `wss://…/v1/terminals/:id/stream` | The terminal's bytes, both directions (§5.5) |
| `GET /v1/sessions` | Session-directory enumeration, joined to live runner state |
| `POST /v1/sessions` | Spawn a runner in `workspaceId` |
| `GET /v1/sessions/:id` | Canonical snapshot, JSON-encoded |
| `GET /v1/sessions/:id/entries` | `get_entries` |
| `POST /v1/sessions/:id/prompt` | `prompt`, with `Idempotency-Key` so a retry over a flaky link cannot double-send |
| `POST /v1/sessions/:id/steer` · `/follow-up` · `/abort` | `steer` · `follow_up` · `abort` |
| `POST /v1/sessions/:id/queue-mode` · `/clear-queue` | `set_steering_mode` / `set_follow_up_mode` · `clear_queue` |
| `POST /v1/sessions/:id/compact` | `compact` |
| `POST /v1/sessions/:id/model` · `/thinking` | `set_model` · `set_thinking_level` |
| `POST /v1/sessions/:id/name` | `set_session_name` |
| `GET /v1/sessions/:id/tree` · `POST /v1/sessions/:id/fork` | `get_tree` · `fork` |
| `GET /v1/sessions/:id/stats` | `get_session_stats` |
| `POST /v1/dialogs/:dialogId/respond` | One `extension_ui_response`. Every blocking human moment — a question, an approval, an extension's dialog — is this one route (§7.2) |

Responding is idempotent per `dialogId` and last-write-wins: whoever answers first resolves it,
everyone else gets a `409` naming the resolution. With three devices watching one session that is
the correct behaviour, not a race to design away.

### 5.2 The event stream

One connection per client, not one per session: `GET /v1/events` (WebSocket, JSON) with
`GET /v1/events/sse` for networks where a socket will not hold. Subscriptions are mutable over
the open connection. Envelope `{ seq, scope, type, at, payload }`; scopes are `daemon`,
`workspace:<id>`, `session:<id>`.

**One global monotonic `seq`, not one per scope.** A client resumes with a single watermark,
`?since=<seq>`. Per-scope sequences plus mutable subscriptions produce the question "which
watermark do I resume from?", which has no good answer. The cost is that a filtered stream has
gaps, so the contract says so outright: **gaps are normal and are not loss.** Order within the
stream is total.

A bounded replay ring — 2000 events or 8 MiB, whichever binds first — backs the resume. A `since`
older than the ring gets one `snapshot.required` event rather than a partial replay; the client
re-reads state and continues from the new watermark. Without that fallback specified, a resume
mechanism quietly loses events under load and looks fine in testing.

Types: `session.created` · `session.phase` · `session.interrupted` · `session.evicted` ·
`session.removed` · `runner.failed` · `transcript.item_started` · `transcript.item_updated` ·
`transcript.item_finished` · `transcript.assistant_delta` · `dialog.opened` · `dialog.closed` ·
`notice` (relayed fire-and-forget `notify` / `setStatus` / `setWidget`) · `workspace.changed` ·
`project.changed` · `group.changed` · `workspace.files_changed` · `terminal.created` · `terminal.exited` ·
`terminal.title` · `device.paired` · `device.revoked` · `daemon.shutdown` · `snapshot.required`.

### 5.3 One state producer, two encodings

The surfaces are siblings, not layers:

```
  runner JSONL ──▶ sessions: canonical state ──┬──▶ CBOR encoder ──▶ Surface A
                          (+ revision)         └──▶ JSON encoder ──▶ Surface B
```

Neither encoding derives from the other; both carry the same `revision`, so a client using both —
plausible for a rich client wanting pi's transcript reducer *and* the daemon's dialog relay — can
fence one against the other.

It is duplicated work and a real drift risk. It buys requirement 4: a client in Swift, Kotlin,
Python, or `curl` needs neither CBOR nor a pi dependency to be complete, while a JavaScript
client gets pi's own tested transcript reducers for free. A single producer plus a conformance
test asserting both encodings agree on one fixture stream is what keeps it honest.

### 5.4 Files

Read-only, and the one place the daemon serves bytes itself rather than relaying pi — so it is
the one place the daemon's own path checks carry weight (§7.3). Everything is addressed as a
`workspaceId` plus a path **relative to the workspace root**; there is no route that takes an
absolute path, and there is no route that reads outside a registered workspace, because
registration is what "the daemon may serve this" means.

**`GET /v1/workspaces/:id/tree?path=<rel>&depth=<n>`** returns entries — name, kind (`file`,
`dir`, `symlink`), size, mtime, and whether git ignores it. `depth` defaults to 1 and is capped;
listings are paged by cursor so a `node_modules` cannot become a 40 MB response. By default `.git`
and ignored entries are omitted, and `?all=1` includes them, because an ADE wants both views.
Symlinks are reported as symlinks with their target *if the target is inside the workspace*, and
are never followed by the listing.

**`GET /v1/workspaces/:id/file?path=<rel>`** returns the bytes with a content type from a small
sniff (text with detected encoding, or `application/octet-stream`), an `ETag` derived from mtime,
size, and a content hash, and honours `Range` and `If-None-Match`, so an ADE re-validates an open
file for the cost of a header. Responses are capped at `maxFileBytes` (default 4 MiB); a larger
file returns `413` with the size, and the client asks for a range. `HEAD` gives metadata alone.

**`GET /v1/workspaces/:id/diff?path=<rel>&base=<ref>`** returns a unified diff of the working
tree against `HEAD`, or `base`, for one path or — with no `path` — the whole tree, bounded the
same way. It exists because `status` already lists changed files and a changed-files list without
the diff is half a feature.

**Writes.** `PUT /v1/workspaces/:id/file?path=<rel>` creates or replaces a file with the request
body, byte for byte — the daemon never transforms line endings or encodings. Replacing an existing
file **requires `If-Match`** with the `ETag` the client last read, and a mismatch is `412`; this is
what stops an editor tab from silently overwriting a file the agent changed a second ago.
`If-None-Match: *` makes a create-only request. Writes are atomic — temp file then rename in the
same directory — and preserve the file mode on replace, so an executable stays executable.
`?parents=1` creates missing directories; `POST …/mkdir` makes an empty one.

`DELETE …/file?path=<rel>` takes the same `If-Match`. Directories need `?recursive=1`. A symlink
is removed as a link, never followed. The workspace root and `.git` cannot be deleted through this
route at all. `POST …/move { from, to, overwrite? }` renames within the workspace, both paths
boundary-checked (§7.3); it is a plain rename, so git sees a delete and an add until something
stages it — the daemon does not touch the index.

Every write the daemon performs emits `workspace.files_changed` with `origin: "api"` and the
`deviceId`, so an ADE can ignore its own echoes and every other client learns the file moved.
There is no lock against a running turn, deliberately: pi's `edit` tool checks what it read before
it writes and fails loudly on a stale file, and the ADE gets `412` from `If-Match`. Optimistic on
both sides, with no lock for either to forget to release.

**`workspace.files_changed`** on the event stream carries a bounded, debounced list of relative
paths, so an ADE knows an open file went stale without polling. The watcher behind it is the one
already invalidating git status. Recursive watching is native on macOS and Windows; on Linux
inotify is per-directory and limited, so the daemon watches the directories a client has listed
recently and falls back to polling the rest (§9). The contract says the event may be **coalesced
or late, never wrong**: a path in the list changed, but not every change produces a path.

Not in v1: search across a workspace (§11.8). An operator who wants a daemon that can show but
not change files sets `files.write: false`, and the write routes return `403 write_disabled`.

### 5.5 Terminals

An ordinary interactive shell in a workspace — the terminal Orca gives you, reachable from a phone
or a browser. Not a pi session, not a command run, no structure: a pseudo-terminal, its bytes, and
the daemon keeping the screen so a client can leave and come back.

**`POST /v1/workspaces/:id/terminals { cols, rows, argv? }`** opens one. The daemon spawns the
operator's shell — the selection rules in §9 — with the workspace root as the working directory,
`TERM=xterm-256color`, `COLORTERM=truecolor`, and an environment scrubbed of anything the daemon
holds; no daemon secret is ever visible to a shell. An optional `argv` array runs something other
than the shell; it is an array and never a string, for the reason given in §9. The response is a
`terminalId`. `GET /v1/terminals` and `GET /v1/terminals/:id` give workspace, pid, size, the
title the program last set, status, and exit information once there is any. `DELETE` closes the
PTY, waits a bounded grace, then tree-kills whatever is left.

**`wss://<host>/v1/terminals/:id/stream`** carries the bytes. Binary frames are PTY bytes in both
directions; text frames are a small JSON control channel — `resize`, and `snapshot` from the
server. The upgrade is authenticated exactly as Surface A's (§6.4). Output does not travel on the
JSON event stream: it is binary, high-volume, and the wrong shape for base64 in an envelope.

**The daemon keeps the screen.** A terminal's output is fed into a headless emulator sized to the
terminal — `@xterm/headless`, pure JavaScript, the same core the web client will likely use — with
a bounded scrollback (default 10 000 lines). On attach the server sends a `snapshot` text frame
whose payload is the **serialised buffer as VT sequences**: escape codes that reproduce the screen
and scrollback in any emulator, not a structured grid of our own design. Then live bytes follow.
So a phone reconnecting after an hour sees the terminal as it is, not a replay of everything it
missed, and a client using `ghostty-web`, `xterm.js`, `SwiftTerm`, or libghostty renders that
snapshot with its own engine and never needs to understand a format we invented.

**Why not libghostty in the daemon, yet.** It was the obvious question. libghostty-vt is the
better emulator, and Coder publishes Node-API bindings for it with prebuilt binaries — but only
for Linux and macOS, with Windows explicitly unsupported until its build path is verified, against
an upstream API that Ghostty still marks unstable. That fails requirement 1 today. It also does
not provide the PTY, which is the part that actually forces native code, so it would be a second
native dependency rather than a replacement for the first. The screen model therefore sits behind
one interface — feed bytes, resize, serialise — and `@xterm/headless` implements it in v1. Swapping
in libghostty-vt when it has Windows prebuilds is a one-module change and is worth doing then,
because the daemon's snapshot and the client's rendering would come from the same code. Where
libghostty helps *now* is the clients: `ghostty-web` is a drop-in for `xterm.js` in the browser
with better grapheme and complex-script handling, and native mobile clients can embed libghostty
directly. The daemon's job is to make that possible, which raw bytes plus a VT snapshot does.

**Sharing and size.** Any number of clients may attach to one terminal; all receive output and all
may type, interleaved by arrival, like a shared tmux window. Size is last-resize-wins, stated
rather than clever. A client that cannot keep up gets a bounded per-connection buffer and is then
disconnected with a reason, because the PTY read loop must never block on a slow phone; it
reattaches and receives a fresh snapshot.

**Lifetime.** A terminal survives every client leaving — the same promise as a session. It does
**not** survive a daemon restart: a PTY is a child of the daemon, and when the daemon stops the
shell gets `SIGHUP` and `terminal.exited` records why. tmux-style survival would need a separate
long-lived holder process and is a v2 question (§11.2). Limits: `maxTerminals` (default 16) and
scrollback are in `capabilities`.

**Trust.** A terminal is a shell as the daemon user. That is precisely what pi's `bash` tool
already is (§7.1), so it adds nothing to the threat model; it does add a switch — `terminals:
false` — for an operator who wants the daemon's reach to stop at reading.

---

## 6. Access

### 6.1 Tokens

`pid_<deviceId>_<secret>`, with 32 CSPRNG bytes base64url. The daemon stores `sha256(secret)` and
never the token, comparing in constant time; `deviceId` makes verification one hash rather than a
scan. Tokens are revoked, not expired, and each device has its own, so a lost phone costs one
revocation instead of re-pairing everything. Records hold id, name, platform, role, created and
last-seen, and the hash — written atomically, owner-only.

### 6.2 Pairing

`pi-daemon pair` prints a QR code and a text fallback:

```json
{ "v": 1, "host": "hostname.tailnet.ts.net", "port": 8790, "fp": "<sha256 of TLS SPKI>", "code": "K7M4-QP2X" }
```

The **code** is eight Crockford base32 characters — unambiguous through a camera and over a phone
call — single-use, valid 120 seconds, one at a time, dead after five failed attempts. It is not
the durable secret; it buys one token, once.

The **fingerprint** is why a QR beats a typed password: the client pins it at redemption, so a
code photographed off a screen cannot be redeemed against someone else's endpoint, and tomorrow's
daemon is provably the one it paired with. `POST /v1/pair/redeem { code, deviceName, platform }`
returns `{ daemonId, deviceId, token, role, capabilities }` — capabilities included so a fresh
client knows what it is talking to before its first real call, and `daemonId` so it can file the
pairing under the machine it belongs to. `pair --confirm` additionally demands a local
`y/N` at the moment of redemption. `pair --list` / `--revoke <id>` work from the machine itself,
which matters when the lost phone is the one holding the owner token.

### 6.3 Roles

`owner` manages devices, workspace registration, and approval policy; `member` does everything
else. Two roles that people will actually understand beat five that nobody configures.

### 6.4 Authenticating a Surface A upgrade

pi-protocol wants authentication finished before protocol bytes, which for WebSocket means the
upgrade request. Browsers cannot set headers on a WebSocket, so there are two mechanisms:

1. `Authorization: Bearer <token>` — native clients, preferred.
2. `?ticket=<t>` — a single-use 30-second ticket from `POST /v1/connect-tickets`, bound to the
   device and peer address. A credential in a URL is acceptable *only* under those terms; a
   long-lived token in a URL never is.

`Sec-WebSocket-Protocol: pi.v1` is required either way. A failed upgrade is refused with an HTTP
status before the socket opens, never with a protocol-level `hello_error` — which would imply the
connection had been trusted.

### 6.5 Bind, TLS, tailnet

`bind` is `loopback` (default, plaintext permitted, unreachable off-box), `tailscale` (address
resolved from the local Tailscale API, TLS required), or an explicit address (TLS required, with a
warning that Windows will raise a firewall prompt on first non-loopback bind).

| TLS mode | Browser |
| --- | --- |
| `tailscale-cert` — a cert for `<host>.<tailnet>.ts.net`. **Recommended** | Publicly trusted: real `wss://`, no interstitial, no mixed content |
| `self-signed`, fingerprint pinned via the QR | Painful; no clean browser story |
| `off` — loopback only | n/a |

Requirement 2's web client decides this. A page in a secure context will not open a plaintext
WebSocket, and a page cannot pin a self-signed fingerprint the way a native client can, so a
publicly-trusted certificate for a private address is the only clean answer. `tailscale serve`
terminating TLS in front of the daemon is supported as an alternative.

**Tailnet identity is additive, never authoritative** (requirement 8). Where Tailscale is present
the daemon may read peer identity for display and enforce an optional allowlist of tailnet users.
A token is still required, always: making authentication correctness depend on a second daemon
being installed, running, and healthy trades a real security property for a small convenience. If
Tailscale is missing or its local API unreachable, `doctor` says so and the daemon keeps working.

---

## 7. Safety

### 7.1 Stated plainly

**Pi has no sandbox.** Its built-in tools read, write, and run shell commands with the
permissions of the process, and extensions are TypeScript with the same permissions. Therefore
**a valid device token is code execution on this machine as the user running the runner.** That
is not a daemon defect, it is what a remote coding agent is. Everything below is depth around
that fact, not a boundary around it. Operator guidance says so: run as a user that owns only what
it should reach, treat a device token as equivalent to SSH access, and use a container for
untrusted repositories.

One thing the architecture does remove: **the daemon never handles a provider credential.** The
runner uses the operator's own pi authentication, and no route exposes a key. Terminals (§5.5)
and file writes (§5.4) add nothing here — a shell as the daemon user is exactly what pi's `bash`
tool already is — but the daemon does scrub its own environment before spawning either, so a
shell cannot read a device token out of `env`.

### 7.2 Approvals belong to pi. The daemon is a relay.

**The daemon has no approval system, no policy file, and no rules engine.** Deciding whether a
tool call is acceptable is pi's job, configured by the operator in their own pi setup — settings,
their own extensions, whatever gate they already run. The daemon's entire contribution is to
carry the question to a client and the answer back.

That is possible because RPC mode already externalises it. Anything in pi that blocks on a human
— an extension's `ctx.ui.confirm()`, `select()`, `input()`, or `editor()`, whether it came from
a permission gate, a workflow extension, or the operator's own code — surfaces as an
`extension_ui_request` on stdout and waits for a matching `extension_ui_response` on stdin. The
daemon relays that pair, verbatim, to whichever clients are attached, and returns the first
answer it receives.

So there is **one mechanism and one pair of events** (§5.2), not three. The daemon does not
classify a request as "an approval" versus "a question" versus "a dialog", because it cannot tell
them apart and has no business guessing: it forwards `method`, `id`, and payload, and a client
renders what it likes. Fire-and-forget methods — `notify`, `setStatus`, `setWidget`, `setTitle` —
are relayed as advisory events with no response expected.

What the daemon does own is the small amount of state a relay needs: which requests are
outstanding, which client answered, a timeout, and what happens when nobody does. On timeout the
daemon sends no response and lets pi's own behaviour apply — RPC mode auto-resolves a dialog
carrying a `timeout` field, so inventing a second timeout on top of pi's would produce two
authorities disagreeing about one dialog.

This is a deliberate reversal of an earlier draft, which specified `approvals.json`, a matcher
engine, and remembered decisions with TTLs. All of it duplicated a decision pi is better placed
to make, and it would have meant every operator configuring their tool policy twice, in two
formats, with the daemon's copy silently winning.

### 7.3 Confinement

Confinement is not policy, and it stays in the daemon because it is a property of *how a runner
is started* rather than of what the agent asks for:

- The runner is **spawned in** the workspace directory. There is no `--cwd` flag and no code path
  where a client-supplied string becomes a working directory.
- Its tool set is pinned at spawn by `--tools` / `--exclude-tools`, out of a client's reach. An
  operator who wants a read-only daemon gets it here — together with `files.write: false` and
  `terminals: false` — in one configuration, not through a rules file.
- A terminal starts in the workspace but is a shell: `cd ..` works. The workspace is a starting
  point for a terminal, a boundary only for the file routes.
- Path canonicalisation — `resolve` → `realpath` → drive-letter case → separators — happens where
  the daemon accepts a workspace, so a symlink out of the tree is caught at registration rather
  than followed later.
- The file routes (§5.4) apply the same canonicalisation to every request: the relative path is
  joined to the root, resolved through `realpath`, and refused unless the result is still inside
  the root. `..`, absolute paths, drive-relative paths, and symlinks whose target leaves the tree
  all fail the same check, with a `403` that names the rule and not the path. This is the one
  place the daemon itself is the boundary, so it gets a dedicated test list (plan M6).

Note what this does *not* do: it does not stop the agent from reading outside the workspace once
`read` is enabled, because pi has no sandbox (§7.1). Confinement here bounds what the daemon
*starts*, not what a running agent can reach. The honest boundary is a container, which is v2.

### 7.4 Project trust

Pi's project trust decides whether project-local settings, extensions, skills, and prompts load —
a supply-chain guard on inputs, not a sandbox. RPC mode never prompts and applies the operator's
`defaultProjectTrust`, which is the correct outcome and needs nothing from the daemon.

So the daemon does not manage trust either. It spawns without `-a` or `-na` and lets pi apply the
operator's setting; a per-workspace override in daemon configuration is available for an operator
who wants one, and the effective state is reported in the snapshot so a client can display it.
Surfacing trust as a *remote decision* was in an earlier draft and is dropped for the same reason
as approvals: it is pi's decision, already recorded in `~/.pi/agent/trust.json`, and a second
copy would drift.

### 7.5 Remaining controls

Logs redact by default: tool arguments and results are summarised, because arguments routinely
contain secrets; verbatim logging is opt-in and says why. Rate limits with backoff on
`/v1/pair/redeem`, `/v1/connect-tickets`, and failed upgrades, so guessing a 120-second base32
code online is uninteresting. Per-workspace containerised execution is the real isolation answer
and is v2; the workspace record reserves the field.

---

## 8. Lifecycle

**A turn survives every client leaving.** Requirement 2's hard promise, and the runner model is
how it is kept: the runner is a child of the daemon, not of a connection, and nothing about a
client disconnecting touches it. Events accumulate in the ring; a returning client resumes from
its watermark.

**Eviction.** No leases and no activity for `idleTimeout` (default 30 minutes) → the runner is
shut down gracefully, then killed, and `session.evicted` goes out. The session stays listable
because the JSONL file is the truth, and the next attach respawns
`pi --mode rpc --session <id>`. A session cap (default 8 concurrent runners) evicts
least-recently-used beyond the limit.

**Runner death is one session's problem.** A crashed or OOM-killed runner emits `runner.failed`,
marks the session `interrupted`, and leaves every other session untouched. This is the property
§2.1 was chosen for, and it is worth a test that kills a runner mid-turn and asserts the rest of
the daemon does not notice.

**Daemon restart is not turn resume.** Sessions list and rehydrate with full history after a
restart, because history is pi's file. A turn that was streaming when the daemon stopped is gone:
it is marked `interrupted`, surfaced as an event and in the snapshot, and the client decides
whether to re-prompt. Pi's harness does model durable operations — `SuspendedOperation` carries a
`crash` reason and there is a `resume()` — but that is inside `@earendil-works/pi-agent-core` and
is not reachable through either the CLI or the coding-agent package's public exports, so the spec
promises `interrupted` and not resume. The contract is shaped so resume can arrive additively:
`interrupted` already carries the run id one would need.

**Shutdown.** Stop accepting connections, emit `daemon.shutdown`, give runners a bounded drain
window (default 10 s) to reach a persisted boundary, then tree-kill, then release the lock.
Windows has no `SIGTERM`, so this is driven by `SIGINT` / `SIGBREAK`, a loopback control
endpoint, and the service manager's stop — never by assuming a signal arrives.

---

## 9. The three operating systems

Organised by what the daemon actually does, since that is where the differences bite. All of it
lives in `os`.

**Spawning a runner.** Argv arrays only, never a shell string — the daemon's own invocations
(`pi`, `git`) have no reason to involve a shell, and doing so is how quoting bugs become
injection bugs. The `pi` binary is resolved once at startup, not per spawn: on Windows the entry
is a shim (`pi.cmd` / `pi.ps1`), so the resolved target and the spawn mechanics differ from
POSIX. Where a *user* supplies a literal command, shell selection is POSIX `$SHELL -lc`, Windows
`pwsh -NoProfile -Command` falling back to `powershell.exe` then `cmd /c`.

**Killing a runner.** A runner spawns tool children — compilers, test runners, package managers —
and killing the runner alone orphans them. This is genuinely different per platform:
`taskkill /T /F` against the process tree on Windows, POSIX process-group `kill(-pid)` with a
`detached` spawn so the group exists. Getting this wrong leaks processes slowly and looks like a
memory leak.

**Opening a terminal.** `node-pty` with ConPTY on Windows 10 1809 and later — older builds fall
back to the bundled winpty, which the daemon reports rather than hides — and `forkpty` elsewhere.
Shell selection reuses the runner rules: `$SHELL -l`; `pwsh`, then `powershell.exe`, then `cmd`.
The environment is scrubbed of daemon state before the spawn. ConPTY resizes by repainting, so a
resize storm from a phone rotating is coalesced before it reaches the PTY. Closing follows the
runner pattern: close the PTY, wait a bounded grace for the shell to exit on `SIGHUP`, then
tree-kill — `taskkill /T /F` or the process group — because a shell with a stuck child is the
common case, not the edge case.

**Talking to a runner.** JSONL over stdio pipes, split on `\n` only, tolerating a trailing `\r`,
with a hand-rolled splitter because Node's `readline` also splits on `U+2028`/`U+2029` and is
therefore not protocol-compliant. Pipe buffers differ enough that backpressure must be handled
rather than assumed.

**Serving clients.** Loopback by default; any other bind is explicit, and the first non-loopback
bind on Windows raises a firewall prompt, so the CLI warns before it happens. The local endpoint
is a Unix domain socket under the state directory, or a Windows named pipe
(`\\.\pipe\pi-daemon`) — reachable through the same `net.connect(path)` seam `pi-client` uses,
which is verified rather than assumed (§M1 in the plan), with loopback TCP as the fallback if it
does not hold.

**Being a service.** One `ServiceManager` interface: a systemd **user** unit plus
`loginctl enable-linger` so it survives logout on a headless box; a LaunchAgent with `RunAtLoad`
and `KeepAlive`; on Windows a scheduled task at logon needing no admin (the default), a Service
for boot-time start, or a Startup shortcut. Single instance via a lockfile taken by exclusive
open holding pid and port, with liveness confirmed by probing the port rather than trusting a pid,
because pid reuse differs.

**Touching the filesystem.** One canonicalisation at ingest — `path.resolve` →
`realpath.native` → drive-letter case → separators — storing canonical and display forms
separately. Windows `MAX_PATH`, plus `CON PRN AUX NUL COM1-9 LPT1-9` and trailing dot or space:
all legal git branch names and all illegal directory names, which is precisely the worktree
creation path, so it is validated before `git worktree add` rather than after it fails. Watching
is narrow-path and debounced with a polling fallback, because inotify limits, FSEvents
coalescing, and `ReadDirectoryChangesW` do not agree.

**Writing things down.** Data, config, log, and state directories resolved in one place:
`%LOCALAPPDATA%\pi-daemon`, `~/Library/Application Support/pi-daemon`,
`$XDG_STATE_HOME/pi-daemon`. Log rotation is ours — journald and Console.app are not universal —
size-based, capped, JSON lines. Event time is daemon time; a client's clock never orders
anything, `seq` does.

---

## 10. Capabilities

`GET /v1/capabilities` is how a client learns what it is talking to instead of inferring it:

```json
{
  "daemon":     { "id": "01J9…", "name": "ove-desktop", "version": "1.0.0", "platform": "win32", "startedAt": 1756880000000 },
  "api":        { "version": 1 },
  "piProtocol": { "version": 1, "maxFrameLength": 8388608 },
  "pi":         { "version": "0.84.4", "supported": ">=0.84.0 <0.86.0", "path": "detected" },
  "features":   ["dialogs", "worktrees", "groups", "files", "files.write", "diff", "terminals", "fork", "sse"],
  "absent":     ["commandRuns", "schedules", "push", "containers", "turnResume", "terminalPersistence"],
  "limits":     { "maxRunners": 8, "maxTerminals": 16, "scrollbackLines": 10000, "maxFileBytes": 4194304, "idleTimeoutMs": 1800000, "replayRing": 2000 }
}
```

`pi.version` is **detected, not pinned**, which is a direct benefit of §2.1: the daemon declares a
supported range, `doctor` checks the installed binary against it, and a pi upgrade inside the
range needs no daemon release. `features` and `absent` are both explicit so a client degrades
against a fact rather than a failed call — `terminals` moves to `absent` on a machine where the
PTY addon did not load, and `files.write` moves there when the operator has switched it off.

---

## 11. Open questions

1. **Push notifications.** A backgrounded phone cannot hold a socket, so "the agent is asking you
   something" needs APNs/FCM, which needs a relay holding credentials — a service, and a
   cross-repo decision. v1 emits the events such a relay would consume and stops there.
2. **Terminal persistence across a daemon restart.** A PTY is a child of the daemon, so terminals
   die with it (§5.5) while sessions do not. Surviving a restart means a separate long-lived
   holder process — what tmux is — which is a real piece of infrastructure and a second thing to
   install as a service. Worth deciding whether "restart the daemon, lose your shells" is
   acceptable for v1, since the alternative is not small.
3. **Runner reuse.** RPC mode has `new_session` and `switch_session`, so one process could serve
   several sessions in turn. That trades away the isolation §2.1 was chosen for, and is only
   worth revisiting if spawn latency or memory measures worse than expected.
4. **Scoped pairing.** Orca distinguishes a *mobile-scoped* pairing link from a full runtime
   pairing link (§1.3). Our v1 has only `owner` / `member` (§6.3), so a phone paired for reading
   and answering dialogs gets the same reach as a laptop. A third, narrower scope is plausible and
   cheap to add later; whether it earns its place in v1 is worth deciding at approval.
5. **Multi-user machines.** One daemon per user account is the v1 model.
6. **Losing the owner device.** Recovery is local CLI access. Whether a second owner should be
   mandatory is an operator policy call.
7. **How stable is RPC mode, really?** It is documented and used by real integrations, which is
   why §2.1 leans on it, but it carries no explicit compatibility guarantee. The mitigation is
   the supported-range check plus the conformance suite; whether to also pin a known-good `pi`
   version as a fallback install is worth deciding before 1.0.
8. **Search.** A `grep`-like search across a workspace is the remaining obvious ADE need that is
   not in v1. It attaches to `workspaceId`, needs no new model, and is bounded the same way as
   `tree`; the only question is whether `pi-ade` blocks on it.
9. **Fleets, and moving a workspace between daemons.** Not v1, but explicitly not ruled out. The
   scenario: a tablet creates a workspace and is asked *which daemon* to create it on; a laptop
   that runs its own daemon offloads a workspace to a desktop before a trip, context intact. What
   makes this reachable from here, and what to keep true:
   - *Choosing a daemon* is entirely client-side — a client holds several pairings, each with a
     `daemonId` and name, and picks. No daemon change.
   - *A move* is what the daemon already does, in two places: **evict on the source, rehydrate on
     the destination.** A session is a file and a runner is respawned from it (§8), so moving a
     session is copying its JSONL and respawning `--session <id>` elsewhere. A workspace's
     working tree moves as git — push or bundle the branch, carry dirty and untracked files —
     and re-registers under the same `workspaceId`, group membership included. Terminals do not
     move; a turn in flight does
     not move; the move happens at idle, which the lease and phase model already expresses.
   - *Daemon-to-daemon transfer* over the tailnet needs one daemon to authenticate to another.
     The single-use ticket pattern (§6.4) is the natural shape: the client asks the destination
     for a transfer ticket and hands it to the source. Nothing in §6 prevents a daemon being a
     client of another daemon.
   - *"Context intact" is achievable, and M0 showed how.* Copying a session file and opening
     it by explicit path (`--session <file>`) from a different directory works: same id, full
     history, regardless of the recorded `cwd`. Opening by *id* from a different directory
     instead triggers pi's own "Session found in different project — fork into current
     directory?" prompt, which RPC mode cannot answer — so a move is always file plus path,
     never id alone. Still open: linked git worktrees store absolute paths to their main
     repository, so a worktree moves either with its project or by becoming a fresh worktree of
     the destination's clone.
   - *Storage format is not the lever.* Sync between daemons is easy because pi's sessions are an
     append-only log of immutable entries with `id` / `parentId` — a union by id merges two
     copies with no conflicts — and that holds for JSONL and for pi's SQLite backend alike. At
     the file level SQLite is *harder* to move (a live database cannot be safely copied), and the
     CLI cannot be pointed at it anyway; it is a `pi-agent-core` repository class, reachable only
     in-process. If pi later surfaces it in the CLI, the runner inherits it and the daemon gains
     id-keyed sessions and cross-session search for free.
   - *What would rule it out*, and is therefore avoided: path-derived or sequential ids, daemon
     state that assumes a workspace was born on this machine, and any client contract that
     addresses a session without saying which daemon it lives on. The ids rule in §3 and
     `daemonId` in pairing and `capabilities` are the whole cost today.
