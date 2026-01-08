import { randomUUID } from 'node:crypto';
import { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { z } from 'zod';
import { PumpLauncherService } from '../services/pumpLauncher.ts';
import { TelegramPublisherService } from '../services/telegramPublisher.ts';
import { XPublisherService } from '../services/xPublisher.ts';

const launchDataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  force: z.boolean().optional(),
});

const publishDataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  force: z.boolean().optional(),
});

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/;

function extractLaunchPackId(message: Memory): string | undefined {
  const data = (message.content?.data ?? {}) as any;
  if (typeof data.launchPackId === 'string' && UUID_RE.test(data.launchPackId)) return data.launchPackId;

  const text = String(message.content?.text ?? '');
  const match = text.match(UUID_RE);
  return match?.[0];
}

function deriveNameAndTicker(text: string): { name: string; ticker: string } {
  const words = text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const name = (words.slice(0, 3).join(' ') || 'Auto Launch').trim();
  const base = (words.find((w) => w.length >= 3) || 'AUTO').toUpperCase();
  const ticker = (base + randomUUID().replace(/-/g, '')).slice(0, 4).toUpperCase();
  return { name, ticker };
}

async function createLaunchPack(runtime: IAgentRuntime, message: Memory) {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  const store = kit?.store;
  if (!store) {
    const err = new Error('LaunchKit store unavailable');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  const text = String(message.content?.text ?? '');
  const { name, ticker } = deriveNameAndTicker(text);
  const created = await store.create({
    brand: { name, ticker, description: text.slice(0, 140) },
    ops: { checklist: {}, audit_log: [] },
  });
  return created.id as string;
}

function requireLaunchKit(runtime: IAgentRuntime): any {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  if (!kit) {
    const err = new Error('LaunchKit not initialized');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  return kit;
}

function requireService<T>(svc: T | undefined, code: string, message: string): T {
  if (!svc) {
    const err = new Error(message);
    (err as any).code = code;
    throw err;
  }
  return svc;
}

export const launchLaunchPackAction: Action = {
  name: 'LAUNCH_LAUNCHPACK',
  similes: ['LAUNCH', 'LAUNCH_TOKEN'],
  description: 'Launch a token for a LaunchPack using pump.fun',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /launch|token|pump/.test(text);
    try {
      launchDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = launchDataSchema.parse(message.content?.data ?? {});
    let launchPackId = extractLaunchPackId(message);
    if (!launchPackId) {
      launchPackId = await createLaunchPack(runtime, message);
      await callback({
        text: `Created LaunchPack ${launchPackId}. Launching now...`,
        data: { launchPackId },
        actions: ['LAUNCH_LAUNCHPACK'],
        source: message.content?.source,
      });
    }

    const kit = requireLaunchKit(runtime);
    const pumpService = requireService<PumpLauncherService>(kit.pumpService, 'PUMP_SERVICE_UNAVAILABLE', 'Pump service unavailable');

    const updated = await pumpService.launch(launchPackId, { force: Boolean(parsed.force) });
    await callback({
      text: `Launch ${updated.launch?.status ?? 'updated'} for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        launch: {
          status: updated.launch?.status,
          txSignature: updated.launch?.tx_signature,
          pumpUrl: updated.launch?.pump_url,
          mint: updated.launch?.mint,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['LAUNCH_LAUNCHPACK'],
      source: message.content?.source,
    });

    return {
      text: 'Launch executed',
      success: true,
      data: {
        launchPackId: updated.id,
        status: updated.launch?.status,
        txSignature: updated.launch?.tx_signature,
        pumpUrl: updated.launch?.pump_url,
        mint: updated.launch?.mint,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'launch 00000000-0000-4000-8000-000000000000',
          data: { force: false },
        },
      },
      {
        name: 'eliza',
        content: {
          text: 'Launch executed',
          actions: ['LAUNCH_LAUNCHPACK'],
        },
      },
    ],
  ],
};

export const publishTelegramAction: Action = {
  name: 'PUBLISH_TELEGRAM',
  similes: ['PUBLISH_TG', 'TELEGRAM_PUBLISH'],
  description: 'Publish LaunchPack copy to Telegram',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /telegram|tg|publish/.test(text);
    try {
      publishDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = publishDataSchema.parse(message.content?.data ?? {});
    let launchPackId = extractLaunchPackId(message) || parsed.launchPackId;
    if (!launchPackId) {
      launchPackId = await createLaunchPack(runtime, message);
      await callback({
        text: `Created LaunchPack ${launchPackId}. Publishing to Telegram now...`,
        data: { launchPackId },
        actions: ['PUBLISH_TELEGRAM'],
        source: message.content?.source,
      });
    }

    const kit = requireLaunchKit(runtime);
    const telegramPublisher = requireService<TelegramPublisherService>(
      kit.telegramPublisher,
      'TELEGRAM_SERVICE_UNAVAILABLE',
      'Telegram publisher unavailable'
    );

    const updated = await telegramPublisher.publish(launchPackId, { force: Boolean(parsed.force) });
    await callback({
      text: `Telegram publish recorded for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        tg: {
          publishedAt: updated.ops?.tg_published_at,
          messageIds: updated.ops?.tg_message_ids,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['PUBLISH_TELEGRAM'],
      source: message.content?.source,
    });

    return {
      text: 'Telegram publish recorded',
      success: true,
      data: {
        launchPackId: updated.id,
        tgPublishedAt: updated.ops?.tg_published_at,
        tgMessageIds: updated.ops?.tg_message_ids,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'publish telegram for 00000000-0000-4000-8000-000000000000' },
      },
      {
        name: 'eliza',
        content: { text: 'Telegram publish recorded', actions: ['PUBLISH_TELEGRAM'] },
      },
    ],
  ],
};

export const publishXAction: Action = {
  name: 'PUBLISH_X',
  similes: ['PUBLISH_TWITTER', 'POST_X'],
  description: 'Publish LaunchPack copy to X',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /publish|post|twitter|x /.test(text);
    try {
      publishDataSchema.parse(message.content?.data ?? {});
    } catch {
      // ignore; intent + UUID drives validation
    }
    return Boolean(extractLaunchPackId(message)) || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const parsed = publishDataSchema.parse(message.content?.data ?? {});
    let launchPackId = extractLaunchPackId(message) || parsed.launchPackId;
    if (!launchPackId) {
      launchPackId = await createLaunchPack(runtime, message);
      await callback({
        text: `Created LaunchPack ${launchPackId}. Publishing to X now...`,
        data: { launchPackId },
        actions: ['PUBLISH_X'],
        source: message.content?.source,
      });
    }

    const kit = requireLaunchKit(runtime);
    const xPublisher = requireService<XPublisherService>(kit.xPublisher, 'X_SERVICE_UNAVAILABLE', 'X publisher unavailable');

    const updated = await xPublisher.publish(launchPackId, { force: Boolean(parsed.force) });
    await callback({
      text: `X publish recorded for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        x: {
          publishedAt: updated.ops?.x_published_at,
          postIds: updated.ops?.x_post_ids,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['PUBLISH_X'],
      source: message.content?.source,
    });

    return {
      text: 'X publish recorded',
      success: true,
      data: {
        launchPackId: updated.id,
        xPublishedAt: updated.ops?.x_published_at,
        xPostIds: updated.ops?.x_post_ids,
      },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'post launchpack to x 00000000-0000-4000-8000-000000000000' },
      },
      {
        name: 'eliza',
        content: { text: 'X publish recorded', actions: ['PUBLISH_X'] },
      },
    ],
  ],
};
