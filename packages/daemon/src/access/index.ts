// `access`: devices, tokens, pairing, tickets, TLS, tailnet awareness. Nothing here knows about
// sessions or wire encodings; `serve` asks it whether a request may proceed.

export type { AccessControl, AuthFailure, AuthOutcome, Principal } from "./authenticate.ts";
export { authenticate, createUpgradeAuthenticator, hasRole, peerAddress } from "./authenticate.ts";
export type { DaemonIdentity } from "./daemon-identity.ts";
export { loadOrCreateIdentity } from "./daemon-identity.ts";
export type { DeviceRecord, DeviceStoreOptions, DeviceView, Role } from "./devices.ts";
export { DeviceStore } from "./devices.ts";
export type { AccessRoutesOptions, RouteHandler } from "./http.ts";
export { createAccessRoutes, readJson, requirePrincipal, sendError, sendJson } from "./http.ts";
export type { PairingCode, PairingOptions, PairingPayload, RedeemRequest, RedeemResult } from "./pairing.ts";
export { PairingService } from "./pairing.ts";
export type { RateDecision, RateLimiterOptions } from "./ratelimit.ts";
export { RateLimiter } from "./ratelimit.ts";
export type { TailnetIdentity, TailnetPeer, TailnetStatus, TailnetUser, TailscaleExec } from "./tailscale.ts";
export {
  identityFor,
  isTailnetAddress,
  normaliseIp,
  parseStatus,
  runTailscale,
  TailnetStatusCache,
  tailnetStatus,
} from "./tailscale.ts";
export type { ConnectTicketsOptions } from "./tickets.ts";
export { ConnectTickets } from "./tickets.ts";
export type { SelfSignedOptions, TailscaleCertExec, TlsMaterial, TlsMode } from "./tls.ts";
export { selfSignedMaterial, spkiFingerprint, tailscaleCertMaterial } from "./tls.ts";
export type { MintedToken, ParsedToken } from "./tokens.ts";
export {
  crockfordId,
  hashSecret,
  mintToken,
  normaliseCrockford,
  parseToken,
  verifySecret,
} from "./tokens.ts";
