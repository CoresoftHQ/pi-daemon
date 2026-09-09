# @coresoft-hq/pi-daemon-contract

The pi-daemon `/v1` wire contract: every request and response shape, the event envelope and
every event payload, the terminal stream's control frames, runtime validation schemas, and an
OpenAPI 3.1 document generated from them. The daemon validates against these; clients compile
against them.

```sh
npm i @coresoft-hq/pi-daemon-contract
```

```ts
import { Value } from "typebox/value";
import { EventEnvelope, EventPayloads, PromptRequest, SessionSnapshot } from "@coresoft-hq/pi-daemon-contract";
import type { Capabilities, PromptResponse, TerminalServerControl } from "@coresoft-hq/pi-daemon-contract";

Value.Check(PromptRequest, { text: "hello" }); // true
```

- Each schema is a [TypeBox](https://github.com/sinclairzx81/typebox) value with a `Static`
  type of the same name: `SessionSnapshot`, `TranscriptItem`, `Workspace`, `FileTreeEntry`,
  `TerminalInfo`, and so on.
- `EventPayloads` maps every event `type` to its payload schema; `EventEnvelope` is the frame
  around it; `EventStreamControl` is what a client may send on the event WebSocket.
- `TerminalClientControl` and `TerminalServerControl` are the JSON frames on a terminal stream.
- `openApiDocument({ version })` returns the OpenAPI 3.1 document for generators in other
  languages; `CONTRACT_VERSION` is `1`.

The contract is additive within a major version. See
[docs/clients.md](https://github.com/CoresoftHQ/pi-daemon/blob/main/docs/clients.md) for how a
client uses it end to end.
