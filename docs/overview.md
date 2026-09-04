# pi-daemon in one page

## How the daemon works

**One process per machine**, installed as a user-level service, reachable on loopback by default
and on your tailnet when you say so. It owns three things: a registry of **workspaces** (git
repositories and their worktrees, or any registered directory), the **pi sessions** running in
them, and the **terminals** and **files** inside them.

**A session is a supervised `pi` process.** When a client starts or attaches to a session, the
daemon spawns `pi --mode rpc` in the workspace directory and talks to it over stdin/stdout in
pi's documented JSONL protocol. The daemon imports no pi SDK; it needs only the `pi` binary the
operator already installed and authenticated. The session's identity is pi's own session file, so
the process is disposable: a session nobody is attached to has its process killed after an idle
timeout and is respawned with `--session <id>` the next time someone attaches, with full history.
A crashed session is one interrupted session, not a dead daemon. A turn keeps running while every
client is gone — that is the central promise.

**The daemon keeps canonical state and relays the rest.** From the runner's events it maintains
one authoritative session snapshot with a monotonic `revision`, an event log with a single global
`seq` and a replay ring so clients resume from a watermark, and leases so two clients cannot fight
over one turn. Whenever pi needs a human — a question, an extension dialog, a command that pi's
own permission gate wants approved — pi emits `extension_ui_request`; the daemon relays it to
attached clients and returns the first answer. The daemon has no approval policy of its own:
approvals and project trust are pi's, configured by the operator in pi.

**Files and terminals are the daemon's own.** The file API reads and writes inside registered
workspace roots only, with every path canonicalised and checked; writes are atomic and require
`If-Match`. Terminals are real pseudo-terminals (`node-pty`, prebuilt); the daemon feeds their
output into a headless emulator so a client that reconnects gets the current screen as a VT
snapshot rather than a replay.

**Access is by device token, always.** A client pairs once by scanning a QR code carrying a
120-second single-use code and the daemon's certificate fingerprint, redeems it for its own
revocable token, and presents that token on every request. A tailnet is the expected transport
and TLS comes from `tailscale cert`, but reachability never grants anything.

## How clients integrate

**Pair, then read capabilities.** Scan the QR → `POST /v1/pair/redeem { code, deviceName,
platform }` → `{ daemonId, deviceId, token, role, capabilities }`. Store the token per `daemonId`.
`GET /v1/capabilities` tells you what this daemon can do (`features` / `absent`), which `pi`
version it drives, and its limits; degrade against that, not against failed calls.

**Two surfaces, one state.**

- **Sessions speak pi's own protocol** — `@earendil-works/pi-protocol`, framed CBOR over
  `wss://<host>/pi/v1/socket`. A JavaScript client uses `@earendil-works/pi-client` unchanged:
  `PiClient` / `RemoteSession`, plus about twenty lines of WebSocket transport. Create, attach,
  prompt, steer, abort, set model and thinking; receive authoritative snapshots and streaming
  progress. Any language can implement it from pi's published schemas.
- **Everything else is JSON under `/v1`**, typed by the published `@coresoft-hq/pi-daemon-contract`
  package: workspaces, worktrees and groups, the file API, terminals, the session operations pi's protocol
  lacks (`follow-up`, `compact`, `fork`, `tree`, `name`), dialogs, and devices. One event stream —
  `GET /v1/events` as a WebSocket, or SSE — per client, with mutable subscriptions by scope and
  `?since=<seq>` resume. The transcript is on it too, as a JSON projection with the same
  `revision`, so a Swift, Kotlin, Python, or `curl` client is complete with JSON alone.

**Authenticate the socket upgrade** with `Authorization: Bearer <token>`; browsers, which cannot
set headers on a WebSocket, first `POST /v1/connect-tickets` and pass the 30-second single-use
ticket as `?ticket=`.

**Answer what blocks.** `dialog.opened` arrives on the event stream with pi's `method`, `id`, and
payload; respond with `POST /v1/dialogs/:id/respond`. First answer wins; later ones get `409`.
That is one route for questions, approvals, and extension dialogs alike, because to the daemon
they are all the same thing.

**Reconnect by watermark.** Reopen the event stream with `since=<last seq>`. If the daemon answers
`snapshot.required`, re-read state and continue from the new watermark. Gaps in `seq` are normal
on a filtered stream and are not loss.

**Terminals and files.** `POST /v1/workspaces/:id/terminals { cols, rows }`, then open
`wss://<host>/v1/terminals/:id/stream`: binary frames are terminal bytes both ways, the first text
frame is a VT snapshot of the screen — render it with `xterm.js`, `ghostty-web`, `SwiftTerm`, or
libghostty, and never with a format of ours. For files: `tree`, `file` (with `ETag`, `Range`),
`diff`; `PUT` with `If-Match`, `DELETE`, `mkdir`, `move`; watch `workspace.files_changed` to know
an open file went stale, and ignore entries whose `origin` and `deviceId` are your own.

**Two typical flows.**

- *Phone:* pair · list sessions · attach over pi-protocol · read the transcript · answer a
  `dialog.opened` with a button · lock the phone · come back an hour later and resume from
  `since`.
- *ADE (`pi-ade`):* pair · register a repository · put it in a group · create a worktree · start a session in it ·
  browse the tree, open and edit files with `If-Match` · open a terminal in the worktree · watch
  the diff of what the agent changed · all from another machine over the tailnet.
