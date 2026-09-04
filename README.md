# pi-daemon

A cross-platform daemon that runs [Pi Coding Agent](https://pi.dev) sessions on your machine and
serves them to any client over an authenticated network API.

Sessions live in the daemon, not in a terminal. They keep running while every client is gone,
stream what they do as events, and turn the moments where the agent blocks on a human into
messages any client can answer. A phone on the couch, a laptop across the house, and a browser
tab can all be attached to the same session at once.

```
                       ┌──────────────── pi-daemon ────────────────┐
   phone   ─┐          │                                           │
   tablet   ├─ CBOR ──▶│  access ─▶ serve ─▶ sessions ─▶ runners   │
   browser  │          │                 │                 │       │
   laptop   ├─ JSON ──▶│           workspaces              │ spawn │
   curl    ─┘          │                                   ▼       │
                       │                          pi --mode rpc × N│
                       └───────────────────────────────┬───────────┘
                                                       ▼
                                        ~/.pi/agent/sessions/*.jsonl
```

**Each session is a supervised `pi` process.** Not an SDK object inside the daemon — a child
process the daemon starts, watches, and can kill. One wedged session degrades one session instead
of taking down every session on the machine, eviction reclaims memory with certainty, and the
daemon imports no pi SDK at all: it needs the `pi` binary, plus one prebuilt native addon for
terminals. The session's JSONL
file stays the source of truth, so a session started from a phone resumes with `pi --session <id>`
in a terminal, and vice versa.

**Client neutral by construction.** The session surface is
[`@earendil-works/pi-protocol`](https://pi.dev) — pi's own remote-session protocol, for which pi
publishes schemas and a client but no server. This daemon is the missing server, so pi's
`PiClient` and `RemoteSession` drive it unmodified. Everything that protocol does not model is a
plain JSON `/v1` API carrying the same state, so a client written in Swift, Kotlin, Python, or
`curl` needs neither CBOR nor a pi dependency. Our own clients live in separate repositories and
get no back door.

**The daemon decides less than you might expect.** Approvals and project trust belong to pi and
the operator's own pi configuration; the daemon relays the question to a client and the answer
back, and keeps no policy of its own. It also never touches a provider credential — the runner
uses the pi authentication already on the machine.

**Access.** Every request is authenticated; network position alone grants nothing. A client pairs
once by scanning a QR code carrying a short-lived single-use code and the daemon's certificate
fingerprint, then exchanges it for its own revocable device token. A tailnet is the expected way
in, but it is defence in depth — never a substitute for the token.

## Status

Specification stage. Nothing is implemented.

- [Overview](docs/overview.md) — one page: how the daemon works and how clients integrate.
- [Specification](docs/spec.md) — requirements, the runner architecture, both wire surfaces,
  the file API, terminals, access, safety, lifecycle, and the three operating systems.
- [Implementation plan](docs/plan.md) — ten milestones, acceptance criteria, and risks.
