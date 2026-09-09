# pi-daemon

A cross-platform daemon that runs [Pi Coding Agent](https://pi.dev) sessions on your machine and
serves them to any client over an authenticated network API.

Sessions live in the daemon, not in a terminal. They keep running while every client is gone,
stream what they do as events, and turn the moments where the agent blocks on a human into
messages any client can answer. A phone on the couch, a laptop across the house, and a browser
tab can all be attached to the same session at once.

```mermaid
flowchart LR
    subgraph clients ["Clients"]
        phone["Phone / tablet"]
        web["Browser"]
        laptop["Laptop / curl / n8n"]
    end

    subgraph daemon ["pi-daemon"]
        direction LR
        access["access<br/>pairing QR · device tokens · TLS · tailnet identity"]

        subgraph serve ["serve"]
            proto["pi-protocol<br/>CBOR over WebSocket<br/>and the local endpoint"]
            v1["/v1 JSON<br/>sessions · workspaces · files · terminals"]
            events["event stream<br/>WebSocket or SSE, global seq, resume"]
            tstream["terminal stream<br/>binary frames · VT snapshot on attach"]
        end

        subgraph sessions ["sessions"]
            state["transcript state · leases · dialog relay"]
            runners["runners<br/>one supervised child per session"]
        end

        subgraph workspaces ["workspaces"]
            registry["projects · worktrees · groups"]
            files["file API with realpath boundary"]
            watcher["git status + watcher"]
        end

        subgraph terminals ["terminals"]
            pty["PTY: the user's shell"]
            screen["headless screen model<br/>bounded scrollback"]
        end

        control["control endpoint<br/>stop · status · pair · devices"]
    end

    pi["pi --mode rpc × N<br/>(JSONL over stdio)"]
    jsonl[("~/.pi/agent/sessions/*.jsonl<br/>the source of truth")]
    repo[("workspace directory<br/>git worktrees")]
    cli["pi-daemon CLI<br/>serve · setup · pair · doctor"]

    phone & web & laptop -->|"bearer token"| access
    access --> proto & v1 & events & tstream
    proto --> state
    v1 --> state
    v1 --> registry & files
    v1 --> pty
    state --> runners -->|"spawn, watch, kill"| pi
    pi --> jsonl
    runners -.->|"events"| state
    state -.->|"session.* · dialog.*"| events
    registry -.->|"workspace.* · files_changed"| events
    watcher --> repo
    files --> repo
    pty --> screen
    screen -.->|"snapshot, then live bytes"| tstream
    pty -.->|"terminal.*"| events
    events -.-> phone & web & laptop
    cli --> control
```

Solid arrows are requests; dotted arrows are what flows back. Sessions and terminals are separate
paths: a session is a `pi --mode rpc` process whose structured events become a transcript, a
terminal is a plain shell in a PTY whose bytes the daemon keeps on a screen model so a client
can leave and come back.

**Each session is a supervised `pi` process.** Not an SDK object inside the daemon — a child
process the daemon starts, watches, and can kill. One wedged session degrades one session instead
of taking down every session on the machine, eviction reclaims memory with certainty, and the
daemon imports no pi SDK at all: it needs the `pi` binary, plus one prebuilt native addon for
terminals. The session's JSONL file stays the source of truth, so a session started from a phone
resumes with `pi --session <id>` in a terminal, and vice versa.

**Client neutral by construction.** The session surface is
[`@earendil-works/pi-protocol`](https://pi.dev) — pi's own remote-session protocol, for which pi
publishes schemas and a client but no server. This daemon is the missing server, so pi's
`PiClient` and `RemoteSession` drive it unmodified. Everything that protocol does not model is a
plain JSON `/v1` API carrying the same state, so a client written in Swift, Kotlin, Python, or
`curl` needs neither CBOR nor a pi dependency. Our own clients live in separate repositories and
get no back door.

**Access.** Every request is authenticated; network position alone grants nothing. A client pairs
once by scanning a QR code carrying a short-lived single-use code and the daemon's certificate
fingerprint, then exchanges it for its own revocable device token. A tailnet is the expected way
in, but it is defence in depth — never a substitute for the token.

## Client versus daemon

The daemon owns everything that must be true no matter which client is looking, or whether any
client is looking at all. A client owns everything a person sees and touches. The line between
them is the wire contract: pi-protocol for sessions, `/v1` and its event stream for the rest,
and `GET /v1/capabilities` for what this particular daemon can do.

| Concern | The daemon implements | A client implements |
| --- | --- | --- |
| Sessions | Spawning, supervising, evicting, and killing one `pi --mode rpc` process per session; the authoritative transcript state with a `revision`; a `runId` for every turn | The transcript view: markdown, tool calls, diffs, streaming text; which session to open; when to re-prompt after an `interrupted` turn |
| Events | One global event log with a monotonic `seq`, a replay ring, scope filtering, and `snapshot.required` when a client is too far behind | Resuming from its last `seq` on reconnect, and re-reading state when told the ring has moved on |
| Dialogs | Relaying pi's `extension_ui_request` to every attached client verbatim, returning the first answer, telling the others who answered | The UI for a question, a choice, an input, or an editor; showing that someone else already answered |
| Approvals and trust | Nothing. Approvals are pi's own gates in the operator's pi configuration; the daemon carries the question and the answer and keeps no policy | Presenting the question well. Not deciding it either |
| Workspaces | The registry of projects, worktrees, and groups; `git worktree add` with names validated for every OS; status and diffs; the watcher and `files_changed` | Navigation, grouping views, the "start a task in a clean tree" flow, and choosing which daemon a workspace lives on |
| Files | Serving bytes only inside a registered workspace, `ETag`s, atomic writes with `If-Match`, the boundary checks | The editor, and what to do on `412`: the agent changed the file since you read it |
| Terminals | The PTY, the shell, the screen model, the snapshot on attach, fan-out to many clients, cutting a client that cannot keep up | The terminal emulator (`xterm.js`, `ghostty-web`, SwiftTerm, libghostty), keyboard handling, resize |
| Access | Pairing codes and the QR payload, device tokens and their hashes, revocation, roles, TLS, tailnet identity | Scanning the QR, pinning the certificate fingerprint, storing its token as carefully as an SSH key, re-pairing when revoked |
| Capabilities | Saying exactly what it has and lacks: `features`, `absent`, `limits`, the detected `pi` version | Degrading against that document instead of against failed calls |
| Lifecycle | Idle eviction, the runner cap, graceful shutdown, single instance, surviving every client leaving | Retrying a `prompt` with the same `Idempotency-Key`; reconnecting without assuming the daemon noticed it was gone |
| Scheduling and orchestration | Nothing in v1. Runs start when asked | Schedules, queues, workflows (n8n or its own), using `runId` to know which turn finished |
| Notifications | Emitting the events a push relay would consume | Everything else, until a relay exists |
| Credentials | Never handling a provider key; the runner uses pi's own sign-in on the machine | Never asking for one |

The test of the split is a client written in `curl`: if something can only be done with a
particular client, it is in the wrong place.

## Installation

One line per platform installs the `pi-daemon` command. Registering it as a service is a
separate, second step, the same command on all three: `pi-daemon setup`.

| Platform | Install the CLI |
| --- | --- |
| macOS | `brew install coresofthq/tap/pi-daemon` |
| Windows | `winget install CoresoftHQ.PiDaemon` |
| Linux | `curl -fsSL https://raw.githubusercontent.com/CoresoftHQ/pi-daemon/main/install.sh \| sh` |
| Anywhere with Node 22.19+ | `npm i -g pi-daemon` |

None of them needs a compiler, and none of them needs Node installed first: Homebrew brings
Node as a dependency, the winget package ships its own `node.exe`, and the Linux script
downloads Node into `~/.local/share/pi-daemon` if the machine has none. The script also works on
macOS, and Windows without winget has the same thing in PowerShell:
`irm https://raw.githubusercontent.com/CoresoftHQ/pi-daemon/main/install.ps1 | iex`.

The tap, the winget package, and the npm packages are published by the release workflow from
the first tagged version. Until that tag exists, the same artifacts come from a clone:
`npm install && npm run build && npm link -w packages/daemon`.

### Then: set up the service

```sh
pi-daemon doctor     # pi on PATH? signed in? port free? Tailscale? PTY?
pi-daemon setup      # register with the OS and start
pi-daemon status
```

`setup` registers a systemd user unit (plus `loginctl enable-linger`, so the daemon survives
your logout on a headless box) on Linux, a LaunchAgent with `RunAtLoad` and `KeepAlive` on
macOS, and a scheduled task at your logon on Windows, needing no admin. It starts the daemon
immediately and at every login from then on. `pi-daemon uninstall` removes the registration and
nothing else; `pi-daemon serve --foreground` runs the daemon in the current terminal instead,
which is the right way to try it out. `setup --dry-run` prints the unit, plist, or task without
touching anything.

### Prerequisites

| What | Why | How |
| --- | --- | --- |
| `pi` on `PATH`, signed in to a provider | every session is a `pi --mode rpc` child | `npm i -g @earendil-works/pi-coding-agent`, then run `pi` once and sign in |
| `git` | worktrees, status, diffs (optional: without it, `worktrees` is absent from capabilities) | `apt install git`, `brew install git`, `winget install Git.Git` |
| Tailscale (optional) | the intended way in from other devices, and a publicly trusted certificate | [tailscale.com/download](https://tailscale.com/download), with MagicDNS and HTTPS certificates enabled for your tailnet |

Supported pi versions are `>=0.84.0 <0.86.0`; `pi-daemon doctor` checks the installed one.

### Platform notes

- **Linux.** The PTY addon has prebuilds for x64 and arm64, glibc and musl, so Alpine works.
  Some distributions ask for authentication at the `enable-linger` step; if it is refused, the
  unit still starts at every login. Files live under `~/.local/share/pi-daemon`,
  `~/.config/pi-daemon`, and `~/.local/state/pi-daemon`.
- **macOS.** For `bind: tailscale` the daemon runs the `tailscale` command, which the App Store
  build keeps inside the app bundle; put it on your `PATH` once with
  `sudo ln -s /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale`.
  Files live under `~/Library/Application Support/pi-daemon`, logs under
  `~/Library/Logs/pi-daemon`.
- **Windows.** Windows 10 1809 or newer is needed for ConPTY, which terminals use. Terminals
  use PowerShell 7 (`winget install Microsoft.PowerShell`) when present, Windows PowerShell
  otherwise. The first non-loopback bind shows a firewall prompt; allow it for private networks.
  A boot-time Windows Service (running before anyone logs on) is not provided in 1.0. Files live
  under `%LOCALAPPDATA%\pi-daemon`.

### First run

```sh
pi-daemon pair                         # QR code and text for the first device; it becomes the owner
pi-daemon config set bind tailscale    # reachable from your other devices, with a real certificate
pi-daemon stop && pi-daemon start
pi-daemon logs -f
```

The daemon listens on loopback with no TLS until `bind` is `tailscale` (a publicly trusted
certificate for the MagicDNS name) or an explicit address (self-signed, fingerprint in the QR).
Read [docs/operating.md](docs/operating.md) before doing either: a device token is shell access as
the user the daemon runs as. `PI_DAEMON_HOME=<dir>` moves everything under one directory, for a
second daemon or a throwaway.

## Status

All ten milestones of the [plan](docs/plan.md) are implemented on the `develop` branch, with CI
across Linux, macOS, and Windows on Node 22 and 24, and against pi at both ends of the supported
range. `1.0.0` is prepared there ([CHANGELOG](CHANGELOG.md)) and waits on the human reviews and
the 24-hour soak before it is tagged. Read [docs/operating.md](docs/operating.md) before exposing
a daemon to a network.

- [Writing a client](docs/clients.md) — pairing, both surfaces, the event stream, dialogs,
  files, terminals, the contract package, and a complete `curl` session.
- [Overview](docs/overview.md) — one page: how the daemon works and how clients integrate.
- [Specification](docs/spec.md) — requirements, the runner architecture, both wire surfaces,
  the file API, terminals, access, safety, lifecycle, and the three operating systems.
- [Implementation plan](docs/plan.md) — ten milestones, acceptance criteria, and risks.
- [Design notes](docs/design.md) — per-module reasoning that is not in the spec: why each
  piece is built the way it is.
- [Operating](docs/operating.md) — what a device token means, threat model, tailnet and TLS,
  recovery.
