# Writing a client

Everything a client needs, in the order a client needs it: pair, learn the daemon's
capabilities, drive sessions over pi's protocol or over JSON, follow the event stream, answer
dialogs, and use workspaces, files, and terminals. The [overview](overview.md) says why the
daemon is shaped this way; the [specification](spec.md) has every rule; this page has the calls.

Types for every JSON shape below are in `@coresoft-hq/pi-daemon-contract` (TypeBox schemas,
TypeScript types, and an OpenAPI 3.1 document you can feed to any generator; see §11). The
daemon validates requests against the same schemas, so a shape that compiles is a shape the
daemon accepts.

## 0. The short version, in TypeScript

`@coresoft-hq/pi-daemon-client` wraps everything below: typed methods for every route, an
event stream that resumes and reconnects by itself, connect tickets for sockets, and a terminal
attach helper. It runs in Node 22+ and browsers with no runtime dependencies.

```ts
import { PiDaemonClient } from "@coresoft-hq/pi-daemon-client";

const paired = await PiDaemonClient.pair(baseUrl, { code, deviceName: "phone", platform: "ios" });
const daemon = new PiDaemonClient({ baseUrl, token: paired.token });
const session = await daemon.sessions.create();
const events = daemon.events({ scopes: [`session:${session.id}`] });
events.on("dialog.opened", (e) => daemon.dialogs.respond(e.payload.dialogId, { confirmed: true }));
await daemon.sessions.prompt(session.id, "hello", { idempotencyKey: crypto.randomUUID() });
```

Its [README](../packages/client/README.md) has the rest. Everything else on this page is what
that client does, for anyone writing one in another language.

## 1. Two surfaces, one state

| | pi-protocol | `/v1` JSON |
| --- | --- | --- |
| What | pi's own remote-session protocol: framed CBOR over a WebSocket, or the local socket | Plain HTTP and JSON |
| Covers | Sessions: list, create, attach, prompt, steer, abort, model, thinking; authoritative snapshots and streaming progress | Sessions too (every RPC command with a name), plus workspaces, groups, worktrees, files, terminals, devices, pairing, and the event stream |
| Client | `@earendil-works/pi-client` unchanged, or any language from pi's published schemas | Any HTTP client |
| Auth | Bearer token at the WebSocket upgrade | Bearer token on every request |

Both carry the same session state with the same `revision`, so a client can use either or both.
A phone written in Swift and a script written in `curl` are complete with JSON alone; a
TypeScript client can add pi-protocol for the richest session stream.

## 2. Pairing

The operator runs `pi-daemon pair` on the machine. It prints a QR code and the same payload as
text:

```json
{ "v": 1, "host": "box.tail3f0fb7.ts.net", "port": 8790, "fp": "3b1c…", "code": "K7M4-QP2X" }
```

- `host` and `port` are where to connect. `fp` is the SHA-256 of the daemon's TLS public key
  (SPKI), present when TLS is on; pin it before you trust the connection, because a QR
  photographed off a screen must not be redeemable against someone else's endpoint. With a
  Tailscale certificate the chain is publicly trusted and `fp` is a second check; with a
  self-signed certificate `fp` is the only check.
- `code` is single use, valid for 120 seconds, five attempts, one active at a time. It buys one
  token, once.

Redeem it, unauthenticated:

```http
POST /v1/pair/redeem
{ "code": "K7M4-QP2X", "deviceName": "Ove's phone", "platform": "ios" }

200 { "daemonId": "dm_…", "daemonName": "box", "deviceId": "…", "token": "pid_…_…",
      "role": "owner", "capabilities": { … } }
```

Store the token under `daemonId`, as carefully as an SSH key: it is shell access as the user the
daemon runs as ([operating.md §1](operating.md)). The first device paired is the `owner`; later
ones are `member`. Owner-only routes are device management and workspace registration.

For a service (n8n, a script), there is no QR: the operator runs `pi-daemon devices create
--name n8n` and hands you the token.

## 3. Authentication

Every request except `GET /v1/health` and `POST /v1/pair/redeem`:

