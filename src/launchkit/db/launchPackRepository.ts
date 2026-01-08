import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  LaunchPack,
  LaunchPackCreateInput,
  LaunchPackUpdateInput,
  LaunchPackValidation,
} from '../model/launchPack.ts';
import { getPglite } from './pglite.ts';

const PUBLISH_COOLDOWN_MS = 10 * 60 * 1000;

export interface LaunchPackStore {
  create(input: LaunchPackCreateInput): Promise<LaunchPack>;
  get(id: string): Promise<LaunchPack | null>;
  update(id: string, patch: LaunchPackUpdateInput): Promise<LaunchPack>;
  claimLaunch(
    id: string,
    fields: { requested_at: string; status: string }
  ): Promise<LaunchPack | null>;
  claimTelegramPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null>;
  claimXPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null>;
  findDueTelegramPublishes(nowIso: string, limit: number): Promise<LaunchPack[]>;
  findDueXPublishes(nowIso: string, limit: number): Promise<LaunchPack[]>;
}

async function ensureSchema(db: PGlite) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS launch_packs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      data JSONB NOT NULL,
      launch_status TEXT DEFAULT 'draft',
      launch_requested_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'launch_packs' AND column_name = 'launch_status'
      ) THEN
        ALTER TABLE launch_packs ADD COLUMN launch_status TEXT DEFAULT 'draft';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'launch_packs' AND column_name = 'launch_requested_at'
      ) THEN
        ALTER TABLE launch_packs ADD COLUMN launch_requested_at TIMESTAMPTZ;
      END IF;
    END$$;
  `);
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function deepMerge(base: any, patch: any) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object') return patch;
  if (typeof base !== 'object' || base === null) return patch;

  const merged: Record<string, any> = { ...base };
  for (const key of Object.keys(patch)) {
    merged[key] = deepMerge(base[key], (patch as Record<string, any>)[key]);
  }
  return merged;
}

function publishStatus(pack: LaunchPack, key: 'tg' | 'x') {
  const ops = pack.ops || {};
  const statusKey = key === 'tg' ? 'tg_publish_status' : 'x_publish_status';
  const failedAtKey = key === 'tg' ? 'tg_publish_failed_at' : 'x_publish_failed_at';
  const status = (ops as any)[statusKey] as string | undefined;
  const failedAt = (ops as any)[failedAtKey] as string | undefined;
  return { status: status || 'idle', failedAt: failedAt ? new Date(failedAt) : undefined };
}

export class LaunchPackRepository implements LaunchPackStore {
  private constructor(private db: PGlite) {}

  static async create(dbPath?: string) {
    const db = await getPglite(dbPath);
    await ensureSchema(db);
    return new LaunchPackRepository(db);
  }

  async create(input: LaunchPackCreateInput): Promise<LaunchPack> {
    const parsed = LaunchPackValidation.create(input);
    const id = parsed.id ?? randomUUID();
    const idempotencyKey = parsed.idempotency_key;
    const timestamp = new Date().toISOString();
    const launchStatus = parsed.launch?.status ?? 'draft';
    const launchRequestedAt = parsed.launch?.requested_at ? new Date(parsed.launch.requested_at) : null;

    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT id, data, created_at, updated_at FROM launch_packs WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rows?.length) {
        const row = existing.rows[0] as any;
        const stored = (row.data || {}) as LaunchPack;
        return {
          ...stored,
          id: row.id || stored.id,
          created_at: toIso(row.created_at) || stored.created_at,
          updated_at: toIso(row.updated_at) || stored.updated_at,
        } as LaunchPack;
      }
    }

    const record: LaunchPack = {
      ...parsed,
      id,
      idempotency_key: idempotencyKey,
      version: parsed.version ?? 1,
      created_at: timestamp,
      updated_at: timestamp,
    } as LaunchPack;

    await this.db.query(
      `INSERT INTO launch_packs (id, idempotency_key, data, created_at, updated_at, launch_status, launch_requested_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             idempotency_key = COALESCE(launch_packs.idempotency_key, EXCLUDED.idempotency_key),
             launch_status = EXCLUDED.launch_status,
             launch_requested_at = EXCLUDED.launch_requested_at,
             updated_at = EXCLUDED.updated_at`,
      [id, idempotencyKey ?? null, record, record.created_at, record.updated_at, launchStatus, launchRequestedAt]
    );

    return record;
  }

  async get(id: string): Promise<LaunchPack | null> {
    const result = await this.db.query(
      `SELECT id, data, created_at, updated_at FROM launch_packs WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!result.rows?.length) return null;
    const row = result.rows[0] as any;
    const stored = (row.data || {}) as LaunchPack;
    return {
      ...stored,
      id: row.id || stored.id || id,
      created_at: toIso(row.created_at) || stored.created_at,
      updated_at: toIso(row.updated_at) || stored.updated_at,
    } as LaunchPack;
  }

  async update(id: string, patch: LaunchPackUpdateInput): Promise<LaunchPack> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error('LaunchPack not found');
    }

    const parsedPatch = LaunchPackValidation.update(patch);
    const merged = deepMerge(existing, parsedPatch) as LaunchPack;
    const timestamp = new Date().toISOString();
    merged.id = id;
    merged.updated_at = timestamp;
    const currentVersion = existing.version ?? 1;
    merged.version = currentVersion + 1;
    const launchStatus = merged.launch?.status ?? 'draft';
    const launchRequestedAt = merged.launch?.requested_at ? new Date(merged.launch.requested_at) : null;

    await this.db.query(
      `UPDATE launch_packs
         SET data = $2::jsonb,
             launch_status = $3,
             launch_requested_at = $4,
             updated_at = $5
       WHERE id = $1`,
      [id, merged, launchStatus, launchRequestedAt, merged.updated_at]
    );

    return merged;
  }

  async claimLaunch(
    id: string,
    fields: { requested_at: string; status: string }
  ): Promise<LaunchPack | null> {
    const result = await this.db.query(
      `UPDATE launch_packs
       SET launch_status = $3,
           launch_requested_at = $2::timestamptz,
           data = jsonb_set(
                   jsonb_set(data, '{launch,requested_at}', to_jsonb($2::text), true),
                   '{launch,status}', to_jsonb($3::text), true
                 ),
           updated_at = NOW()
       WHERE id = $1
         AND launch_status <> 'launched'
         AND (launch_requested_at IS NULL OR launch_status = 'failed')
       RETURNING id, data, created_at, updated_at, launch_status, launch_requested_at`,
      [id, fields.requested_at, fields.status]
    );

    if (!result.rows?.length) return null;
    const row = result.rows[0] as any;
    const stored = (row.data || {}) as LaunchPack;
    return {
      ...stored,
      id: row.id || stored.id || id,
      created_at: toIso(row.created_at) || stored.created_at,
      updated_at: toIso(row.updated_at) || stored.updated_at,
    } as LaunchPack;
  }

  async claimTelegramPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null> {
    const force = Boolean(fields.force);
    const result = await this.db.query(
      `UPDATE launch_packs
         SET data = jsonb_set(
                        jsonb_set(
                          jsonb_set(data, '{ops,tg_publish_status}', to_jsonb('in_progress'), true),
                          '{ops,tg_publish_attempted_at}', to_jsonb($2::text), true
                        ),
                        '{ops,tg_publish_error_code}', 'null'::jsonb, true
                      ),
             updated_at = NOW()
       WHERE id = $1
         AND COALESCE(data->'ops'->>'tg_publish_status', 'idle') <> 'published'
         AND COALESCE(data->'ops'->>'tg_publish_status', 'idle') <> 'in_progress'
         AND (
              COALESCE(data->'ops'->>'tg_publish_status', 'idle') = 'idle'
              OR (
                   COALESCE(data->'ops'->>'tg_publish_status', 'idle') = 'failed'
                   AND (
                        $3 = TRUE
                        OR COALESCE((data->'ops'->>'tg_publish_failed_at')::timestamptz, TO_TIMESTAMP(0)) <= NOW() - INTERVAL '10 minutes'
                      )
                 )
             )
       RETURNING id, data, created_at, updated_at` ,
      [id, fields.requested_at, force]
    );

    if (!result.rows?.length) return null;
    const row = result.rows[0] as any;
    const stored = (row.data || {}) as LaunchPack;
    return {
      ...stored,
      id: row.id || stored.id || id,
      created_at: toIso(row.created_at) || stored.created_at,
      updated_at: toIso(row.updated_at) || stored.updated_at,
    } as LaunchPack;
  }

  async claimXPublish(
    id: string,
    fields: { requested_at: string; force?: boolean }
  ): Promise<LaunchPack | null> {
    const force = Boolean(fields.force);
    const result = await this.db.query(
      `UPDATE launch_packs
         SET data = jsonb_set(
                        jsonb_set(
                          jsonb_set(data, '{ops,x_publish_status}', to_jsonb('in_progress'), true),
                          '{ops,x_publish_attempted_at}', to_jsonb($2::text), true
                        ),
                        '{ops,x_publish_error_code}', 'null'::jsonb, true
                      ),
             updated_at = NOW()
       WHERE id = $1
         AND COALESCE(data->'ops'->>'x_publish_status', 'idle') <> 'published'
         AND COALESCE(data->'ops'->>'x_publish_status', 'idle') <> 'in_progress'
         AND (
              COALESCE(data->'ops'->>'x_publish_status', 'idle') = 'idle'
              OR (
                   COALESCE(data->'ops'->>'x_publish_status', 'idle') = 'failed'
                   AND (
                        $3 = TRUE
                        OR COALESCE((data->'ops'->>'x_publish_failed_at')::timestamptz, TO_TIMESTAMP(0)) <= NOW() - INTERVAL '10 minutes'
                      )
                 )
             )
       RETURNING id, data, created_at, updated_at` ,
      [id, fields.requested_at, force]
    );

    if (!result.rows?.length) return null;
    const row = result.rows[0] as any;
    const stored = (row.data || {}) as LaunchPack;
    return {
      ...stored,
      id: row.id || stored.id || id,
      created_at: toIso(row.created_at) || stored.created_at,
      updated_at: toIso(row.updated_at) || stored.updated_at,
    } as LaunchPack;
  }

  async findDueTelegramPublishes(nowIso: string, limit: number): Promise<LaunchPack[]> {
    const result = await this.db.query(
      `SELECT id, data, created_at, updated_at
         FROM launch_packs
        WHERE COALESCE(data->'ops'->>'tg_publish_status', 'idle') NOT IN ('in_progress', 'published')
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'ops'->'tg_schedule_intent', data->'tg'->'schedule', '[]'::jsonb)) AS s
            WHERE (s->>'when')::timestamptz <= $1::timestamptz
          )
        ORDER BY updated_at ASC
        LIMIT $2`,
      [nowIso, limit]
    );

    return (result.rows || []).map((row: any) => {
      const stored = (row.data || {}) as LaunchPack;
      return {
        ...stored,
        id: row.id || stored.id,
        created_at: toIso(row.created_at) || stored.created_at,
        updated_at: toIso(row.updated_at) || stored.updated_at,
      } as LaunchPack;
    });
  }

  async findDueXPublishes(nowIso: string, limit: number): Promise<LaunchPack[]> {
    const result = await this.db.query(
      `SELECT id, data, created_at, updated_at
         FROM launch_packs
        WHERE COALESCE(data->'ops'->>'x_publish_status', 'idle') NOT IN ('in_progress', 'published')
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'ops'->'x_schedule_intent', data->'x'->'schedule', '[]'::jsonb)) AS s
            WHERE (s->>'when')::timestamptz <= $1::timestamptz
          )
        ORDER BY updated_at ASC
        LIMIT $2`,
      [nowIso, limit]
    );

    return (result.rows || []).map((row: any) => {
      const stored = (row.data || {}) as LaunchPack;
      return {
        ...stored,
        id: row.id || stored.id,
        created_at: toIso(row.created_at) || stored.created_at,
        updated_at: toIso(row.updated_at) || stored.updated_at,
      } as LaunchPack;
    });
  }
}

