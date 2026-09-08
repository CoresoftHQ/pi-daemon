# Operating pi-daemon

What an operator needs to know before pointing a phone at a machine. The
[specification](spec.md) says why; this says what to do.

## 1. What a device token is

**A valid device token is code execution on this machine as the user the daemon runs as.**
Pi has no sandbox: its tools read, write, and run shell commands with the runner's permissions,
and a terminal is a shell. The daemon adds authentication, pairing, revocation, and a scrubbed
environment around that fact; it does not put a boundary around it. So:

- Run the daemon as a user that owns only what the agent should reach. Not your admin account.
- Treat a device token like an SSH key. Revoke a lost phone (`pi-daemon pair --revoke <id>`)
  the way you would remove its key.
- Put untrusted repositories in a container or a VM, not in a workspace of a daemon on your
  workstation.
- The daemon never handles a provider credential. The runner uses your own pi sign-in, and no
  route exposes a key; `pi-daemon doctor` tells you whether pi has an authenticated provider.

## 2. Threat model, briefly

| Who | What they can do | What stops them |
| --- | --- | --- |
| Someone on the internet | Nothing: the daemon binds loopback by default, or a tailnet address | Bind choice; Tailscale's own authentication |
| Someone on your tailnet without a token | Read `GET /v1/health`. Every other route and every socket upgrade needs a bearer token | Tokens are required always; tailnet identity is display and an optional allowlist, never authorisation |
| Someone who photographs a pairing QR | Race you to redeem a single-use code within 120 s, and only against the daemon whose certificate fingerprint the QR carries | Single use, short life, five attempts, one code at a time, `pair --confirm` for a local y/N |
| Someone with a device token | Everything a member can: sessions, files inside registered workspaces, terminals | Owner-only routes (registration, devices); revocation closes live connections |
| A local user on the same machine | Connect to the local pi-protocol endpoint and the control endpoint without a token | Filesystem permissions on the Unix socket; the named pipe's default DACL on Windows (the creating user) |
| The agent itself, or a shell in a terminal | Read the daemon's environment | It is scrubbed of every `PI_DAEMON_*` value before the spawn; tokens are never in the environment |
| A client that floods | Fill a buffer | Per-connection caps cut slow or flooding clients with a reason; the PTY and the runner never block on them |

The file routes are the one place the daemon itself is the boundary: every path is joined to
the workspace root, resolved through `realpath`, and refused if it lands outside, with `..`,
absolute, drive-relative, UNC, control characters, and out-pointing symlinks all failing the
same way. Everything else is pi's.

## 3. Install

```sh
npm install -g pi-daemon        # Node 22.19 or newer; no compiler needed
pi-daemon doctor                # pi on PATH? signed in? port free? service? clock?
pi-daemon install               # systemd user unit / LaunchAgent / logon task, then start
pi-daemon status
```

`doctor` is the place to start when anything is off. It names the problem and the fix.

On Linux, `install` also runs `loginctl enable-linger` so the daemon survives your logout on a
headless box. On Windows it is a logon task needing no admin; a boot-time Windows Service is not
provided in 1.0. Logs rotate under the platform's log directory; `pi-daemon logs -f` follows them.
The README has the per-platform prerequisites.

## 4. Reaching it: tailnet and TLS

By default the daemon listens on `127.0.0.1:8790` with no TLS. That is fine for a client on the
same machine and useless for a phone. The intended path in is a tailnet:

```sh
pi-daemon config set bind tailscale
pi-daemon stop && pi-daemon start
pi-daemon pair
```

With `bind: tailscale` the daemon listens on this machine's Tailscale address and obtains a
publicly trusted certificate for its MagicDNS name through `tailscale cert`. A browser then
gets a real `wss://` with no interstitial, which is what the web client needs. Requirements:
Tailscale running, MagicDNS on, and HTTPS certificates enabled for your tailnet in the admin
console. `doctor` reports all three.

An explicit address (`config set bind 192.168.1.20`) uses a self-signed certificate whose
fingerprint travels in the pairing QR, so native clients pin it. Browsers cannot pin, so this
mode has no clean web story. Windows will raise a firewall prompt on the first non-loopback
bind.

`config set tailnet.allowedUsers '["you@example.com"]'` limits *who on the tailnet* may present a
token. It is defence in depth on top of the token, never a substitute: if Tailscale is down the
daemon keeps working and keeps requiring tokens.

## 5. Pairing

`pi-daemon pair` prints a QR code and the same payload as text. The code is single use, valid
for two minutes, and buys one device token. `pair --confirm` makes the daemon ask you y/N in
that terminal at the moment of redemption, which is the right ceremony for the first phone.
The first device paired becomes the owner; later ones are members.

For a service such as n8n, a QR is the wrong ceremony: `pi-daemon devices create --name n8n`
prints a token once. Treat it as described in §1.

## 6. What the daemon does not decide

- **Approvals.** Whether a tool call is acceptable is pi's question, configured in your own pi
  setup. The daemon relays pi's dialogs to clients and the answer back. There is no policy file
  here and never will be one.
- **Trust.** Workspace trust is pi's (`pi.trust` in the config passes `-a` / `-na` through, and
  that is all).
- **Tools.** `pi.tools`, `pi.excludeTools`, and `pi.noTools` pin the runner's tool set at spawn,
  out of any client's reach. A read-only daemon is `files.write: false`, `terminals.enabled:
  false`, and a tool set without `write` and `bash`, together in one configuration.
- **Scheduling.** A client matter. The daemon runs what it is asked to, when it is asked.

## 7. Recovering from a lost owner device

The owner token lives on the phone or laptop that paired first. If that device is gone:

1. On the machine itself: `pi-daemon pair --list` shows every device; `pi-daemon pair --revoke
   <id>` revokes the lost one and closes its connections. Neither needs a token, because they
   go through the local control endpoint.
2. `pi-daemon devices create --name recovery --role owner` mints a new owner token on the
   machine, printed once. Pair the replacement device with `pi-daemon pair --confirm`, then
   promote it with `PATCH /v1/devices/:id { role: "owner" }` using the recovery token, and
   revoke the recovery token.

If the machine itself is compromised, none of this helps; see §1.

## 8. Limits and where they live

`pi-daemon config get limits` shows them: runners (8), terminals (16), scrollback lines
(10 000), file size served (4 MiB), idle timeout before a runner is evicted (30 minutes), and
the event replay ring. `GET /v1/capabilities` tells clients the same numbers, so a client
degrades against a fact rather than a failed call.

## 9. Upgrading

The daemon declares a supported pi range (in `capabilities.pi.supported`) and detects the
installed version at start. A pi upgrade inside the range needs no daemon release; one outside
it makes `doctor` warn and the daemon still try. A daemon upgrade is `npm i -g pi-daemon@latest`
followed by `pi-daemon stop && pi-daemon start`; sessions survive because their history is pi's
file, terminals do not (spec §5.5).