```http
Authorization: Bearer pid_<deviceId>_<secret>
```

WebSocket upgrades take the same header. A browser cannot set headers on a WebSocket, so it
first calls `POST /v1/connect-tickets` (authenticated) and opens the socket with `?ticket=<t>`:
the ticket is single use, lives 30 seconds, and is accepted on upgrades only.

| Status | Meaning |
| --- | --- |
| `401` | No token, a revoked token, or an expired ticket. Re-pair. |
| `403` | Authenticated but not allowed: an owner route, a tailnet allowlist, `files.write` off, `terminals` off |
| `429` | Rate limited: five redemption attempts per minute per address, ten failed tokens per fifteen minutes |

Every error is one shape, and any extra field names a rule, never a path:

```json
{ "error": { "code": "outside_workspace", "message": "path is not inside the workspace", "rule": "traversal" } }
```

## 4. Capabilities: degrade against a fact

```http
GET /v1/capabilities
```

```json
{
  "daemon":     { "id": "dm_…", "name": "box", "version": "1.0.0", "platform": "linux", "startedAt": 1757… },
  "api":        { "version": 1 },
  "piProtocol": { "version": 1, "maxFrameLength": 8388608 },
  "pi":         { "version": "0.85.1", "supported": ">=0.84.0 <0.86.0", "path": "/usr/lib/node_modules/…/cli.js" },
  "features":   ["dialogs", "fork", "sse", "groups", "files", "diff", "files.write", "worktrees", "terminals"],
  "absent":     ["commandRuns", "push", "containers", "turnResume", "terminalPersistence"],
  "limits":     { "maxRunners": 8, "maxTerminals": 16, "scrollbackLines": 10000, "maxFileBytes": 4194304, "idleTimeoutMs": 1800000, "replayRing": 2000 }
}
```

Read it once after pairing (it is also inside the redeem response) and again on reconnect.
`terminals`, `worktrees`, and `files.write` move between `features` and `absent` depending on
the machine and the operator's configuration; hide the button rather than showing a failed call.
`pi.version` is detected, not pinned; `pi.supported` is the range this daemon was tested with.

## 5. Sessions over JSON

| Call | Notes |
| --- | --- |
| `GET /v1/sessions` · `?workspace=<id>` | Every session pi knows about, live or not: `{ id, workspaceId?, name?, createdAt, updatedAt, live, phase?, runId?, interrupted?, attachedCount }` |
| `POST /v1/sessions { workspaceId, model?, thinkingLevel?, name? }` | `201 { session }`: the full snapshot. Spawns the runner |
| `GET /v1/sessions/:id` | The authoritative snapshot: transcript, phase, model, `revision`. Attaching to an evicted session respawns it |
| `POST /v1/sessions/:id/prompt { text, during? }` | `202 { runId?, queued, revision }`. `runId` is the turn you started; `queued` means it went behind a running turn as a steer or follow-up (`during: "steer" \| "followUp"`), otherwise a running turn answers `409 busy`. Send `Idempotency-Key: <uuid>` and a retry returns the same answer with `Idempotent-Replayed: true` |
| `POST …/steer { text }` · `…/follow-up { text }` · `…/abort` | Queue into a running turn, or stop it |
| `POST …/queue-mode { queue }` · `…/clear-queue` · `…/compact { … }` | pi's queue and compaction controls |
| `POST …/model { … }` · `…/thinking { level }` · `…/name { name }` | Settings |
| `GET …/entries?since=` · `GET …/tree` · `GET …/stats` · `POST …/fork { … }` | pi's session entries verbatim (ids are durable cursors), the branch tree, statistics, and forking |

A snapshot's `transcript` is an array of discriminated items: `user`, `assistant`
(`streaming` / `complete` / `error` / `aborted`), and `tool` (`running` / `complete` / `error`).
`phase` is `idle`, `turn`, `compaction`, `branch_summary`, or `retry`. `interrupted`, when
present, says a turn died with the daemon or a runner crash and carries its `runId`; the client
decides whether to re-prompt. `workspaceId` may be omitted on create; the daemon's default is
the first registered workspace.

