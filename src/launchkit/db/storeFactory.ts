import path from 'node:path';
import { LaunchPackRepository, type LaunchPackStore } from './launchPackRepository.ts';
import { PostgresLaunchPackRepository } from './postgresLaunchPackRepository.ts';
import { getEnv } from '../env.ts';
import { createSecretsStoreFromEnv, type SecretsStoreWithClose } from '../services/secrets.ts';

export type LaunchPackStoreWithClose = LaunchPackStore & { close?: () => Promise<void> };

export async function createLaunchPackStoreFromEnv(): Promise<LaunchPackStoreWithClose> {
  const env = getEnv();
  if (env.DATABASE_URL) {
    const store = await PostgresLaunchPackRepository.create(env.DATABASE_URL);
    return store as LaunchPackStoreWithClose;
  }

  const dataDir = env.PGLITE_DATA_DIR || '.pglite';
  const dbPath = path.join(dataDir, 'launchkit.db');
  const store = await LaunchPackRepository.create(dbPath);
  return store as LaunchPackStoreWithClose;
}

export async function createSecretsStore(): Promise<SecretsStoreWithClose> {
  return createSecretsStoreFromEnv();
}
