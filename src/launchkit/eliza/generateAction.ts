import { randomUUID } from 'node:crypto';
import { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { z } from 'zod';
import { CopyGeneratorService } from '../services/copyGenerator.ts';

const dataSchema = z.object({
  launchPackId: z.string().uuid().optional(),
  theme: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  tone: z.string().optional(),
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

function getCopyService(runtime: IAgentRuntime): CopyGeneratorService {
  const bootstrap = runtime.getService('launchkit_bootstrap') as any;
  const kit = bootstrap?.getLaunchKit?.();
  const copyService = kit?.copyService;
  if (!copyService) {
    const err = new Error('LaunchKit not initialized');
    (err as any).code = 'LAUNCHKIT_NOT_INITIALIZED';
    throw err;
  }
  return copyService as CopyGeneratorService;
}

export const generateLaunchPackCopyAction: Action = {
  name: 'GENERATE_LAUNCHPACK_COPY',
  similes: ['GENERATE_COPY', 'WRITE_LAUNCH_COPY'],
  description: 'Generate TG pins, schedules, and X posts for a LaunchPack',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const text = String(message.content?.text ?? '').toLowerCase();
    const hasIntent = /generate|copy|pins|thread|schedule|post/.test(text);
    try {
      dataSchema.parse(message.content?.data ?? {});
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
    const parsedData = dataSchema.parse(message.content?.data ?? {});
    let launchPackId = extractLaunchPackId(message);
    if (!launchPackId) {
      launchPackId = await createLaunchPack(runtime, message);
      await callback({
        text: `Created LaunchPack ${launchPackId}. Generating copy now...`,
        data: { launchPackId },
        actions: ['GENERATE_LAUNCHPACK_COPY'],
        source: message.content?.source,
      });
    }

    const copyService = getCopyService(runtime);

    const updated = await copyService.generateForLaunchPack(launchPackId, {
      theme: parsedData.theme,
      keywords: parsedData.keywords,
      tone: parsedData.tone,
    });

    const pins = updated.tg?.pins ?? {};
    const tgScheduleCount = updated.tg?.schedule?.length ?? 0;
    const xThreadCount = updated.x?.thread?.length ?? 0;
    const xReplyCount = updated.x?.reply_bank?.length ?? 0;
    const xScheduleCount = updated.x?.schedule?.length ?? 0;

    await callback({
      text: `LaunchPack copy generated for ${updated.id}`,
      data: {
        launchPackId: updated.id,
        tg: {
          pinsFilled: {
            welcome: Boolean(pins.welcome),
            how_to_buy: Boolean(pins.how_to_buy),
            memekit: Boolean(pins.memekit),
          },
          scheduleCount: tgScheduleCount,
        },
        x: {
          threadCount: xThreadCount,
          replyBankCount: xReplyCount,
          scheduleCount: xScheduleCount,
        },
        checklist: updated.ops?.checklist,
      },
      actions: ['GENERATE_LAUNCHPACK_COPY'],
      source: message.content?.source,
    });

    return {
      text: 'LaunchPack copy generated',
      success: true,
      data: { launchPackId: updated.id },
    };
  },
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'generate launchpack copy for 00000000-0000-4000-8000-000000000000',
          data: {},
        },
      },
      {
        name: 'eliza',
        content: {
          text: 'LaunchPack copy generated',
          actions: ['GENERATE_LAUNCHPACK_COPY'],
        },
      },
    ],
  ],
};
