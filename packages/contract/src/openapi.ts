// OpenAPI 3.1, generated from the schemas rather than maintained beside them (spec §5). TypeBox
// schemas are JSON Schema, which OpenAPI 3.1 embeds directly.

import type { TSchema } from "typebox";
import { EventEnvelope, EventStreamControl, SnapshotRequired } from "./events.ts";
import {
  Capabilities,
  CompactRequest,
  ConnectTicketResponse,
  CreateSessionRequest,
  DeviceList,
  DevicePatch,
  DialogConflict,
  DialogRespondRequest,
  DialogRespondResponse,
  EntriesResponse,
  ErrorBody,
  ForkRequest,
  Health,
  PairRedeemRequest,
  PairRedeemResponse,
  PromptRequest,
  PromptResponse,
  QueueModeRequest,
  SessionList,
  SessionResponse,
  SetModelRequest,
  SetNameRequest,
  SetThinkingRequest,
  StatsResponse,
  TextRequest,
  TreeResponse,
} from "./requests.ts";
import { SessionSnapshot, SessionSummary, TranscriptItem } from "./session.ts";

export const CONTRACT_VERSION = 1 as const;

type Op = {
  summary: string;
  auth?: "none" | "member" | "owner";
  request?: TSchema;
  responses: Record<number, TSchema | "empty">;
  idempotencyKey?: boolean;
};

const S = (schema: TSchema) => ({ "application/json": { schema } });
const errorResponses = (codes: number[]) =>
  Object.fromEntries(codes.map((c) => [c, { description: `error ${c}`, content: S(ErrorBody) }]));

