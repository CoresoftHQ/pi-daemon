# M0 — feasibility spike

Throwaway code. Nothing here ships; it exists to answer the go/no-go questions in
[the plan](../docs/plan.md#m0--feasibility-in-throwaway-code) against a real `pi` (0.84.4) on
Windows, 2026-09-04.

**Verdict: GO.** Both load-bearing claims hold.

## Results

| # | Claim | Result |
| --- | --- | --- |
| 1 | `pi --mode rpc` can be driven over JSONL with a hand-rolled splitter | **Yes.** `prompt`, `steer`, `abort`, `get_state`, `get_messages`, `get_available_models`, `set_model`, `set_thinking_level`, `set_session_name` all used. |
| 2 | RPC events project into a `SessionSnapshot` + `TranscriptProgress` that pi's own reducers accept | **Yes.** pi's `RemoteSession` reducer and an independent reducer fed our raw events produce identical transcripts. One schema rule found: `item_finished` admits only assistant and tool items; a user item is `item_started` + the next snapshot. |
| 3 | Our server half of pi-protocol works with pi's unmodified `PiClient` | **Yes.** `hello`, `list`, `create`, `attach`, `detach`, `prompt`, `abort`, `set_model` over a WebSocket, plus `invalid_request` mapping for a `cwd` outside the root. |
| 4 | `extension_ui_request` / `extension_ui_response` relay a dialog raised inside pi | **Yes.** `ctx.ui.input()` (an `ask_user` tool) and `ctx.ui.confirm()` (a tool_call gate) both blocked the runner until answered; the model saw the answer. |
| 5 | Kill a runner mid-turn; the tree dies; `--session <id>` rehydrates | **Yes.** Rehydrated in ~450 ms with full history (11 items). Nothing left alive after `taskkill /T`. |
| 6 | Cost of a runner | ~**95–100 MB RSS** idle and after a turn; spawn-to-ready **~0.5–1.0 s** warm; five concurrent runners in 1.9 s wall, ~490 MB total. First token 1.2–2.9 s (Haiku). |
| 7 | `node-pty` loads from a prebuild with no compiler present | **Yes on Windows** (`prebuilds/win32-x64`, no `node-gyp` run). **No Linux prebuilds ship in 1.1.0** — see findings. |
| 8 | A `@xterm/headless` buffer serialises to VT bytes that reproduce the screen elsewhere | **Yes, headless → headless** (32 lines identical, colours preserved; 10k-line scrollback ≈ 9 MB). Browser check with `xterm.js` / `ghostty-web` **not yet done** — manual, pending. |
| 9 | A session file can be re-homed under another workspace | **By explicit path: yes** (`--session <file>` from a different cwd, same id, full history, with or without `--session-dir`). **By id: pi asks** "Session found in different project … Fork this session into current directory? [y/N]", which RPC mode cannot answer. |

`client-test.mjs`: 16/16 checks. `term-test.mjs`: PASS. `portability-probe.mjs`, `measure.mjs`,
`spawn-timing.mjs`, `ext-timing.mjs`, `warm-timing.mjs`: recorded above.

## Findings that feed back into the spec and plan

1. **Linux has no `node-pty` prebuild upstream.** `prebuilds/` in 1.1.0 covers win32 x64/arm64
   and darwin x64/arm64 only; on Linux the install falls through to `node-gyp rebuild`. The
   spec's install guarantee needs one of: shipping our own Linux prebuilds, a multiarch fork
   (`@homebridge/node-pty-prebuilt-multiarch`), or the sidecar. Decision for M1/M7.
2. **Cold first spawn can take ~30 s; warm spawns are ~0.5 s.** The first `pi` start after
   install paid ~30 s regardless of flags; every later start was 0.45–1.0 s isolated, ~4 s with
   the operator's global extensions loaded. The daemon should warm one runner at startup and
   report spawn time in `doctor`.
3. **Moving a session = copy the file, open by path.** Opening by id from another directory
   triggers pi's interactive fork prompt. Spec §11.9 updated.
4. **`--session-dir` changes the layout.** With it, pi writes the file flat, no `--<path>--`
   key. The daemon should use pi's default store so terminal `pi` and the daemon see the same
   sessions; the spike used `--session-dir` only for isolation.
5. **A dialog can outlive its runner.** Answering an `extension_ui_request` after the runner
   died is a normal race; the relay must treat a write to a dead runner as "dialog cancelled",
   not as an exception.
6. **Use pi's entry ids.** The spike mints transcript item ids; the daemon should take them from
   `get_entries`, which is documented as a durable cursor (`since=<entryId>`).
7. **`get_available_models` lists configured models, not authenticated ones.** The spike marks
   all 53 `authenticated: true`; the daemon needs a better source before `capabilities` can
   report providers honestly.
8. **`RemoteSession.id` is `undefined` after `dispose()`.** A client that wants to reattach
   must capture the id first. Worth a line in the client docs.
9. **Windows `pi` is an npm `.cmd` shim.** Node refuses to spawn it without a shell; the runner
   resolves the CLI entry (`dist/bundle/cli.js`) and runs it under its own `node`. `PI_BIN`
   overrides.

## Running it

```
cd spike && npm install
node term-test.mjs            # PTY + headless snapshot, no model
node measure.mjs              # one short model call
node client-test.mjs          # several model calls; ~2 minutes
node portability-probe.mjs    # one model call
```

Requires `pi` on `PATH` with a provider authenticated. Everything runs in `spike/tmp/` and an
isolated `--session-dir`; nothing touches `~/.pi/agent/sessions`.
