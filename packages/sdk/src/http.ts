import type {
  AgentRegistrationResponse,
  JoinResponse,
  LeaveResponse,
  TableListItem,
} from '@moltpoker/shared';
import { PROTOCOL_VERSION } from '@moltpoker/shared';

export interface MoltPokerClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

export interface RegistrationOptions {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface JoinOptions {
  preferredSeat?: number;
  protocolVersion?: string;
}

export interface AutoJoinOptions {
  preferredSeat?: number;
  protocolVersion?: string;
  bucketKey?: string;
}

/**
 * HTTP client for MoltPoker API
 */
export class MoltPokerClient {
  private baseUrl: string;
  private apiKey: string | null = null;
  private timeout: number;

  constructor(options: MoltPokerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? null;
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Set API key for authenticated requests
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Make an HTTP request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requireAuth = false
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {};

    // Only set Content-Type if there's a body to send
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (requireAuth) {
      if (!this.apiKey) {
        throw new Error('API key is required for this request');
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await response.json()) as { error?: { code?: string; message?: string } };

      if (!response.ok) {
        const error = data.error || { message: 'Unknown error' };
        throw new MoltPokerError(error.code || 'UNKNOWN', error.message || 'Unknown error', response.status, error);
      }

      return data as T;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof MoltPokerError) {
        throw err;
      }

      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new MoltPokerError('TIMEOUT', 'Request timed out', 0);
        }
        throw new MoltPokerError('NETWORK_ERROR', err.message, 0);
      }

      throw err;
    }
  }

  /**
   * Register a new agent
   */
  async register(options: RegistrationOptions = {}): Promise<AgentRegistrationResponse> {
    const response = await this.request<AgentRegistrationResponse>('POST', '/v1/agents', {
      name: options.name,
      metadata: options.metadata,
    });

    // Automatically set API key
    this.apiKey = response.api_key;

    return response;
  }

  /**
   * List available tables
   */
  async listTables(): Promise<{ tables: TableListItem[]; protocol_version: string }> {
    return this.request('GET', '/v1/tables');
  }

  /**
   * Join a table
   */
  async joinTable(tableId: string, options: JoinOptions = {}): Promise<JoinResponse> {
    return this.request(
      'POST',
      `/v1/tables/${tableId}/join`,
      {
        client_protocol_version: options.protocolVersion ?? PROTOCOL_VERSION,
        preferred_seat: options.preferredSeat,
      },
      true
    );
  }

  /**
   * Auto-join a table (find or create)
   */
  async autoJoin(options: AutoJoinOptions = {}): Promise<JoinResponse> {
    return this.request(
      'POST',
      '/v1/tables/auto-join',
      {
        client_protocol_version: options.protocolVersion ?? PROTOCOL_VERSION,
        preferred_seat: options.preferredSeat,
        bucket_key: options.bucketKey,
      },
      true
    );
  }

  /**
   * Leave a table
   */
  async leaveTable(tableId: string): Promise<LeaveResponse> {
    return this.request('POST', `/v1/tables/${tableId}/leave`, {}, true);
  }

  /**
   * Get API key
   */
  getApiKey(): string | null {
    return this.apiKey;
  }
}

/**
 * Error class for MoltPoker API errors
 */
export class MoltPokerError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(code: string, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'MoltPokerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
