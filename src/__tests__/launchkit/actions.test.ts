import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { generateLaunchPackCopyAction } from '../../launchkit/eliza/generateAction.ts';
import { launchLaunchPackAction, publishTelegramAction, publishXAction } from '../../launchkit/eliza/publishActions.ts';
import { createInMemoryLaunchPackStore, LaunchPackRepository } from '../../launchkit/db/launchPackRepository.ts';
import { CopyGeneratorService } from '../../launchkit/services/copyGenerator.ts';
import { TelegramPublisherService } from '../../launchkit/services/telegramPublisher.ts';
import { XPublisherService } from '../../launchkit/services/xPublisher.ts';

function createRuntime(kit: any): IAgentRuntime {
  return {
    getService: mock().mockReturnValue(kit),
    useModel: mock(async ({ prompt }) => (typeof prompt === 'string' ? `LLM:${prompt.slice(0, 8)}` : 'LLM')),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

const envSnapshot = { ...process.env } as Record<string, string>;
const fetchSnapshot = global.fetch;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  global.fetch = fetchSnapshot;
});

describe('generateLaunchPackCopyAction validate', () => {
  it('passes when UUID is only in text', async () => {
    const runtime = createRuntime({});
    const message = {
      content: { text: 'please generate copy for 00000000-0000-4000-8000-000000000000' },
    } as any;

    const valid = await generateLaunchPackCopyAction.validate(runtime, message, {} as any);
    expect(valid).toBe(true);
  });
});

describe('launchLaunchPackAction handler', () => {
  it('uses pumpService.launch with force flag and returns payload', async () => {
    const packId = '00000000-0000-4000-8000-000000000001';
    const pumpService = {
      launch: mock(async (id: string, options?: { force?: boolean }) => {
        expect(id).toBe(packId);
        expect(options).toEqual({ force: true });
        return {
          id,
          brand: { name: 'Test', ticker: 'TST', tagline: 'tag', description: 'desc' },
          links: {},
          assets: {},
          launch: { status: 'launched', tx_signature: 'sig123', pump_url: 'https://pump.fun/tx/sig123', mint: 'mint123' },
          ops: { checklist: { launch_ready: true } },
        } as any;
      }),
    };

    const kit = { getLaunchKit: () => ({ pumpService }) };
    const runtime = createRuntime(kit);
    const callback = mock(async () => {});

    const message = {
      content: {
        text: `please launch ${packId}`,
        data: { force: true },
      },
    } as any;

    const result = await launchLaunchPackAction.handler(runtime, message, {} as any, {} as any, callback);

    expect(result.success).toBe(true);
    expect(result.data?.txSignature).toBe('sig123');
    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0][0];
    expect(payload.data.launch.pumpUrl).toContain('pump.fun');
  });
});

describe('publish actions handlers', () => {
  it('publishes to telegram when ready and enabled', async () => {
    process.env.TG_ENABLE = 'true';
    process.env.TG_BOT_TOKEN = 'token';
    process.env.TG_CHAT_ID = 'chat';

    const store = createInMemoryLaunchPackStore();
    const pack = await store.create({
      brand: { name: 'Test', ticker: 'TST', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      tg: {
        pins: { welcome: 'hi', how_to_buy: 'buy', memekit: 'meme' },
        schedule: [{ when: new Date().toISOString(), text: 'hello' }],
      },
      ops: { checklist: { tg_ready: true } },
    } as any);

    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        expect(body.chat_id).toBe('chat');
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
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

    const kit = { getLaunchKit: () => ({ telegramPublisher: new TelegramPublisherService(store) }) };
    const runtime = createRuntime(kit);
    const callback = mock(async () => {});

    const message = { content: { text: `publish tg ${pack.id}` } } as any;
    const result = await publishTelegramAction.handler(runtime, message, {} as any, {} as any, callback);

    expect(result.success).toBe(true);
    expect(result.data?.tgMessageIds?.length).toBeGreaterThan(0);
    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0][0];
    expect(payload.data.tg?.messageIds?.length).toBeGreaterThan(0);
  });

  it('publishes to x when ready and enabled', async () => {
    process.env.X_ENABLE = 'true';
    process.env.X_API_KEY = 'key';
    process.env.X_API_SECRET = 'secret';
    process.env.X_ACCESS_TOKEN = 'token';
    process.env.X_ACCESS_SECRET = 'access';

    const store = createInMemoryLaunchPackStore();
    const pack = await store.create({
      brand: { name: 'Test', ticker: 'TXT', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      x: {
        main_post: 'main',
        thread: ['post1', 'post2'],
        schedule: [{ when: new Date().toISOString(), text: 'scheduled' }],
      },
      ops: { checklist: { x_ready: true } },
    } as any);

    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('https://api.twitter.com/2/tweets')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        expect(body.text).toBeTruthy();
        return new Response(JSON.stringify({ data: { id: '1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as any;

    const kit = { getLaunchKit: () => ({ xPublisher: new XPublisherService(store) }) };
    const runtime = createRuntime(kit);
    const callback = mock(async () => {});

    const message = { content: { text: `publish x ${pack.id}` } } as any;
    const result = await publishXAction.handler(runtime, message, {} as any, {} as any, callback);

    expect(result.success).toBe(true);
    expect(result.data?.xPostIds?.length).toBeGreaterThan(0);
    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0][0];
    expect(payload.data.x?.postIds?.length).toBeGreaterThan(0);
  });
});

describe('generateLaunchPackCopyAction handler', () => {
  it('uses bootstrap copyService and returns summary payload', async () => {
    const store = createInMemoryLaunchPackStore();
    const pack = await store.create({
      brand: { name: 'Test', ticker: 'TST', tagline: 'tag', description: 'desc' },
      links: {},
      assets: { logo_url: 'https://example.com/logo.png' },
      launch: { status: 'draft' },
    } as any);

    const copyService = new CopyGeneratorService(store, createRuntime({}));
    const kit = {
      getLaunchKit: () => ({ store, copyService, pumpService: undefined }),
    };

    const runtime = createRuntime(kit);
    const callback = mock(async () => {});

    const message = {
      content: {
        text: `generate for ${pack.id}`,
        data: { theme: 'cats', keywords: ['meme'], tone: 'fun' },
      },
    } as any;

    // Guard to ensure repository factory is not called
    const repoSpy = mock(() => {
      throw new Error('LaunchPackRepository.create should not be called');
    });
    (LaunchPackRepository as any).create = repoSpy;

    const result = await generateLaunchPackCopyAction.handler(runtime, message, {} as any, {} as any, callback);

    expect(result.success).toBe(true);
    expect(result.data?.launchPackId).toBe(pack.id);
    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0][0];
    expect(payload.data?.tg?.pinsFilled).toBeDefined();
    expect(payload.data?.x?.threadCount).toBeGreaterThanOrEqual(0);
    expect(repoSpy).not.toHaveBeenCalled();
  });

  it('throws coded error when no UUID is present', async () => {
    const kit = { getLaunchKit: () => ({ copyService: new CopyGeneratorService(createInMemoryLaunchPackStore(), createRuntime({})) }) };
    const runtime = createRuntime(kit);
    const message = { content: { text: 'no id here', data: {} } } as any;

    await expect(
      generateLaunchPackCopyAction.handler(runtime, message, {} as any, {} as any, async () => {})
    ).rejects.toMatchObject({ code: 'MISSING_LAUNCHPACK_ID' });
  });
});
