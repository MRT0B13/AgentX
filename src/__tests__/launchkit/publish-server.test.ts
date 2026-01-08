import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { startLaunchKitServer } from '../../launchkit/api/server.ts';
import { createInMemoryLaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';
import { CopyGeneratorService } from '../../launchkit/services/copyGenerator.ts';
import type { IAgentRuntime } from '@elizaos/core';

const adminToken = 'test-admin-token';
const envSnapshot = { ...process.env } as Record<string, string>;

function createRuntime(): IAgentRuntime {
  return {
    useModel: mock(async () => 'ok'),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

describe('LaunchKit publish endpoints', () => {
  const store = createInMemoryLaunchPackStore();
  const runtime = createRuntime();
  const copyService = new CopyGeneratorService(store, runtime);
  let server: Awaited<ReturnType<typeof startLaunchKitServer>>;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = global.fetch;
    server = await startLaunchKitServer({ port: 0, adminToken, store, runtime, copyService });
  });

  afterAll(async () => {
    await server.close();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it('returns TG_DISABLED when telegram is disabled', async () => {
    process.env.TG_ENABLE = 'false';
    const pack = await store.create({
      brand: { name: 'TG Disabled', ticker: 'TGD', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'hi' }, schedule: [] },
      ops: { checklist: { tg_ready: true } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('TG_DISABLED');
  });

  it('exposes health without auth', async () => {
    const res = await fetch(`${server.baseUrl}/health`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns TG_CONFIG_MISSING with missingKeys', async () => {
    process.env.TG_ENABLE = 'true';
    const pack = await store.create({
      brand: { name: 'TG Config', ticker: 'TGC', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'hi' }, schedule: [] },
      ops: { checklist: { tg_ready: true } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('TG_CONFIG_MISSING');
    expect(body.error.details?.missingKeys).toContain('TG_BOT_TOKEN');
  });

  it('returns TG_NOT_READY when checklist not ready', async () => {
    process.env.TG_ENABLE = 'true';
    process.env.TG_BOT_TOKEN = 'token';
    process.env.TG_CHAT_ID = 'chat';
    const pack = await store.create({
      brand: { name: 'TG Not Ready', ticker: 'TGNR', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'hi' }, schedule: [] },
      ops: { checklist: { tg_ready: false } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('TG_NOT_READY');
  });

  it('publishes to telegram once and is idempotent', async () => {
    process.env.TG_ENABLE = 'true';
    process.env.TG_BOT_TOKEN = 'token';
    process.env.TG_CHAT_ID = 'chat123';

    const pack = await store.create({
      brand: { name: 'TG Publish', ticker: 'TGP', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: {
        pins: { welcome: 'Welcome!', how_to_buy: 'Buy here', memekit: 'Memes!' },
        schedule: [{ when: new Date().toISOString(), text: 'Schedule me' }],
      },
      ops: { checklist: { tg_ready: true } },
    } as any);

    let sendCalls = 0;
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return (await originalFetch(input as any, init)) as any;
      }
      if (url.includes('https://api.telegram.org')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (url.includes('/sendMessage')) {
          sendCalls += 1;
          expect(body.chat_id).toBe('chat123');
          expect(body.text).toBeTruthy();
          return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + sendCalls } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/pinChatMessage')) {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('not found', { status: 404 });
    }) as any;

    const res1 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.ops.tg_message_ids.length).toBeGreaterThanOrEqual(3);
    expect(body1.data.ops.tg_schedule_intent.length).toBe(1);
    expect(sendCalls).toBe(3);

    const res2 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ops.tg_message_ids).toEqual(body1.data.ops.tg_message_ids);
    expect(sendCalls).toBe(3);
  });

  it('handles concurrent telegram publishes with one in progress rejection', async () => {
    process.env.TG_ENABLE = 'true';
    process.env.TG_BOT_TOKEN = 'token';
    process.env.TG_CHAT_ID = 'chat123';

    const pack = await store.create({
      brand: { name: 'TG Concurrency', ticker: 'TGCN', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'Hi' }, schedule: [] },
      ops: { checklist: { tg_ready: true } },
    } as any);

    let sendCalls = 0;
    let releaseSend: (() => void) | null = null;
    const firstSendBlock = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) return (await originalFetch(input as any, init)) as any;
      if (url.includes('sendMessage')) {
        sendCalls += 1;
        if (sendCalls === 1) {
          await firstSendBlock;
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + sendCalls } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('pinChatMessage')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as any;

    setTimeout(() => releaseSend?.(), 50);
    const [r1, r2] = await Promise.all([
      fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
        method: 'POST',
        headers: { 'X-ADMIN-TOKEN': adminToken },
      }),
      fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
        method: 'POST',
        headers: { 'X-ADMIN-TOKEN': adminToken },
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(sendCalls).toBe(1);
  });

  it('persists telegram failure and blocks until force or cooldown', async () => {
    process.env.TG_ENABLE = 'true';
    process.env.TG_BOT_TOKEN = 'token';
    process.env.TG_CHAT_ID = 'chat123';

    const pack = await store.create({
      brand: { name: 'TG Fail', ticker: 'TGF', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'Hi' }, schedule: [] },
      ops: { checklist: { tg_ready: true } },
    } as any);

    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) return (await originalFetch(input as any, init)) as any;
      if (url.includes('sendMessage')) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('pinChatMessage')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as any;

    const res1 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error.code).toBe('TG_PUBLISH_FAILED');

    const persisted = await store.get(pack.id);
    expect(persisted?.ops?.tg_publish_status).toBe('failed');
    expect(persisted?.ops?.tg_publish_error_code).toBe('TG_PUBLISH_FAILED');

    const res2 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/telegram`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res2.status).toBe(409);
  });

  it('returns X_DISABLED when x is disabled', async () => {
    process.env.X_ENABLE = 'false';
    const pack = await store.create({
      brand: { name: 'X Disabled', ticker: 'XOFF', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: { main_post: 'hello' },
      ops: { checklist: { x_ready: true } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('X_DISABLED');
  });

  it('returns X_CONFIG_MISSING with missingKeys', async () => {
    process.env.X_ENABLE = 'true';
    const pack = await store.create({
      brand: { name: 'X Config', ticker: 'XCFG', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: { main_post: 'hello' },
      ops: { checklist: { x_ready: true } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('X_CONFIG_MISSING');
    expect(body.error.details?.missingKeys).toContain('X_API_KEY');
  });

  it('returns X_NOT_READY when checklist not ready', async () => {
    process.env.X_ENABLE = 'true';
    process.env.X_API_KEY = 'key';
    process.env.X_API_SECRET = 'secret';
    process.env.X_ACCESS_TOKEN = 'token';
    process.env.X_ACCESS_SECRET = 'access';
    const pack = await store.create({
      brand: { name: 'X Not Ready', ticker: 'XNR', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: { main_post: 'hello' },
      ops: { checklist: { x_ready: false } },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('X_NOT_READY');
  });

  it('publishes to x once, in order, and is idempotent', async () => {
    process.env.X_ENABLE = 'true';
    process.env.X_API_KEY = 'key';
    process.env.X_API_SECRET = 'secret';
    process.env.X_ACCESS_TOKEN = 'token';
    process.env.X_ACCESS_SECRET = 'access';

    const pack = await store.create({
      brand: { name: 'X Publish', ticker: 'XPD', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: { main_post: 'MAIN', thread: ['T1', 'T2'], schedule: [{ when: new Date().toISOString(), text: 'later' }] },
      ops: { checklist: { x_ready: true } },
    } as any);

    const requests: any[] = [];
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return (await originalFetch(input as any, init)) as any;
      }
      if (url.includes('https://api.twitter.com/2/tweets')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        requests.push({ url, body });
        return new Response(JSON.stringify({ data: { id: `${requests.length}` } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as any;

    const res1 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.ops.x_post_ids.length).toBe(3);
    expect(body1.data.ops.x_schedule_intent.length).toBe(1);
    expect(requests.length).toBe(3);
    expect(requests[1].body.reply.in_reply_to_tweet_id).toBe('1');
    expect(requests[2].body.reply.in_reply_to_tweet_id).toBe('2');

    const res2 = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ops.x_post_ids).toEqual(body1.data.ops.x_post_ids);
    expect(requests.length).toBe(3);
  });

  it('handles concurrent x publishes with one in progress rejection', async () => {
    process.env.X_ENABLE = 'true';
    process.env.X_API_KEY = 'key';
    process.env.X_API_SECRET = 'secret';
    process.env.X_ACCESS_TOKEN = 'token';
    process.env.X_ACCESS_SECRET = 'access';

    const pack = await store.create({
      brand: { name: 'X Concurrency', ticker: 'XCN', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: { main_post: 'MAIN' },
      ops: { checklist: { x_ready: true } },
    } as any);

    let tweetCalls = 0;
    let releaseTweet: (() => void) | null = null;
    const firstTweetBlock = new Promise<void>((resolve) => {
      releaseTweet = resolve;
    });
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) return (await originalFetch(input as any, init)) as any;
      if (url.includes('https://api.twitter.com/2/tweets')) {
        tweetCalls += 1;
        if (tweetCalls === 1) {
          await firstTweetBlock;
        }
        return new Response(JSON.stringify({ data: { id: `${tweetCalls}` } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as any;

    setTimeout(() => releaseTweet?.(), 50);
    const [r1, r2] = await Promise.all([
      fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
        method: 'POST',
        headers: { 'X-ADMIN-TOKEN': adminToken },
      }),
      fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/publish/x`, {
        method: 'POST',
        headers: { 'X-ADMIN-TOKEN': adminToken },
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(tweetCalls).toBe(1);
  });

  it('returns markdown export with pins and main post', async () => {
    const pack = await store.create({
      brand: { name: 'Export Me', ticker: 'EXP', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: { pins: { welcome: 'Hello TG' }, schedule: [] },
      x: { main_post: 'Hello X', thread: [], schedule: [] },
      ops: { checklist: {} },
    } as any);

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${pack.id}/export`, {
      method: 'GET',
      headers: { 'X-ADMIN-TOKEN': adminToken, Accept: 'text/markdown' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Export Me (EXP)');
    expect(text).toContain('Welcome');
    expect(text).toContain('Hello TG');
    expect(text).toContain('Hello X');
  });
});
