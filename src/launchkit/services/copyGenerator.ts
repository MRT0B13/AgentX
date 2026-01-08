import { IAgentRuntime, logger } from '@elizaos/core';
import { appendAudit } from './audit.ts';
import { addHoursIso, nextRoundedBaseDate } from './time.ts';
import { LaunchPack, LaunchPackUpdateInput } from '../model/launchPack.ts';
import { LaunchPackStore } from '../db/launchPackRepository.ts';

export interface GenerateOptions {
  theme?: string;
  keywords?: string[];
  tone?: string;
}

function fallbackText(prefix: string, theme?: string, keywords?: string[], tone?: string) {
  const parts = [prefix];
  if (theme) parts.push(`theme: ${theme}`);
  if (keywords?.length) parts.push(`keywords: ${keywords.join(', ')}`);
  if (tone) parts.push(`tone: ${tone}`);
  return parts.join(' | ');
}

async function generate(runtime: IAgentRuntime | undefined, prompt: string) {
  if (!runtime?.useModel) {
    return prompt;
  }
  try {
    const res = await runtime.useModel(
      {
        modelClass: 'text-generation',
        prompt,
      } as any,
      undefined as any
    );
    if (typeof res === 'string') return res;
    if (res && typeof (res as any).text === 'string') return (res as any).text;
    return prompt;
  } catch (err) {
    logger.warn({ err }, 'generate fallback to prompt');
    return prompt;
  }
}

function buildSchedule(base: string, count: number, stepHours: number, textPrefix: string) {
  const items = [] as { when: string; text: string }[];
  const start = nextRoundedBaseDate();
  for (let i = 0; i < count; i++) {
    const when = addHoursIso(stepHours * i, start);
    items.push({ when, text: `${textPrefix} #${i + 1} ${base}` });
  }
  return items;
}

export class CopyGeneratorService {
  constructor(private store: LaunchPackStore, private runtime?: IAgentRuntime) {}

  async generateForLaunchPack(
    id: string,
    opts: GenerateOptions = {}
  ): Promise<LaunchPack> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error('LaunchPack not found');

    const { theme, keywords = [], tone } = opts;
    const basePrompt = `Generate meme token launch comms. Brand: ${existing.brand.name} (${existing.brand.ticker}). Theme: ${theme || 'memes'}. Keywords: ${keywords.join(', ')}`;

    const welcomeRaw = await generate(this.runtime, `${basePrompt}\nWelcome pin copy. Tone: ${tone || 'fun, crisp'}`);
    const howToBuyRaw = await generate(this.runtime, `${basePrompt}\nHow to buy instructions (short). Tone: ${tone || 'direct'}`);
    const memekitRaw = await generate(this.runtime, `${basePrompt}\nMemekit pin. Tone: ${tone || 'playful'}`);

    const welcome = (welcomeRaw || '').trim() || fallbackText('Welcome to the launch', theme, keywords, tone);
    const howToBuy = (howToBuyRaw || '').trim() || fallbackText('How to buy: step-by-step', theme, keywords, tone);
    const memekit = (memekitRaw || '').trim() || fallbackText('Memekit instructions', theme, keywords, tone);

    const mainPost = await generate(this.runtime, `${basePrompt}\nMain announcement tweet. Tone: ${tone || 'hype'}`);
    const thread = [] as string[];
    for (let i = 0; i < 5; i++) {
      thread.push(await generate(this.runtime, `${basePrompt}\nThread part ${i + 1}/5. Tone: ${tone || 'story'}`));
    }

    const replyBank = [] as string[];
    for (let i = 0; i < 10; i++) {
      replyBank.push(await generate(this.runtime, `${basePrompt}\nShort reply ${i + 1}/10. Tone: ${tone || 'witty one-liner'}`));
    }

    const tgSchedule = buildSchedule(fallbackText('TG post', theme, keywords, tone), 6, 4, 'TG');
    const xSchedule = buildSchedule(fallbackText('X post', theme, keywords, tone), 4, 6, 'X');

    const pinsComplete = Boolean(welcome && howToBuy && memekit);

    const patch: LaunchPackUpdateInput = {
      tg: {
        pins: { welcome, how_to_buy: howToBuy, memekit },
        schedule: tgSchedule,
      },
      x: {
        main_post: mainPost,
        thread,
        reply_bank: replyBank,
        schedule: xSchedule,
      },
      ops: {
        checklist: {
          ...(existing.ops?.checklist || {}),
          copy_ready: true,
          tg_ready: pinsComplete,
          x_ready: Boolean(mainPost),
        },
        audit_log: appendAudit(existing.ops?.audit_log, 'Generated launch copy', 'eliza'),
      },
    };

    if (!pinsComplete) {
      throw new Error('Pin generation incomplete');
    }

    const updated = await this.store.update(id, patch);
    return updated;
  }
}
