# pi-daemon

The daemon. See [the specification](../../docs/spec.md) for what it is and
[the plan](../../docs/plan.md) for what exists yet.

```
src/
  os/          every OS-specific primitive, and the only place allowed to branch on platform
  runners/     spawning and supervising `pi --mode rpc`; the only place that knows pi exists
  sessions/    canonical session state, events, leases, dialogs, eviction          (M2)
  workspaces/  projects, worktrees, groups, files                                  (M6)
  serve/       the two wire encodings and the event stream                         (M3, M5)
  access/      devices, tokens, pairing, tickets, TLS, bind                        (M4)
  terminals/   PTYs; the only place allowed to import node-pty                     (M7)
  cli/         the `pi-daemon` command                                             (M8)
```

Tests are colocated (`*.test.ts`) and run directly under Node's type stripping — no build step:
`npm test`. Tests that need a real `pi` on `PATH` are skipped unless `PI_DAEMON_REAL_PI=1`;
service-manager round-trips are skipped unless `PI_DAEMON_SERVICE_TESTS=1`.
