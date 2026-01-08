import { describe, it, expect } from 'bun:test';
import { Pool } from 'pg';
import { PostgresLaunchPackRepository } from '../../launchkit/db/postgresLaunchPackRepository.ts';
import { LaunchPackCreateInput } from '../../launchkit/model/launchPack.ts';

const TEST_URL = process.env.POSTGRES_TEST_URL;

function buildPool(url: string) {
  const sslNeeded = url.includes('sslmode=require') || process.env.PGSSLMODE === 'require';
  const cfg: any = { connectionString: url };
  if (sslNeeded) cfg.ssl = { rejectUnauthorized: false };
  return new Pool(cfg);
}

describe('PostgresLaunchPackRepository', () => {
  if (!TEST_URL) {
    it.skip('skips because POSTGRES_TEST_URL is not set', () => {});
    return;
  }

  const pool = buildPool(TEST_URL);

  const baseInput: LaunchPackCreateInput = {
    brand: {
      name: 'Test Token',
      ticker: 'TST',
      tagline: 'Tag',
      description: 'Desc',
      lore: 'Lore',
    },
    assets: {
      logo_url: 'https://example.com/logo.png',
    },
    launch: {
      status: 'draft',
    },
  };

  it('create/get roundtrip', async () => {
    const repo = await PostgresLaunchPackRepository.create(TEST_URL!);
    await pool.query('TRUNCATE launch_packs');
    const created = await repo.create(baseInput);
    const fetched = await repo.get(created.id);
    expect(fetched?.brand.name).toBe('Test Token');
    expect(fetched?.id).toBe(created.id);
  });

  it('update deep merge preserves fields and bumps version', async () => {
    const repo = await PostgresLaunchPackRepository.create(TEST_URL!);
    await pool.query('TRUNCATE launch_packs');
    const created = await repo.create(baseInput);
    const updated = await repo.update(created.id, { brand: { tagline: 'NewTag' } });
    expect(updated.brand.name).toBe('Test Token');
    expect(updated.brand.tagline).toBe('NewTag');
    expect(updated.version).toBe((created.version ?? 1) + 1);
  });

  it('claimLaunch allows only one winner', async () => {
    const repo = await PostgresLaunchPackRepository.create(TEST_URL!);
    await pool.query('TRUNCATE launch_packs');
    const created = await repo.create(baseInput);
    const when = new Date().toISOString();
    const [a, b] = await Promise.all([
      repo.claimLaunch(created.id, { requested_at: when, status: 'ready' }),
      repo.claimLaunch(created.id, { requested_at: when, status: 'ready' }),
    ]);
    const winners = [a, b].filter(Boolean).length;
    expect(winners).toBe(1);
  });

  it.afterAll(async () => {
    await pool.end();
  });
});
