import { LaunchPackStore } from '../db/launchPackRepository.ts';
import { getEnv } from '../env.ts';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import type { LaunchPack } from '../model/launchPack.ts';

interface PublishOptions {
  force?: boolean;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

async function tgApi(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || !json?.ok) {
    throw errorWithCode('TG_PUBLISH_FAILED', `Telegram ${method} failed`);
  }
  return json.result;
}

export class TelegramPublisherService {
  constructor(private store: LaunchPackStore) {}

  async publish(id: string, options: PublishOptions = {}): Promise<LaunchPack> {
    const env = getEnv();
    if (env.TG_ENABLE !== 'true') {
      throw errorWithCode('TG_DISABLED', 'Telegram publishing disabled');
    }
    const missingKeys: string[] = [];
    if (!env.TG_BOT_TOKEN) missingKeys.push('TG_BOT_TOKEN');
    if (!env.TG_CHAT_ID) missingKeys.push('TG_CHAT_ID');
    if (missingKeys.length) {
      throw errorWithCode('TG_CONFIG_MISSING', 'Telegram configuration missing', { missingKeys });
    }

    const pack = await this.store.get(id);
    if (!pack) throw errorWithCode('NOT_FOUND', 'LaunchPack not found');
    if (!pack.ops?.checklist?.tg_ready) {
      throw errorWithCode('TG_NOT_READY', 'Telegram checklist not ready');
    }
    if (pack.ops?.tg_published_at && pack.ops.tg_publish_status === 'published' && !options.force) {
      return pack;
    }

    const claim = await this.store.claimTelegramPublish(id, {
      requested_at: nowIso(),
      force: options.force,
    });
    if (!claim) {
      throw errorWithCode('TG_PUBLISH_IN_PROGRESS', 'Telegram publish already in progress');
    }

    const pins = claim.tg?.pins ?? {};
    const schedule = claim.tg?.schedule ?? [];
    const messageIds: string[] = [];

    const maybeSendAndPin = async (text: string | undefined) => {
      if (!text) return null;
      const message = await tgApi(env.TG_BOT_TOKEN!, 'sendMessage', {
        chat_id: env.TG_CHAT_ID,
        text,
        disable_web_page_preview: true,
      });
      const messageId = message?.message_id;
      if (messageId === undefined || messageId === null) {
        throw errorWithCode('TG_PUBLISH_FAILED', 'Telegram sendMessage missing message_id');
      }
      await tgApi(env.TG_BOT_TOKEN!, 'pinChatMessage', {
        chat_id: env.TG_CHAT_ID,
        message_id: messageId,
      });
      return messageId as number;
    };

    try {
      const welcomeId = await maybeSendAndPin(pins.welcome);
      if (welcomeId !== null && welcomeId !== undefined) messageIds.push(String(welcomeId));
      const howToBuyId = await maybeSendAndPin(pins.how_to_buy);
      if (howToBuyId !== null && howToBuyId !== undefined) messageIds.push(String(howToBuyId));
      const memekitId = await maybeSendAndPin(pins.memekit);
      if (memekitId !== null && memekitId !== undefined) messageIds.push(String(memekitId));

      const scheduleIntent = schedule.map((item) => ({ ...item, when: new Date(item.when).toISOString() }));

      const updated = await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          checklist: { ...(claim.ops?.checklist || {}), tg_published: true },
          tg_publish_status: 'published',
          tg_published_at: nowIso(),
          tg_message_ids: messageIds,
          tg_schedule_intent: scheduleIntent,
          tg_publish_error_code: null,
          tg_publish_error_message: null,
          audit_log: appendAudit(claim.ops?.audit_log, 'Telegram publish complete', 'eliza'),
        },
      });
      return updated;
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          tg_publish_status: 'failed',
          tg_publish_failed_at: nowIso(),
          tg_publish_error_code: err.code || 'TG_PUBLISH_FAILED',
          tg_publish_error_message: err.message,
        },
      });
      throw err;
    }
  }
}
