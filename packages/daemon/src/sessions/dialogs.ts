// The dialog relay table (spec §7.2). The daemon owns only what a relay needs: which requests
// are outstanding, who answered first, and what happens when the runner dies underneath one.
// No policy, no timeouts of its own — pi's own timeout applies.

import type { ExtensionUiRequest, ExtensionUiResponse } from "../runners/rpc.ts";
import { BLOCKING_UI_METHODS } from "../runners/rpc.ts";

export interface PendingDialog {
  dialogId: string;
  sessionId: string;
  request: ExtensionUiRequest;
  openedAt: number;
  /** True for select / confirm / input / editor; false for notify-style advisories. */
  blocking: boolean;
}

export type DialogResolution = "answered" | "cancelled" | "runner_exited" | "superseded";

export interface ClosedDialog extends PendingDialog {
  resolution: DialogResolution;
  answeredBy?: string;
  closedAt: number;
}

export type RespondResult =
  | { ok: true; dialog: ClosedDialog }
  | { ok: false; reason: "unknown" | "already-resolved"; resolution?: DialogResolution; answeredBy?: string };

export class DialogTable {
  readonly #open = new Map<string, PendingDialog>();
  /** Recently closed, so a late second answer gets a 409 that names who won. */
  readonly #closed = new Map<string, ClosedDialog>();
  readonly #now: () => number;
  readonly #keepClosed: number;

  constructor(options: { now?: () => number; keepClosed?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#keepClosed = options.keepClosed ?? 200;
  }

  open(sessionId: string, request: ExtensionUiRequest): PendingDialog {
    const dialog: PendingDialog = {
      dialogId: `${sessionId}:${request.id}`,
      sessionId,
      request,
      openedAt: this.#now(),
      blocking: BLOCKING_UI_METHODS.has(request.method),
    };
    if (dialog.blocking) this.#open.set(dialog.dialogId, dialog);
    return dialog;
  }

  get(dialogId: string): PendingDialog | undefined {
    return this.#open.get(dialogId);
  }

  /** First answer wins. Returns the closed record, or why this answer was refused. */
  respond(dialogId: string, _response: ExtensionUiResponse, answeredBy: string): RespondResult {
    const pending = this.#open.get(dialogId);
    if (!pending) {
      const closed = this.#closed.get(dialogId);
      if (closed)
        return {
          ok: false,
          reason: "already-resolved",
          resolution: closed.resolution,
          ...(closed.answeredBy ? { answeredBy: closed.answeredBy } : {}),
        };
      return { ok: false, reason: "unknown" };
    }
    return { ok: true, dialog: this.#close(pending, "answered", answeredBy) };
  }

  /** Close every open dialog of a session; the runner is gone and so are they. */
  closeAllForSession(sessionId: string, resolution: DialogResolution = "runner_exited"): ClosedDialog[] {
    const closed: ClosedDialog[] = [];
    for (const d of [...this.#open.values()])
      if (d.sessionId === sessionId) closed.push(this.#close(d, resolution));
    return closed;
  }

  #close(pending: PendingDialog, resolution: DialogResolution, answeredBy?: string): ClosedDialog {
    this.#open.delete(pending.dialogId);
    const closed: ClosedDialog = {
      ...pending,
      resolution,
      closedAt: this.#now(),
      ...(answeredBy ? { answeredBy } : {}),
    };
    this.#closed.set(pending.dialogId, closed);
    if (this.#closed.size > this.#keepClosed) {
      const oldest = this.#closed.keys().next().value;
      if (oldest !== undefined) this.#closed.delete(oldest);
    }
    return closed;
  }

  openFor(sessionId: string): PendingDialog[] {
    return [...this.#open.values()].filter((d) => d.sessionId === sessionId);
  }

  get openCount(): number {
    return this.#open.size;
  }
}
