// Spike-only extension, loaded with `-e`. Exists to prove M0 item 4: that a
// dialog raised inside pi (ctx.ui.confirm / ctx.ui.input) surfaces in RPC mode
// as extension_ui_request, blocks the runner, and resolves when the daemon
// writes extension_ui_response.
//
// This is NOT the daemon's design — spec §7.2 says the daemon has no approval
// gate of its own. Here it stands in for "whatever the operator's pi setup
// does that asks a human".

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // A permission-gate stand-in: every shell command asks.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      const ok = await ctx.ui.confirm("Run this command?", command);
      if (!ok) return { block: true, reason: "Denied by the remote client", terminate: true };
    }
    return undefined;
  });

  // An ask_user tool backed by ctx.ui.input — the relay path for questions.
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a question and wait for their one-line answer.",
    parameters: Type.Object({
      question: Type.String({ description: "The question, as one plain-text line." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.input(params.question);
      const text = answer === undefined ? "The user did not answer." : `The user answered: ${answer}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
