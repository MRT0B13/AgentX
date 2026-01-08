import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { createSecretsStoreFromEnv } from '../../launchkit/services/secrets.ts';
import { getEnv } from '../../launchkit/env.ts';

const secret64 = bs58.encode(new Uint8Array(64).fill(5));

function snapshotEnv(keys: string[]) {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('SecretsStore persistence', () => {
  const trackedKeys = [
    'PUMP_PORTAL_API_KEY',
    'PUMP_PORTAL_WALLET_ADDRESS',
    'PUMP_PORTAL_WALLET_SECRET',
    'DATABASE_URL',
    'PGLITE_PATH',
  ];
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    envSnapshot = snapshotEnv(trackedKeys);
  });

  afterEach(async () => {
    restoreEnv(envSnapshot);
  });

  it('returns env-based secrets when all three fields are present', async () => {
    process.env.PUMP_PORTAL_API_KEY = 'k';
    process.env.PUMP_PORTAL_WALLET_ADDRESS = 'wallet';
    process.env.PUMP_PORTAL_WALLET_SECRET = secret64;
    delete process.env.DATABASE_URL;

    const store = await createSecretsStoreFromEnv();
    const secrets = await store.get();
    expect(secrets).toEqual({ apiKey: 'k', wallet: 'wallet', walletSecret: secret64 });
    if (store.close) await store.close();
  });

  it('persists wallet_secret with pglite store', async () => {
    delete process.env.PUMP_PORTAL_API_KEY;
    delete process.env.PUMP_PORTAL_WALLET_ADDRESS;
    delete process.env.PUMP_PORTAL_WALLET_SECRET;
    delete process.env.DATABASE_URL;

    const tempDir = path.join(process.cwd(), `.pglite-test-${Date.now()}`);
    process.env.PGLITE_PATH = path.join(tempDir, 'db');

    const store = await createSecretsStoreFromEnv();
    await store.set({ apiKey: 'k', wallet: 'wallet', walletSecret: secret64 });
    const loaded = await store.get();
    expect(loaded).toEqual({ apiKey: 'k', wallet: 'wallet', walletSecret: secret64 });
    if (store.close) await store.close();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires wallet secret when launch and local withdraw are enabled', () => {
    expect(() =>
      getEnv({ LAUNCH_ENABLE: 'true', LOCAL_WITHDRAW_ENABLE: 'true', PUMP_PORTAL_WALLET_SECRET: undefined as any })
    ).toThrowError(/PUMP_PORTAL_WALLET_SECRET is required/);
  });
});
