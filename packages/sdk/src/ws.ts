import { EventEmitter } from 'events';

import type {
  AckPayload,
  ErrorPayload,
  GameStatePayload,
  HandCompletePayload,
  PlayerAction,
  TableStatusPayload,
  WelcomePayload,
  WsMessageEnvelope,
} from '@moltpoker/shared';
import { ErrorCodes } from '@moltpoker/shared';
import type { ErrorCode } from '@moltpoker/shared';
import WebSocket from 'ws';


export interface MoltPokerWsClientOptions {
  wsUrl: string;
  sessionToken: string;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  pingInterval?: number;
  fatalErrorCodes?: ErrorCode[];
}

export interface MoltPokerWsClientEvents {
  welcome: (payload: WelcomePayload) => void;
  game_state: (payload: GameStatePayload) => void;
  ack: (payload: AckPayload) => void;
  error: (payload: ErrorPayload) => void;
  hand_complete: (payload: HandCompletePayload) => void;
  player_joined: (payload: { seatId: number; agentId: string; agentName: string | null; stack: number }) => void;
  player_left: (payload: { seatId: number; agentId: string }) => void;
  table_status: (payload: TableStatusPayload) => void;
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  reconnecting: (attempt: number) => void;
}

/**
 * WebSocket client for MoltPoker
 */
export class MoltPokerWsClient extends EventEmitter {
  private wsUrl: string;
  private sessionToken: string;
  private ws: WebSocket | null = null;
  private autoReconnect: boolean;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private pingInterval: number;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private fatalErrorCodes: Set<ErrorCode>;

  constructor(options: MoltPokerWsClientOptions) {
    super();
    this.wsUrl = options.wsUrl;
    this.sessionToken = options.sessionToken;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectInterval = options.reconnectInterval ?? 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.pingInterval = options.pingInterval ?? 30000;
    this.fatalErrorCodes = new Set(
      options.fatalErrorCodes ?? [
        ErrorCodes.TABLE_NOT_FOUND,
        ErrorCodes.TABLE_ENDED,
        ErrorCodes.INVALID_SESSION,
        ErrorCodes.SESSION_EXPIRED,
        ErrorCodes.UNAUTHORIZED,
        ErrorCodes.INVALID_API_KEY,
        ErrorCodes.OUTDATED_CLIENT,
      ]
    );
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const url = `${this.wsUrl}?token=${encodeURIComponent(this.sessionToken)}`;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Connection timeout'));
      }, 30000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startPingTimer();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.stopPingTimer();
        this.emit('disconnected', code, reason.toString());

        const normalizedReason = reason.toString().toLowerCase();
        if (
          code === 1000 &&
          (normalizedReason.includes('table ended') || normalizedReason.includes('kicked'))
        ) {
          this.shouldReconnect = false;
        }

        if (this.shouldReconnect && this.autoReconnect) {
          this.attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.isConnecting = false;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingTimer();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /**
   * Send an action to the server.
   */
  sendAction(action: PlayerAction, expectedSeq?: number): void {
    this.send({
      type: 'action',
      action,
      expected_seq: expectedSeq,
    });
  }

  /**
   * Send a ping message
   */
  sendPing(): void {
    this.send({
      type: 'ping',
      payload: { timestamp: Date.now() },
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a message
   */
  private send(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      const envelope: WsMessageEnvelope = JSON.parse(data);

      switch (envelope.type) {
        case 'welcome':
          this.emit('welcome', envelope.payload as WelcomePayload);
          break;
        case 'game_state':
          this.emit('game_state', envelope.payload as GameStatePayload);
          break;
        case 'ack':
          this.emit('ack', envelope.payload as AckPayload);
          break;
        case 'error': {
          const payload = envelope.payload as ErrorPayload;
          this.emit('error', payload);
          this.handleFatalError(payload);
          break;
        }
        case 'hand_complete':
          this.emit('hand_complete', envelope.payload as HandCompletePayload);
          break;
        case 'player_joined':
          this.emit('player_joined', envelope.payload as { seatId: number; agentId: string; agentName: string | null; stack: number });
          break;
        case 'player_left':
          this.emit('player_left', envelope.payload as { seatId: number; agentId: string });
          break;
        case 'table_status':
          const statusPayload = envelope.payload as TableStatusPayload;
          if (statusPayload.status === 'ended') {
            this.shouldReconnect = false;
          }
          this.emit('table_status', statusPayload);
          break;
        case 'pong':
          // Received pong, connection is alive
          break;
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  }

  /**
   * Start ping timer
   */
  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.isConnected()) {
        this.sendPing();
      }
    }, this.pingInterval);
  }

  /**
   * Stop ping timer
   */
  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Stop reconnecting on fatal errors
   */
  private handleFatalError(payload: ErrorPayload): void {
    const code = payload.code as ErrorCode;
    if (!this.fatalErrorCodes.has(code)) return;

    this.shouldReconnect = false;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1008, payload.message);
    }
  }

  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect().catch((err) => {
          console.error('Reconnect failed:', err);
        });
      }
    }, this.reconnectInterval);
  }

  // Type-safe event emitter methods
  on<K extends keyof MoltPokerWsClientEvents>(
    event: K,
    listener: MoltPokerWsClientEvents[K]
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof MoltPokerWsClientEvents>(
    event: K,
    listener: MoltPokerWsClientEvents[K]
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof MoltPokerWsClientEvents>(
    event: K,
    listener: MoltPokerWsClientEvents[K]
  ): this {
    return super.off(event, listener);
  }

  emit<K extends keyof MoltPokerWsClientEvents>(
    event: K,
    ...args: Parameters<MoltPokerWsClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