**Two legitimate ways to follow a transcript over JSON.** The lazy way: subscribe to
`session:<id>` and re-`GET /v1/sessions/:id` whenever `session.changed` arrives with a higher
`revision`. It is one request per settled change, always correct, and enough for most clients.
The streaming way: apply `transcript.item_started`, `item_updated`, `assistant_delta`, and
`item_finished` as they arrive to show text as it streams, and still treat the next snapshot as
authoritative. Both carry the same `revision`, so you can start lazy and add streaming later.

## 6. Sessions over pi-protocol

`wss://<host>:<port>/pi/v1/socket`, subprotocol `pi.v1`, bearer token at the upgrade. On the
machine itself, the local endpoint needs no token: a Unix socket under the daemon's state
directory, or a named pipe on Windows (`pi-daemon status --json` prints the path).

The daemon is the server half of `@earendil-works/pi-protocol`; pi's `PiClient` drives it
unchanged. The only thing you write is a transport, about fifteen lines:

```ts
import WebSocket from "ws"; // or the browser's WebSocket, with ?ticket= instead of a header
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";

const transport: ByteTransportFactory = async (handlers) => {
  const ws = new WebSocket("wss://box.tail3f0fb7.ts.net:8790/pi/v1/socket", ["pi.v1"], {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.once("error", reject);
  });
  ws.on("message", (data) => handlers.onData(new Uint8Array(data as Buffer)));
  ws.on("close", () => handlers.onClose());
  return { send: async (chunk) => ws.send(chunk, { binary: true }), close: () => ws.close() };
};

const client = new PiClient({ transportFactory: transport });
await client.connect();
const sessions = await client.listSessions();            // { id, createdAt, updatedAt?, sessionName?, cwd? }[]
const lease = await client.attachSession(sessions[0].id); // or createSession({ cwd })
lease.subscribe((snapshot) => render(snapshot));          // authoritative, with revision
await lease.prompt("hello");
```

What to expect from this daemon, beyond the protocol's own rules:

- **`cwd`** on `create` must be inside a registered workspace; the daemon canonicalises it and
  refuses anything else with `invalid_request`. Omit it for the default workspace.
- **Leases are all shared.** The protocol has no exclusive attach, so every attached client sees
  every snapshot and may prompt. `session_locked` is never returned.
- **`not_implemented`** is a legitimate answer for a command an operator has switched off.
- **Frames** above `piProtocol.maxFrameLength` are refused before decoding; the default is 8 MiB.
- **`set_model`, `set_thinking`, `steer`, `abort`** work as in pi; `follow_up`, `compact`,
  `fork`, `tree`, and naming are JSON-only because the protocol does not model them.

## 7. The event stream

One stream per client for everything that is not a session snapshot:

```
GET /v1/events?since=<seq>&scopes=daemon,workspace:<id>,session:<id>,terminal:<id>   (WebSocket, JSON text frames)
GET /v1/events/sse?since=<seq>&scopes=…                                              (Server-Sent Events; Last-Event-ID also works)
```

Every frame is one envelope:

```json
{ "seq": 4312, "scope": "session:s_…", "type": "session.phase", "at": 1757…, "payload": { "sessionId": "s_…", "phase": "turn", "runId": "r_…" } }
```

- `seq` is global and monotonic across the whole daemon. Gaps on a filtered stream are normal
  and are not loss.
- Reconnect with `since=<the last seq you saw>`. If that is older than the replay ring (2 000
  events by default), the first frame is `snapshot.required { watermark, oldest }`: re-read the
  state you care about with plain GETs, then continue from `watermark`.
- On the WebSocket, text frames from the client change subscriptions without reconnecting:
  `{ "type": "subscribe", "scopes": ["session:s_…"] }`, `unsubscribe`, `ping`.
- Scopes: `daemon` (registry, devices, shutdown), `workspace:<id>` (registry changes,
  `files_changed`, terminals opened and closed), `session:<id>`, `terminal:<id>` (titles).

Types and what they carry, all typed in the contract's `EventPayloads`:

| Type | Scope | Payload |
| --- | --- | --- |
| `session.created` · `session.evicted` · `runner.failed` | `daemon` | ids, reasons, a stderr tail for a crash |
| `session.phase` · `session.changed` · `session.interrupted` | `session:` | `runId`, `revision`, phase, model, transcript length, attached count |
| `transcript.item_started` · `item_updated` · `item_finished` · `assistant_delta` | `session:` | the JSON projection of pi's progress, same `revision` as pi-protocol |
| `dialog.opened` · `dialog.closed` | `session:` | see §8 |
| `notice` | `session:` | pi's fire-and-forget `notify`, `setStatus`, `setWidget` |
| `workspace.changed` · `project.changed` · `group.changed` | `daemon` | registration, rename, regroup, removal |
| `workspace.files_changed` | `workspace:` | `{ paths, truncated, origin: "api" \| "external", deviceId? }`, debounced; coalesced or late, never wrong |
| `terminal.created` · `terminal.exited` · `terminal.title` | `workspace:` / `terminal:` | the terminal record, the exit, the title |
| `device.paired` · `device.revoked` · `daemon.shutdown` · `snapshot.required` | `daemon` | |

## 8. Dialogs: answer what blocks

When pi blocks on a human (a permission gate, an extension's `confirm`, `select`, `input`, or
`editor`), the daemon relays it verbatim:

```json
{ "type": "dialog.opened", "scope": "session:s_…",
  "payload": { "dialogId": "s_…:req-12", "sessionId": "s_…",
               "request": { "id": "req-12", "method": "confirm", "title": "Run `rm -rf build`?", "…": "pi's request, unchanged" } } }
```

Render it from `request.method` and pi's fields; there is no daemon-side classification of
"approval" versus "question", because pi does not make one. The four blocking methods and the
fields pi sends with them (`title` and `message` are the human text; everything else is
optional, and unknown extra fields must be tolerated):

| `method` | Fields | Answer with |
| --- | --- | --- |
| `confirm` | `title`, `message` | `{ "confirmed": true \| false }` |
| `select` | `title`, `message`, `options: string[]` | `{ "value": "<one of options>" }` |
| `input` | `title`, `message`, `placeholder?` | `{ "value": "<typed text>" }` |
| `editor` | `title`, `message` (initial text) | `{ "value": "<edited text>" }` |

`{ "cancelled": true }` is valid for all four. A `timeout` in milliseconds, when present, is how
long pi will wait before giving up on its own. Answer with one of:

```http
POST /v1/dialogs/:dialogId/respond
{ "confirmed": true }        or        { "value": "the chosen option or typed text" }        or        { "cancelled": true }
```

First answer wins: `200 { dialogId, resolution }`. A later answer gets
`409 already_resolved { resolution, answeredBy }`, and every attached client sees
`dialog.closed` with who answered. There is no policy and no rules file here; the daemon
carries the question and the answer.

## 9. Workspaces, groups, worktrees

| Call | Role | Notes |
| --- | --- | --- |
| `GET /v1/projects` · `GET /v1/workspaces` · `?group=<id>` · `?group=none` · `?project=<id>` | member | Ids, names, `displayPath` for humans, `kind` (`main`, `worktree`, `standalone`), `branch`, `groupIds`. Never a canonical path |
| `POST /v1/workspaces { path, name?, groupIds? }` | owner | Registers a directory on the daemon's host. A git repository yields a project plus one workspace per existing worktree |
| `GET /v1/projects/:id` · `PATCH /v1/projects/:id { name?, groupIds?, defaultBaseRef? }` · `PATCH /v1/workspaces/:id { name?, groupIds? }` | member | |
| `POST /v1/projects/:id/worktrees { name, branch?, baseRef?, groupIds? }` | member | `git worktree add`; the name is validated as a directory name on every OS *before* git runs (`aux`, `fix.` fail with `invalid_name`). `201 { workspace }`, immediately usable |
| `DELETE /v1/projects/:id/worktrees/:workspaceId` · `?force=1` | member | `409 busy` while a session or terminal is live in it |
| `POST /v1/projects/:id/refresh` | member | Re-scan after `git worktree add` in a terminal |
| `DELETE /v1/workspaces/:id` | owner | Deregisters; deletes nothing on disk |
| `GET /v1/groups` · `POST { name, color?, order? }` · `GET /v1/groups/:id` · `PATCH` · `DELETE` | member | Flat, many-to-many. `GET /v1/groups/:id` expands members. Delete removes the grouping, never a member |
| `GET /v1/workspaces/:id/status` | member | `{ branch, upstream, ahead, behind, detached, dirty, changes: [{ path, code }], truncated, untrackedCount, at }`; cached, invalidated by the watcher |
| `GET /v1/workspaces/:id/sessions` | member | Sessions whose cwd is inside it |

