// Projects pi RPC-mode events into pi-protocol shapes: one authoritative
// SessionSnapshot with a monotonic revision, plus transient TranscriptProgress.
//
// Rule (pi-protocol README): snapshots are authoritative, progress is a hint.
// Finished items live in snapshot.transcript; in-flight items travel only as
// progress until they finish. The projector emits:
//   { kind: "progress", progress }   for streaming
//   { kind: "snapshot" }             when the snapshot changed authoritatively
//
// Spike-grade simplifications, all noted for M2:
//   - item ids are minted here, not taken from pi's entry ids (get_entries)
//   - bashExecution / custom messages are not projected
//   - model metadata comes from get_state.model, thinking levels are guessed

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function usageOf(u) {
  if (!u) return undefined;
  const input = u.input ?? 0, output = u.output ?? 0, cacheRead = u.cacheRead ?? 0, cacheWrite = u.cacheWrite ?? 0;
  const out = {
    input, output, cacheRead, cacheWrite,
    totalTokens: u.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: {
      input: u.cost?.input ?? 0,
      output: u.cost?.output ?? 0,
      cacheRead: u.cost?.cacheRead ?? 0,
      cacheWrite: u.cost?.cacheWrite ?? 0,
      total: u.cost?.total ?? 0,
    },
  };
  if (u.reasoning !== undefined) out.reasoning = u.reasoning;
  return out;
}

function userContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content ?? []).map((b) =>
    b.type === "image" ? { type: "image", data: b.data, mimeType: b.mimeType } : { type: "text", text: b.text ?? "" },
  );
}

function assistantContent(content) {
  return (content ?? []).map((b) => {
    if (b.type === "toolCall") return { type: "toolCall", toolCallId: b.id, toolName: b.name, input: b.arguments ?? {} };
    if (b.type === "thinking") return b.redacted ? { type: "thinking", thinking: b.thinking ?? "", redacted: true } : { type: "thinking", thinking: b.thinking ?? "" };
    return { type: "text", text: b.text ?? "" };
  });
}

function toolContent(content) {
  return (content ?? []).map((b) =>
    b.type === "image" ? { type: "image", data: b.data, mimeType: b.mimeType } : { type: "text", text: b.text ?? "" },
  );
}

function modelRef(m) {
  return m ? { provider: m.provider, id: m.id } : { provider: "unknown", id: "unknown" };
}

export class Projector {
  #n = 0;
  #streaming = new Map(); // id -> in-flight item
  #assistantIdByStart = null; // the assistant item currently streaming
  #toolInputs = new Map(); // toolCallId -> input (from the assistant's toolCall block)
  #toolItemIds = new Map(); // toolCallId -> tool item id

  constructor({ sessionId, cwd, state, createdAt }) {
    this.snapshot = {
      id: sessionId,
      cwd,
      createdAt: createdAt ?? Date.now(),
      updatedAt: Date.now(),
      phase: "idle",
      model: modelRef(state?.model),
      thinkingLevel: THINKING_LEVELS.includes(state?.thinkingLevel) ? state.thinkingLevel : "off",
      attached: false,
      locked: false,
      revision: 0,
      transcript: [],
      queuedSteer: [],
      queuedSteerCount: 0,
    };
    if (state?.sessionName) this.snapshot.name = state.sessionName;
  }

