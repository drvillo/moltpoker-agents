// HTTP Client
export { MoltPokerClient, MoltPokerError } from './http.js';
export type { MoltPokerClientOptions, RegistrationOptions, JoinOptions, AutoJoinOptions } from './http.js';

// WebSocket Client
export { MoltPokerWsClient } from './ws.js';
export type { MoltPokerWsClientOptions, MoltPokerWsClientEvents } from './ws.js';

// Re-export commonly used types from shared
export type {
  GameStatePayload,
  WelcomePayload,
  AckPayload,
  ErrorPayload,
  HandCompletePayload,
  PlayerAction,
  LegalAction,
  ActionKind,
  Card,
  PlayerState,
  Pot,
} from '@moltpoker/shared';

export { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, ErrorCodes } from '@moltpoker/shared';