## 10. Files

Every path is relative to the workspace root; there is no route that takes an absolute path.
`..`, absolute, drive-relative, UNC, control characters, and symlinks whose target leaves the
tree all answer `403 outside_workspace` with a `rule` and never the path.

| Call | Notes |
| --- | --- |
| `GET /v1/workspaces/:id/tree?path=&depth=1&all=0&cursor=&limit=500` | Entries `{ name, kind, size, mtime, ignored, target?, children? }`. `.git` and ignored entries are hidden unless `all=1`. Paged: follow `nextCursor` |
| `GET /v1/workspaces/:id/file?path=` | Bytes with `ETag`, `Content-Type` (sniffed; `application/octet-stream` for binary), `X-File-Mode`, `X-File-Size`. Honours `Range` (`206`) and `If-None-Match` (`304`). Above `limits.maxFileBytes`: `413 { size }`, ask for a range. `HEAD` for metadata |
| `GET /v1/workspaces/:id/diff?path=&base=HEAD` | Unified diff of the working tree, one path or all |
| `PUT /v1/workspaces/:id/file?path=&parents=0&force=0` | Body is the bytes, verbatim. Replacing an existing file **requires `If-Match: <etag>`**: `428` without it, `412 { etag }` when stale. `If-None-Match: *` creates only. Atomic; mode preserved |
| `DELETE /v1/workspaces/:id/file?path=&recursive=0` | `If-Match` honoured. Directories need `recursive=1` (`409` otherwise). Links are removed as links. The root and `.git`: `403 protected` |
| `POST /v1/workspaces/:id/mkdir { path }` · `POST …/move { from, to, overwrite? }` | Plain rename; git sees delete plus add until staged |

Every write the daemon performs emits `workspace.files_changed` with `origin: "api"` and your
`deviceId`, so you can ignore your own echo; edits by the agent or anyone else arrive as
`origin: "external"`. When the operator sets `files.write: false`, the four write routes answer
`403 write_disabled` and `files.write` is absent from capabilities.

## 11. Terminals

```http
POST /v1/workspaces/:id/terminals { "cols": 120, "rows": 40, "argv": ["htop"]? }
201 { "terminal": { "id": "tm_…", "workspaceId", "pid", "cols", "rows", "title", "command", "status": "running", "createdAt", "attachedCount" } }
```

Without `argv` it is the operator's shell. `GET /v1/terminals` (`?workspace=`), `GET
/v1/terminals/:id`, `POST /v1/terminals/:id/resize { cols, rows }`, and `DELETE
/v1/terminals/:id?grace=1500` (close the PTY, wait, tree-kill). Refusals: `403
terminals_disabled`, `501 terminals_unavailable` (no PTY addon on that machine; the message
names it), `503 terminal_cap`.

Then attach: `wss://<host>:<port>/v1/terminals/:id/stream`, bearer token or ticket.

- **Binary frames** are terminal bytes, both directions. Send keystrokes as bytes.
- **The first text frame is the snapshot:** `{ "type": "snapshot", "cols", "rows", "title",
  "data": "<VT sequences>" }`. Write `data` into your emulator and you are looking at the live
  screen and scrollback, whether you attached a second ago or an hour later. Bytes that arrive
  while the snapshot is being produced are queued behind it, so order is preserved.
