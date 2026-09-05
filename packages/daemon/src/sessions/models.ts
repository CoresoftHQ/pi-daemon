// Which models pi knows about. pi's RPC mode answers this per session, so the host asks a
// throwaway isolated runner once at startup and caches the answer; a session can refresh it.

import type { Launcher } from "../os/spawn.ts";
import type { RpcModel } from "../runners/rpc.ts";
import { Runner } from "../runners/runner.ts";

/** The model shape `serve` encodes from; re-exported here so serve never imports runners. */
export type AvailableModel = RpcModel;

export interface ProbeModelsOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  launcher?: Launcher | undefined;
  timeoutMs?: number | undefined;
}

/** Spawn `pi --mode rpc --no-tools --no-session` in isolation, ask for models, stop it. */
export async function probeAvailableModels(options: ProbeModelsOptions): Promise<RpcModel[]> {
  const runner = Runner.spawn({
    cwd: options.cwd,
    env: options.env,
    launcher: options.launcher,
    isolate: true,
    noTools: true,
    noSession: true,
  });
  const timeout = setTimeout(() => runner.kill(), options.timeoutMs ?? 60_000);
  try {
    const res = await runner.send<{ models: RpcModel[] }>({ type: "get_available_models" });
    return res.success && res.data ? res.data.models : [];
  } finally {
    clearTimeout(timeout);
    await runner.stop({ graceMs: 2000 });
  }
}