  #id(prefix) {
    return `${prefix}_${++this.#n}`;
  }

  #bump() {
    this.snapshot.revision += 1;
    this.snapshot.updatedAt = Date.now();
  }

  /** Apply the state returned by get_state (model / thinking / name). */
  applyState(state) {
    this.snapshot.model = modelRef(state.model);
    if (THINKING_LEVELS.includes(state.thinkingLevel)) this.snapshot.thinkingLevel = state.thinkingLevel;
    if (state.sessionName) this.snapshot.name = state.sessionName;
    else delete this.snapshot.name;
    this.#bump();
  }

  setAttached(attached) {
    this.snapshot.attached = attached;
    this.#bump();
  }

  /** Load history from get_messages (AgentMessage[]) into the authoritative transcript. */
  loadMessages(messages) {
    const transcript = [];
    for (const m of messages) {
      if (m.role === "user") {
        transcript.push({ id: this.#id("u"), role: "user", content: userContent(m.content), timestamp: m.timestamp ?? Date.now() });
      } else if (m.role === "assistant") {
        for (const b of m.content ?? []) if (b.type === "toolCall") this.#toolInputs.set(b.id, b.arguments ?? {});
        transcript.push(this.#finishedAssistant(this.#id("a"), m));
      } else if (m.role === "toolResult") {
        transcript.push({
          id: this.#id("t"),
          role: "tool",
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          input: this.#toolInputs.get(m.toolCallId) ?? {},
          content: toolContent(m.content),
          ...(m.details !== undefined ? { details: m.details } : {}),
          ...(m.usage ? { usage: usageOf(m.usage) } : {}),
          timestamp: m.timestamp ?? Date.now(),
          status: m.isError ? "error" : "complete",
          isError: !!m.isError,
        });
      }
      // bashExecution / custom: not projected in the spike
    }
    this.snapshot.transcript = transcript;
    this.#bump();
  }

  #finishedAssistant(id, m) {
    const base = {
      id,
      role: "assistant",
      content: assistantContent(m.content),
      model: { provider: m.provider ?? this.snapshot.model.provider, id: m.model ?? this.snapshot.model.id },
      ...(m.usage ? { usage: usageOf(m.usage) } : {}),
      timestamp: m.timestamp ?? Date.now(),
    };
    switch (m.stopReason) {
      case "error":
        return { ...base, status: "error", stopReason: "error", ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}) };
      case "aborted":
        return { ...base, status: "aborted", stopReason: "aborted", ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}) };
      case "length":
        return { ...base, status: "complete", stopReason: "length" };
      case "toolUse":
        return { ...base, status: "complete", stopReason: "toolUse" };
      default:
        return { ...base, status: "complete", stopReason: "stop" };
    }
  }

  /**
   * Apply one RPC event. Returns an array of outputs:
   *   { kind: "progress", progress } | { kind: "snapshot" }
   */
  apply(ev) {
    const out = [];
    const progress = (p) => out.push({ kind: "progress", progress: p });
    const snap = () => { this.#bump(); out.push({ kind: "snapshot" }); };

    switch (ev.type) {
      case "agent_start":
        this.snapshot.phase = "turn";
        snap();
        break;
      case "agent_settled":
        this.snapshot.phase = "idle";
        snap();
        break;
      case "compaction_start":
        this.snapshot.phase = "compaction";
        snap();
        break;
      case "compaction_end":
        this.snapshot.phase = "turn";
        snap();
        break;
      case "auto_retry_start":
        this.snapshot.phase = "retry";
        snap();
        break;
      case "auto_retry_end":
        this.snapshot.phase = "turn";
        snap();
        break;

      case "message_start": {
        const m = ev.message;
        if (m?.role === "user") {
          const item = { id: this.#id("u"), role: "user", content: userContent(m.content), timestamp: m.timestamp ?? Date.now() };
          this.#streaming.set(item.id, item);
          progress({ type: "item_started", item });
        } else if (m?.role === "assistant") {
          const item = {
            id: this.#id("a"),
            role: "assistant",
            content: assistantContent(m.content),
            model: { provider: m.provider ?? this.snapshot.model.provider, id: m.model ?? this.snapshot.model.id },
            timestamp: m.timestamp ?? Date.now(),
            status: "streaming",
          };
          this.#streaming.set(item.id, item);
          this.#assistantIdByStart = item.id;
          progress({ type: "item_started", item });
        }
        break;
      }

      case "message_update": {
        const id = this.#assistantIdByStart;
        const item = id && this.#streaming.get(id);
        const e = ev.assistantMessageEvent;
        if (!item || !e) break;
        const idx = e.contentIndex ?? item.content.length;
        const ensure = (block) => { while (item.content.length <= idx) item.content.push(block()); return item.content[idx]; };
        switch (e.type) {
          case "text_start":
            ensure(() => ({ type: "text", text: "" }));
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          case "text_delta":
            ensure(() => ({ type: "text", text: "" })).text += e.delta ?? "";
            progress({ type: "assistant_delta", messageId: id, contentIndex: idx, kind: "text", delta: e.delta ?? "" });
            break;
          case "text_end":
            ensure(() => ({ type: "text", text: "" })).text = e.content ?? item.content[idx].text;
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          case "thinking_start":
            ensure(() => ({ type: "thinking", thinking: "" }));
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          case "thinking_delta":
            ensure(() => ({ type: "thinking", thinking: "" })).thinking += e.delta ?? "";
            progress({ type: "assistant_delta", messageId: id, contentIndex: idx, kind: "thinking", delta: e.delta ?? "" });
            break;
          case "thinking_end":
            ensure(() => ({ type: "thinking", thinking: "" })).thinking = e.content ?? item.content[idx].thinking;
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          case "toolcall_start":
            ensure(() => ({ type: "toolCall", toolCallId: e.id, toolName: e.toolName, input: {} }));
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          case "toolcall_delta":
            progress({ type: "assistant_delta", messageId: id, contentIndex: idx, kind: "toolCall", delta: e.delta ?? "" });
            break;
          case "toolcall_end": {
            const tc = e.toolCall;
            const block = ensure(() => ({ type: "toolCall", toolCallId: tc?.id, toolName: tc?.name, input: {} }));
            if (tc) { block.toolCallId = tc.id; block.toolName = tc.name; block.input = tc.arguments ?? {}; this.#toolInputs.set(tc.id, block.input); }
            progress({ type: "item_updated", item: structuredClone(item) });
            break;
          }
          default:
            break;
        }
        break;
      }

      case "message_end": {
        const m = ev.message;
        if (m?.role === "user") {
          // A user item has no lifecycle: pi-protocol's item_finished admits only
          // assistant and tool items. It was announced with item_started; it
          // becomes authoritative through the next snapshot.
          const id = [...this.#streaming.keys()].reverse().find((k) => k.startsWith("u_"));
          if (id) {
            const item = this.#streaming.get(id);
            this.#streaming.delete(id);
            item.content = userContent(m.content);
            this.snapshot.transcript.push(item);
            snap();
          }
        } else if (m?.role === "assistant") {
          const id = this.#assistantIdByStart;
          if (id && this.#streaming.has(id)) {
            this.#streaming.delete(id);
            this.#assistantIdByStart = null;
            for (const b of m.content ?? []) if (b.type === "toolCall") this.#toolInputs.set(b.id, b.arguments ?? {});
            const item = this.#finishedAssistant(id, m);
            this.snapshot.transcript.push(item);
            progress({ type: "item_finished", item });
            snap();
          }
        }
        break;
      }

      case "tool_execution_start": {
        const item = {
          id: this.#id("t"),
          role: "tool",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: ev.args ?? this.#toolInputs.get(ev.toolCallId) ?? {},
          content: [],
          timestamp: Date.now(),
          status: "running",
          isError: false,
        };
        this.#toolItemIds.set(ev.toolCallId, item.id);
        this.#streaming.set(item.id, item);
        progress({ type: "item_started", item });
        break;
      }
      case "tool_execution_update": {
        const id = this.#toolItemIds.get(ev.toolCallId);
        const item = id && this.#streaming.get(id);
        if (!item) break;
        item.content = toolContent(ev.partialResult?.content);
        progress({ type: "item_updated", item: structuredClone(item) });
        break;
      }
      case "tool_execution_end": {
        const id = this.#toolItemIds.get(ev.toolCallId);
        const live = id && this.#streaming.get(id);
        if (!live) break;
        this.#streaming.delete(id);
        const item = {
          id,
          role: "tool",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: live.input,
          content: toolContent(ev.result?.content),
          ...(ev.result?.details !== undefined ? { details: ev.result.details } : {}),
          timestamp: live.timestamp,
          status: ev.isError ? "error" : "complete",
          isError: !!ev.isError,
        };
        this.snapshot.transcript.push(item);
        progress({ type: "item_finished", item });
        snap();
        break;
      }
      default:
        break;
    }
    return out;
  }
}