function operation(op: Op) {
  const responses: Record<string, unknown> = {};
  for (const [code, schema] of Object.entries(op.responses)) {
    responses[code] =
      schema === "empty" ? { description: "no content" } : { description: "ok", content: S(schema) };
  }
  Object.assign(responses, errorResponses(op.auth === "none" ? [400, 429] : [400, 401, 403, 404, 409, 429]));
  return {
    summary: op.summary,
    ...(op.auth && op.auth !== "none" ? { security: [{ bearer: [] }], "x-role": op.auth } : {}),
    ...(op.idempotencyKey
      ? {
          parameters: [
            { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
          ],
        }
      : {}),
    ...(op.request ? { requestBody: { required: true, content: S(op.request) } } : {}),
    responses,
  };
}

const sessionId = { name: "id", in: "path", required: true, schema: { type: "string" } };

/** The full document. Paths for M6 (workspaces, files, groups) and M7 (terminals) are added when built. */
export function openApiDocument(info: { version: string } = { version: "0.1.0" }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "pi-daemon /v1",
      version: info.version,
      description: "See docs/spec.md. Surface B: everything pi-protocol does not model.",
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A device token from /v1/pair/redeem" },
      },
      schemas: {
        SessionSnapshot,
        SessionSummary,
        TranscriptItem,
        EventEnvelope,
        EventStreamControl,
        SnapshotRequired,
        Capabilities,
        ErrorBody,
      },
    },
    paths: {
      "/v1/health": {
        get: operation({
          summary: "Liveness and version; nothing else",
          auth: "none",
          responses: { 200: Health },
        }),
      },
      "/v1/capabilities": {
        get: operation({
          summary: "What this daemon can do",
          auth: "member",
          responses: { 200: Capabilities },
        }),
      },
      "/v1/pair/redeem": {
        post: operation({
          summary: "Redeem a pairing code for a device token",
          auth: "none",
          request: PairRedeemRequest,
          responses: { 200: PairRedeemResponse },
        }),
      },
      "/v1/connect-tickets": {
        post: operation({
          summary: "A single-use ticket for a browser's socket upgrade",
          auth: "member",
          responses: { 201: ConnectTicketResponse },
        }),
      },
      "/v1/devices": {
        get: operation({ summary: "Paired devices", auth: "owner", responses: { 200: DeviceList } }),
      },
      "/v1/devices/{id}": {
        parameters: [sessionId],
        delete: operation({
          summary: "Revoke a device; its live connections close",
          auth: "owner",
          responses: { 204: "empty" },
        }),
        patch: operation({
          summary: "Rename or change role",
          auth: "owner",
          request: DevicePatch,
          responses: { 200: DeviceList },
        }),
      },
      "/v1/sessions": {
        get: operation({
          summary: "Every session pi knows about, joined to daemon state",
          auth: "member",
          responses: { 200: SessionList },
        }),
        post: operation({
          summary: "Create a session in a workspace and spawn its runner",
          auth: "member",
          request: CreateSessionRequest,
          responses: { 201: SessionResponse },
        }),
      },
      "/v1/sessions/{id}": {
        parameters: [sessionId],
        get: operation({
          summary: "The authoritative snapshot, JSON encoding",
          auth: "member",
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/entries": {
        parameters: [sessionId],
        get: operation({
          summary: "pi's session entries (get_entries), verbatim",
          auth: "member",
          responses: { 200: EntriesResponse },
        }),
      },
      "/v1/sessions/{id}/prompt": {
        parameters: [sessionId],
        post: operation({
          summary: "Send a prompt; returns the run's id",
          auth: "member",
          request: PromptRequest,
          responses: { 202: PromptResponse },
          idempotencyKey: true,
        }),
      },
      "/v1/sessions/{id}/steer": {
        parameters: [sessionId],
        post: operation({
          summary: "Queue a steering message",
          auth: "member",
          request: TextRequest,
          responses: { 202: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/follow-up": {
        parameters: [sessionId],
        post: operation({
          summary: "Queue a follow-up message",
          auth: "member",
          request: TextRequest,
          responses: { 202: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/abort": {
        parameters: [sessionId],
        post: operation({
          summary: "Abort the current turn",
          auth: "member",
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/queue-mode": {
        parameters: [sessionId],
        post: operation({
          summary: "Steering / follow-up delivery mode",
          auth: "member",
          request: QueueModeRequest,
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/clear-queue": {
        parameters: [sessionId],
        post: operation({
          summary: "Drop queued messages",
          auth: "member",
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/compact": {
        parameters: [sessionId],
        post: operation({
          summary: "Compact context",
          auth: "member",
          request: CompactRequest,
          responses: { 202: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/model": {
        parameters: [sessionId],
        post: operation({
          summary: "Switch model",
          auth: "member",
          request: SetModelRequest,
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/thinking": {
        parameters: [sessionId],
        post: operation({
          summary: "Set thinking level",
          auth: "member",
          request: SetThinkingRequest,
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/name": {
        parameters: [sessionId],
        post: operation({
          summary: "Rename the session",
          auth: "member",
          request: SetNameRequest,
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/tree": {
        parameters: [sessionId],
        get: operation({
          summary: "The session tree (get_tree)",
          auth: "member",
          responses: { 200: TreeResponse },
        }),
      },
      "/v1/sessions/{id}/fork": {
        parameters: [sessionId],
        post: operation({
          summary: "Fork from an earlier user message",
          auth: "member",
          request: ForkRequest,
          responses: { 200: SessionResponse },
        }),
      },
      "/v1/sessions/{id}/stats": {
        parameters: [sessionId],
        get: operation({
          summary: "Token usage and cost (get_session_stats)",
          auth: "member",
          responses: { 200: StatsResponse },
        }),
      },
      "/v1/dialogs/{id}/respond": {
        parameters: [sessionId],
        post: operation({
          summary: "Answer a relayed dialog; first answer wins",
          auth: "member",
          request: DialogRespondRequest,
          responses: { 200: DialogRespondResponse, 409: DialogConflict },
        }),
      },
      "/v1/events": {
        get: operation({
          summary: "The event stream as a WebSocket (JSON text frames). ?since=<seq>, ?scopes=a,b",
          auth: "member",
          responses: { 101: "empty" },
        }),
      },
      "/v1/events/sse": {
        get: operation({
          summary: "The event stream as Server-Sent Events. ?since=<seq>, ?scopes=a,b",
          auth: "member",
          responses: { 200: "empty" },
        }),
      },
    },
  };
}