- **Other text frames from the server:** `{ "type": "resize", cols, rows }` when anyone resizes,
  `{ "type": "title", title }`, `{ "type": "exit", "exit": { code, signal, reason, at } }` followed by
  a close with code 1000, `{ "type": "pong" }`.
- **Text frames from you:** `{ "type": "resize", "cols", "rows" }` (last resize wins, coalesced),
  `{ "type": "ping" }`. Anything else closes the socket with 1007.
- **If you cannot keep up**, the daemon closes with `1008 slow consumer` rather than stalling the
  PTY. Reconnect and you get a fresh snapshot.

Render with `xterm.js`, `ghostty-web`, SwiftTerm, or libghostty. The snapshot is ordinary VT
output, not a format of ours, which is the point. Terminals survive every client leaving and
do not survive a daemon restart; `terminal.exited` says which.

## 12. Using the contract package

```sh
npm i @coresoft-hq/pi-daemon-contract
```

```ts
import { Value } from "typebox/value";
import { CreateSessionRequest, EventEnvelope, EventPayloads, SessionSnapshot } from "@coresoft-hq/pi-daemon-contract";
import type { Capabilities, TerminalServerControl } from "@coresoft-hq/pi-daemon-contract";

const frame = JSON.parse(text);
if (Value.Check(EventEnvelope, frame) && frame.type in EventPayloads) { /* typed payload */ }
```

Every request and response is a TypeBox schema with a `Static` type of the same name; the
event payloads are keyed by type in `EventPayloads`; the terminal control frames are
`TerminalClientControl` and `TerminalServerControl`. For other languages, generate from OpenAPI:

```sh
node -e "import('@coresoft-hq/pi-daemon-contract').then(m => console.log(JSON.stringify(m.openApiDocument({ version: '1.0.0' }), null, 2)))" > pi-daemon.openapi.json
```

Every GitHub Release also carries `pi-daemon.openapi.json`, the same document, so nothing needs
Node to generate a client.

`CONTRACT_VERSION` is `1`. `/v1` is additive within the version: new routes, new optional fields,
new event types, new capability strings. Anything breaking is `/v2`, and `capabilities.api.version`
is where a client checks.

## 13. A complete session with `curl`

On the daemon's machine, get a code; from anywhere on the tailnet, use it.

```sh
pi-daemon pair --json                 # prints { v, host, port, fp, code, expiresAt }

B=https://box.tail3f0fb7.ts.net:8790
T=$(curl -s $B/v1/pair/redeem -H 'content-type: application/json' \
     -d '{"code":"K7M4-QP2X","deviceName":"curl","platform":"shell"}' | jq -r .token)
H="authorization: Bearer $T"

curl -s $B/v1/capabilities -H "$H" | jq .features
W=$(curl -s $B/v1/workspaces -H "$H" | jq -r '.workspaces[0].id')
S=$(curl -s $B/v1/sessions -H "$H" -H 'content-type: application/json' -d "{\"workspaceId\":\"$W\"}" | jq -r .session.id)

curl -sN "$B/v1/events/sse?scopes=session:$S" -H "$H" &          # watch the turn stream
curl -s $B/v1/sessions/$S/prompt -H "$H" -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"text":"summarise this repository"}'                     # { "runId": "...", "queued": false, "revision": 3 }
curl -s $B/v1/sessions/$S -H "$H" | jq '.session.transcript[-1]'   # the answer, once phase is idle again
```

A `dialog.opened` frame on the SSE stream is answered with
`curl -s $B/v1/dialogs/<dialogId>/respond -H "$H" -d '{"confirmed":true}'`.

## 14. What a client should never assume

- That it is the only client. Another device may prompt, answer a dialog, resize a terminal, or
  edit a file at any moment; the events say so.
- That the daemon noticed it was gone. Reconnect with `since`, resend a prompt with the same
  `Idempotency-Key`, re-attach a terminal and take the snapshot.
- That a feature exists because the docs list it. `capabilities` is the truth for this daemon.
- That a path means anything outside the workspace it was read from, or that the daemon will
  ever return an absolute one.
- That the daemon will decide anything about approvals, trust, tools, or scheduling. Those are
  pi's, the operator's, and yours.
