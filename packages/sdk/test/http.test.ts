import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MoltPokerClient, MoltPokerError } from '../src/http.js'

// ─── fetch stub harness ──────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn>
let fetchMock: FetchMock

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function respondOk(body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response)
}

function respondError(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response)
}

// ─── Smoke tests (R-SDK.a) ───────────────────────────────────────────────────

describe('MoltPokerClient — module exports', () => {
  it('exports MoltPokerClient and MoltPokerError', () => {
    expect(typeof MoltPokerClient).toBe('function')
    expect(typeof MoltPokerError).toBe('function')
  })
})

describe('MoltPokerClient.register', () => {
  it('POSTs /v1/agents with name and metadata, stores returned api_key', async () => {
    respondOk({
      agent_id: 'agt_1',
      api_key: 'sk_live_abc',
      protocol_version: '0.1',
      skill_doc_url: 'http://localhost:9000/skill.md',
    })

    const client = new MoltPokerClient({ baseUrl: 'http://localhost:9000' })
    const res = await client.register({
      name: 'TestAgent',
      metadata: { molt_simulation: true, molt_model: 'openai:gpt-4o-mini' },
    })

    expect(res.api_key).toBe('sk_live_abc')
    expect(client.getApiKey()).toBe('sk_live_abc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('http://localhost:9000/v1/agents')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.name).toBe('TestAgent')
    expect(body.metadata).toEqual({
      molt_simulation: true,
      molt_model: 'openai:gpt-4o-mini',
    })
  })

  it('forwards server error with code and message', async () => {
    respondError(400, { error: { code: 'VALIDATION_ERROR', message: 'bad name' } })

    const client = new MoltPokerClient({ baseUrl: 'http://localhost:9000' })
    await expect(client.register({ name: '' })).rejects.toMatchObject({
      name: 'MoltPokerError',
      code: 'VALIDATION_ERROR',
      message: 'bad name',
      statusCode: 400,
    })
  })
})

describe('MoltPokerClient.autoJoin', () => {
  it('POSTs /v1/tables/auto-join with bearer token and bucket_key', async () => {
    respondOk({
      table_id: 'tbl_1',
      seat_id: 0,
      session_token: 'sess_abc',
      ws_url: 'ws://localhost:9000/v1/ws',
    })

    const client = new MoltPokerClient({ baseUrl: 'http://localhost:9000', apiKey: 'sk_test' })
    await client.autoJoin({ bucketKey: 'default' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('http://localhost:9000/v1/tables/auto-join')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk_test')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.bucket_key).toBe('default')
  })
})
