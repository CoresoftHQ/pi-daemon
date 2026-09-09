# Design notes by module

The reasoning that used to sit in file headers, collected in one place so the code can carry
one-line comments. Each note says what a module does that is not obvious from the
[specification](spec.md) and why. Sections are named after the source files.

## `os/` — the only place that knows the platform

**`paths.ts`.** Directories per platform: Windows `%LOCALAPPDATA%\pi-daemon`; macOS
`~/Library/Application Support/pi-daemon` with logs under `~/Library/Logs/pi-daemon`; Linux
`$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, and `$XDG_STATE_HOME` under `pi-daemon`, logs under state.
`PI_DAEMON_HOME` overrides all four with one directory, for tests and for operators who want a
second daemon.

**`canon.ts`.** `resolveInside(root, requested)` is the boundary check for every client-supplied
path: it refuses absolute paths, drive-relative paths (`C:foo`), UNC paths, `..`, and null bytes
syntactically, then joins to the root, takes the realpath, and refuses anything that lands
outside, which catches symlinks pointing out. It works for paths that do not exist yet, so it
serves creates as well as reads. `validateSegment` checks one directory or file name for
portability on *every* platform by default: a worktree named `aux` works on Linux and breaks the
Windows collaborator who checks it out, which is the kind of "works on my machine" the daemon
exists to prevent.

**`spawn.ts`.** `resolvePiLauncher`: the global `pi` on Windows is an npm `.cmd` shim, which Node
refuses to spawn without a shell (a deliberate security default), so the daemon locates the CLI
entry the shim points at and runs it under its own `node`. `PI_DAEMON_PI=<path>` overrides: a
JavaScript entry runs under node, anything else runs directly. `killTree` differs genuinely per
platform: Windows has no process groups, so `taskkill /T /F` walks the tree; POSIX signals the
process group the child was spawned into (`ownGroup: true`) and falls back to the pid alone.
`hangupSignal` is `SIGHUP` on POSIX and nothing on Windows, where node-pty closes the
pseudoconsole instead, which ends the console session for everything attached.

**`fsx.ts`.** `writeFileAtomicSync` writes a temp file in the same directory, fsyncs, and
renames over the target, so a reader sees the old file or the new one and never a torn one; an
existing file's mode is preserved so an executable stays executable. `watchDirectory` debounces
and coalesces, and falls back to polling when the native watcher cannot be created (inotify
exhaustion is the usual reason); its contract to callers is the spec's: events may be coalesced
or late, never wrong. It takes `realpath.native` before watching because libuv aborts on Windows
8.3 short paths.

**`ipc.ts`.** The local endpoint is a Unix socket under the state directory (falling back to the
temp directory when the path would exceed `sun_path`) or a Windows named pipe. Pipe names carry
the user and a hash of the state directory, because pipes have no directory and two daemons with
different homes must not share one. Sockets are `chmod 0600`; filesystem permissions are the
authentication on both local endpoints.

**`service/windows.ts`.** `schtasks.exe /SC ONLOGON` is denied for a standard user even with
`/RU` and `/IT`, but the ScheduledTasks PowerShell module registers a per-user AtLogOn trigger
with a Limited principal without elevation (verified in M1). Scripts go through
`-EncodedCommand` so no argument ever meets a shell's quoting rules. A boot-time Windows Service
needs admin and is not provided.

## `runners/` — the only place that knows pi

**`runner.ts`.** A Runner is one supervised `pi --mode rpc` process: it owns the child, the JSONL
framing, command correlation, and the lifecycle (graceful stop, then tree-kill; crash detection
with a stderr tail) and knows nothing about snapshots, clients, or policy. Every live runner is
kept in a module-level set with a `process.once("exit")` hook that tree-kills them, so that when
the daemon exits, cleanly, by signal, or by a test runner's force-exit, no pi process is
orphaned; `killTree` is synchronous on both platforms, which is what an exit hook needs.

**`jsonl.ts`.** Split on `\n` only, tolerate a trailing `\r`, never use `readline`, which also
splits on `U+2028`/`U+2029`, both legal inside JSON strings. A streaming UTF-8 decoder keeps a
multi-byte character split across chunks intact. Fuzzed in M9.

## `sessions/` — canonical state, one producer, two encoders

**`state.ts`.** The shapes are ours and deliberately a superset of pi-protocol's
`SessionSnapshot`, which `serve` maps onto without `sessions` importing anything from pi (the
boundary rule). Assistant and tool items are discriminated unions exactly as pi's schemas are
(a streaming assistant item has no stop reason, a running tool item has `isError: false`) so
that the encoder's structural pin against pi's types is a real check rather than a cast.

**`projector.ts`.** Rules learned in M0 against pi's own reducers: snapshots are authoritative
and progress is a hint the daemon never reduces itself; a user item has no lifecycle, it is
announced with `item_started` and becomes authoritative through the next snapshot, and
`item_finished` admits only assistant and tool items; finished items go into the transcript
while in-flight ones live only in progress until then. History loaded from `get_entries` keeps
pi's durable entry ids. Items created live are minted `live:<n>`, unique within the session and
stable for the runner's lifetime; a rehydrate replaces them with durable ids through a fresh
authoritative snapshot.

**`host.ts`.** The daemon-wide session set: the event log, leases, dialogs, eviction by idle
time and by LRU beyond the runner cap, and the catalog of sessions that are not live, read from
the header line of each session file so listing 500 sessions never parses a transcript.

## `serve/` — two wire encodings, no state

**`pi-protocol/server.ts`.** The server half of pi-protocol, transport-neutral: every connection
is a `ByteDuplex`, so the same core serves a WebSocket, the local socket, and an in-memory pair
in tests. Consequences of adopting pi's schemas, all deliberate: nothing is added to the message
set; `cwd` is validated against the workspace resolver; commands the operator declines answer
`not_implemented`; frame limits are configuration. The wire `attach` carries no mode, so every
attachment over this surface is a shared lease; exclusivity is a client-local notion pi-client
enforces itself, and `session_locked` here would only ever report an exclusive holder taken
through another surface.

**`v1/events.ts`.** One global monotonic `seq` and a replay ring bounded by count and bytes. A
`since` older than the ring answers `snapshot.required` instead of a partial replay, because a
partial replay is the kind of loss that looks fine in testing.

**`v1/terminal-stream.ts`.** The sink is attached *before* the snapshot is serialised and bytes
that arrive meanwhile are queued behind it, so nothing between the snapshot point and the first
live byte is lost or reordered. A client whose outbound buffer exceeds the cap is closed with
`1008 slow consumer`; the PTY read loop never waits for anyone.

## `workspaces/`

**`registry.ts`.** Registering a directory that is inside a repository yields a project (the
main worktree) and one workspace per existing linked worktree; a directory that is not a
repository is a standalone workspace. New worktrees go under a daemon-owned directory rather
than inside the repository, so nothing needs to be git-ignored. Group membership lives on the
item; deleting a group edits memberships and nothing else.

**`files.ts`.** Reads resolve through `realpath` (`resolveOrRefuse`) so a symlink to a file
inside the workspace is served and one pointing outside is refused. Deletes and renames use the
*lexical* path (`resolveLinkOrRefuse`): the realpath of a link is its target, and following it
would delete the target instead of the link, which M6's CI caught. Only "the link points
outside" is allowed through that second resolver, because removing such a link is exactly what a
client wants and touches nothing outside. Control and line-separator characters are refused up
front. The root and `.git` are never deletable.

**`watch.ts`.** One recursive watcher per workspace. When the platform fell back to polling,
directories a client has listed recently are watched directly as well, which is the Linux
inotify-limit strategy from the spec. `.git`-internal churn invalidates the status cache but is
not published as a file change.

## `terminals/` — the only place that knows node-pty

**`pty.ts`.** A lazy loader tries `@lydell/node-pty`, then `@homebridge/node-pty-prebuilt-multiarch`,
then upstream `node-pty`, remembers the outcome, and reports the backend (ConPTY on Windows
1809+, winpty before that, forkpty elsewhere). A failed load is a fact about the machine that
`capabilities` reports, not a retry.

**`screen.ts`.** The screen model is an interface with an `@xterm/headless` implementation.
`serialize` writes an empty chunk and resolves in its callback, because xterm parses
asynchronously and a snapshot taken earlier could miss the last chunk. libghostty-vt is a
one-file swap once it has Windows prebuilds.

**`terminal.ts`.** Output goes to the screen and to every attached sink; input from any client
goes to the PTY in arrival order; resize is coalesced at 50 ms with the last one winning, so a
rotating phone does not make ConPTY repaint forty times. `close` sends the hangup, waits a
bounded grace, then tree-kills *whether or not the shell itself has exited*, because the
orphaned child is the case that matters. `releasePty` runs both on close and when the process
exits on its own: otherwise the ConPTY and its conhost stay alive until the record is deleted,
and node-pty keeps one pipe socket per ConPTY open after exit (one handle leaked per closed
terminal, measured in M9); its public API has no close, so the sockets are reached directly.
On Windows the pid is only known once ConPTY has connected, tens of milliseconds after spawn,
so `create` waits for it.

## `access/`

**`tailscale.ts`.** Tailnet awareness is additive, never authoritative. The daemon reads
`tailscale status --json`; the CLI is on `PATH` wherever Tailscale is installed, which spares us
the LocalAPI socket's per-platform paths. It learns its own address and MagicDNS name and can
attach a peer's login to a connection for display or an optional allowlist. A token is required
regardless.

**`tokens.ts`, `devices.ts`.** `pid_<deviceId>_<secret>`; the daemon stores `sha256(secret)` and
compares in constant time; `deviceId` makes verification one hash rather than a scan. The secret
is base64url and may contain `_`, so parsers split on the first two separators only.

**`tls.ts`.** Self-signed material is generated with a pure-JavaScript library and renewed
before expiry; `tailscale cert` material is fetched for the MagicDNS name. The SPKI fingerprint
is what the pairing QR carries.

## `cli/`

**`control.ts`.** `pi-daemon stop|status|pair|devices` talk to a running daemon over a second
local socket or pipe, because Windows has no signal to send. Newline-delimited JSON, one request
per line; the daemon may send `event` and `ask` lines before the `reply` for commands that wait
on something, which is how `pair --confirm` puts a y/N question in the terminal that asked.

**`daemon.ts`.** The composition root and the one place that knows every module. Startup order
matters: directories, logger, bind and TLS resolution, the single-instance lock (taken after the
port is chosen and probed through the control endpoint rather than by trusting a pid), then
everything else. Shutdown is the reverse: stop accepting, emit `daemon.shutdown`, close every
client, drain runners and terminals, release the lock.

**`doctor.ts`.** Every probe is injectable so the verdicts are testable without the conditions.
Probes create the daemon's directories first, because before the first start they do not exist
and a missing directory is not an unwritable one.

## `scripts/check-boundaries.mjs`

Three rules that rot silently if not enforced: nothing outside `src/runners` may know pi exists;
nothing outside `src/os` may branch on the operating system; nothing outside `src/terminals`
may import node-pty. Plus the layering: `cli` on top, `serve` over `sessions`, `workspaces`,
`terminals`, and `access`, `sessions` over `runners` and `workspaces`, `os` at the bottom.
Tests are exempt from the layering rules.
