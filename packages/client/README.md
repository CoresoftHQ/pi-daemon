# @coresoft-hq/pi-daemon-client

A small TypeScript client for [pi-daemon](https://github.com/CoresoftHQ/pi-daemon): pairing,
every `/v1` route as a typed method, the event stream with resume and reconnect built in, and
terminal streams. Runs in Node 22+ and in browsers; no dependencies at runtime (it uses the
platform's `fetch` and `WebSocket`).

```sh
npm i @coresoft-hq/pi-daemon-client
```

```ts
import { PiDaemonClient } from "@coresoft-hq/pi-daemon-client";

// once: redeem the code from `pi-daemon pair` and keep the token
const paired = await PiDaemonClient.pair("https://box.tail3f0fb7.ts.net:8790", {
  code: "K7M4-QP2X", deviceName: "my phone", platform: "ios",
});

const daemon = new PiDaemonClient({ baseUrl: "https://box.tail3f0fb7.ts.net:8790", token: paired.token });
const caps = await daemon.capabilities();                 // features, absent, limits, pi version

const session = await daemon.sessions.create();          // in the default workspace
const events = daemon.events({ scopes: [`session:${session.id}`] });
events.on("session.phase", (e) => console.log(e.payload.phase, e.payload.runId));
events.on("dialog.opened", (e) => daemon.dialogs.respond(e.payload.dialogId, { confirmed: true }));
await daemon.sessions.prompt(session.id, "summarise this repository", { idempotencyKey: crypto.randomUUID() });

const file = await daemon.workspaces.file(session.workspaceId!, "README.md");
await daemon.workspaces.writeFile(session.workspaceId!, "README.md", `${file!.text()}\n`, { ifMatch: file!.etag });

const term = await daemon.terminals.open(session.workspaceId!, { cols: 120, rows: 40 });
const conn = await daemon.terminals.attach(term.id, {
  onSnapshot: (s) => xterm.write(s.data),
  onData: (bytes) => xterm.write(bytes),
});
conn.send("ls\r");
```

- Every method returns the contract's shapes (`@coresoft-hq/pi-daemon-contract`), typed.
- Errors are `DaemonError` with `status`, `code`, `message`, and the daemon's extra fields.
- `daemon.events()` tracks `since`, replays on reconnect with exponential backoff, and turns
  `snapshot.required` into an event so you know to re-read state; `events.since` is what to
  persist for a later resume.
- WebSockets authenticate with a single-use connect ticket the client mints for you, which is
  what works in browsers; nothing else is needed.

The call-by-call guide is [docs/clients.md](https://github.com/CoresoftHQ/pi-daemon/blob/main/docs/clients.md).