export function createInMemoryLaunchPackStore(): LaunchPackStore {
  const store = new Map<string, LaunchPack>();

  return {
    async create(input) {
      const parsed = LaunchPackValidation.create(input);
      const id = parsed.id ?? randomUUID();
      const now = new Date().toISOString();

      if (parsed.idempotency_key) {
        for (const value of store.values()) {
          if (value.idempotency_key === parsed.idempotency_key) {
            return value;
          }
        }
      }

      const record = {
        ...parsed,
        id,
        version: parsed.version ?? 1,
        created_at: now,
        updated_at: now,
      } as LaunchPack;
      store.set(id, record);
      return record;
    },
    async get(id) {
      return store.get(id) || null;
    },
    async update(id, patch) {
      const existing = store.get(id);
      if (!existing) throw new Error('LaunchPack not found');
      const merged = deepMerge(existing, LaunchPackValidation.update(patch)) as LaunchPack;
      merged.id = id;
      merged.updated_at = new Date().toISOString();
      const currentVersion = existing.version ?? 1;
      merged.version = currentVersion + 1;
      store.set(id, merged);
      return merged;
    },
    async claimLaunch(id, fields) {
      const existing = store.get(id);
      if (!existing) return null;
      if (existing.launch?.status === 'launched') return null;
      if (existing.launch?.requested_at && existing.launch.status !== 'failed') return null;
      const updated: LaunchPack = {
        ...existing,
        launch: {
          ...(existing.launch || {}),
          requested_at: fields.requested_at,
          status: fields.status,
        },
        updated_at: new Date().toISOString(),
      } as LaunchPack;
      const currentVersion = existing.version ?? 1;
      updated.version = currentVersion + 1;
      store.set(id, updated);
      return updated;
    },
    async claimTelegramPublish(id, fields) {
      const existing = store.get(id);
      if (!existing) return null;
      const { status, failedAt } = publishStatus(existing, 'tg');
      if (status === 'published' || status === 'in_progress') return null;
      if (status === 'failed' && !fields.force) {
        const now = Date.now();
        const failedMs = failedAt ? failedAt.getTime() : 0;
        if (failedMs && now - failedMs < PUBLISH_COOLDOWN_MS) return null;
      }
      const updated: LaunchPack = {
        ...existing,
        ops: {
          ...(existing.ops || {}),
          tg_publish_status: 'in_progress',
          tg_publish_attempted_at: fields.requested_at,
          tg_publish_error_code: undefined,
          tg_publish_error_message: undefined,
        },
        updated_at: new Date().toISOString(),
      } as LaunchPack;
      updated.version = (existing.version ?? 1) + 1;
      store.set(id, updated);
      return updated;
    },
    async claimXPublish(id, fields) {
      const existing = store.get(id);
      if (!existing) return null;
      const { status, failedAt } = publishStatus(existing, 'x');
      if (status === 'published' || status === 'in_progress') return null;
      if (status === 'failed' && !fields.force) {
        const now = Date.now();
        const failedMs = failedAt ? failedAt.getTime() : 0;
        if (failedMs && now - failedMs < PUBLISH_COOLDOWN_MS) return null;
      }
      const updated: LaunchPack = {
        ...existing,
        ops: {
          ...(existing.ops || {}),
          x_publish_status: 'in_progress',
          x_publish_attempted_at: fields.requested_at,
          x_publish_error_code: undefined,
          x_publish_error_message: undefined,
        },
        updated_at: new Date().toISOString(),
      } as LaunchPack;
      updated.version = (existing.version ?? 1) + 1;
      store.set(id, updated);
      return updated;
    },
    async findDueTelegramPublishes(nowIso, limit) {
      const nowTs = new Date(nowIso).getTime();
      const results: LaunchPack[] = [];
      for (const pack of store.values()) {
        if (results.length >= limit) break;
        const status = pack.ops?.tg_publish_status || 'idle';
        if (status === 'published' || status === 'in_progress') continue;
        const schedule = pack.tg?.schedule || pack.ops?.tg_schedule_intent || [];
        const due = schedule.some((item: any) => new Date(item.when).getTime() <= nowTs);
        if (!due) continue;
        results.push(pack);
      }
      return results;
    },
    async findDueXPublishes(nowIso, limit) {
      const nowTs = new Date(nowIso).getTime();
      const results: LaunchPack[] = [];
      for (const pack of store.values()) {
        if (results.length >= limit) break;
        const status = pack.ops?.x_publish_status || 'idle';
        if (status === 'published' || status === 'in_progress') continue;
        const schedule = pack.x?.schedule || pack.ops?.x_schedule_intent || [];
        const due = schedule.some((item: any) => new Date(item.when).getTime() <= nowTs);
        if (!due) continue;
        results.push(pack);
      }
      return results;
    },
  };
}
