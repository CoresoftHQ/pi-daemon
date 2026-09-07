// The environment a child of the daemon may see (spec §5.5, §7.3): everything the user has,
// minus anything the daemon holds. `PI_DAEMON_PI` stays because it points at pi, not at us.

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^PI_DAEMON_/i.test(k) && !/^PI_DAEMON_PI$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The same, as the string map a PTY spawn wants. */
export function scrubEnvStrings(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubEnv(env))) if (v !== undefined) out[k] = v;
  return out;
}
