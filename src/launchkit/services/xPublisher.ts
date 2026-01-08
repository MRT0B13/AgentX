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

async function postTweet(env: ReturnType<typeof getEnv>, text: string, replyToId?: string) {
  const body: any = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.X_ACCESS_TOKEN}`,
      'x-api-key': env.X_API_KEY || '',
      'x-api-secret': env.X_API_SECRET || '',
      'x-access-token': env.X_ACCESS_TOKEN || '',
      'x-access-secret': env.X_ACCESS_SECRET || '',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as any));
  const id = json?.data?.id;
  if (!res.ok || !id) {
    throw errorWithCode('X_PUBLISH_FAILED', 'X post failed');
  }
  return String(id);
}

export class XPublisherService {
  constructor(private store: LaunchPackStore) {}

  async publish(id: string, options: PublishOptions = {}): Promise<LaunchPack> {
    const env = getEnv();
    if (env.X_ENABLE !== 'true') {
      throw errorWithCode('X_DISABLED', 'X publishing disabled');
    }
    const missingKeys: string[] = [];
    if (!env.X_API_KEY) missingKeys.push('X_API_KEY');
    if (!env.X_API_SECRET) missingKeys.push('X_API_SECRET');
    if (!env.X_ACCESS_TOKEN) missingKeys.push('X_ACCESS_TOKEN');
    if (!env.X_ACCESS_SECRET) missingKeys.push('X_ACCESS_SECRET');
    if (missingKeys.length) {
      throw errorWithCode('X_CONFIG_MISSING', 'X configuration missing', { missingKeys });
    }

    const pack = await this.store.get(id);
    if (!pack) throw errorWithCode('NOT_FOUND', 'LaunchPack not found');
    if (!pack.ops?.checklist?.x_ready) {
      throw errorWithCode('X_NOT_READY', 'X checklist not ready');
    }
    if (pack.ops?.x_published_at && pack.ops.x_publish_status === 'published' && !options.force) {
      return pack;
    }

    const claim = await this.store.claimXPublish(id, {
      requested_at: nowIso(),
      force: options.force,
    });
    if (!claim) {
      throw errorWithCode('X_PUBLISH_IN_PROGRESS', 'X publish already in progress');
    }

    const tweetIds: string[] = [];
    let previousId: string | undefined;
    const mainText = claim.x?.main_post;
    try {
      if (mainText) {
        const idStr = await postTweet(env, mainText);
        tweetIds.push(idStr);
        previousId = idStr;
      }

      for (const post of claim.x?.thread || []) {
        const idStr = await postTweet(env, post, previousId);
        tweetIds.push(idStr);
        previousId = idStr;
      }

      const scheduleIntent = (claim.x?.schedule || []).map((item) => ({ ...item, when: new Date(item.when).toISOString() }));

      const updated = await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          checklist: { ...(claim.ops?.checklist || {}), x_published: true },
          x_publish_status: 'published',
          x_published_at: nowIso(),
          x_post_ids: tweetIds,
          x_tweet_ids: tweetIds,
          x_schedule_intent: scheduleIntent,
          x_publish_error_code: null,
          x_publish_error_message: null,
          audit_log: appendAudit(claim.ops?.audit_log, 'X publish complete', 'eliza'),
        },
      });
      return updated;
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.store.update(id, {
        ops: {
          ...(claim.ops || {}),
          x_publish_status: 'failed',
          x_publish_failed_at: nowIso(),
          x_publish_error_code: err.code || 'X_PUBLISH_FAILED',
          x_publish_error_message: err.message,
        },
      });
      throw err;
    }
  }
}
