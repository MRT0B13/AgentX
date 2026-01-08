import { logger, type IAgentRuntime } from '@elizaos/core';
import { CopyGeneratorService } from './services/copyGenerator.ts';
import { PumpLauncherService } from './services/pumpLauncher.ts';
import { startLaunchKitServer } from './api/server.ts';
import {
  createLaunchPackStoreFromEnv,
  createSecretsStore,
  type LaunchPackStoreWithClose,
} from './db/storeFactory.ts';
import { getEnv } from './env.ts';
import type { LaunchPackStore } from './db/launchPackRepository.ts';
import { TelegramPublisherService } from './services/telegramPublisher.ts';
import { XPublisherService } from './services/xPublisher.ts';

export async function initLaunchKit(
  runtime: IAgentRuntime,
  options: { store?: LaunchPackStoreWithClose } = {}
): Promise<{
  store: LaunchPackStore;
  copyService: CopyGeneratorService;
  pumpService: PumpLauncherService;
  telegramPublisher: TelegramPublisherService;
  xPublisher: XPublisherService;
  server?: { baseUrl: string; close: () => Promise<void> };
  close?: () => Promise<void>;
}> {
  const env = getEnv();
  const storeWithClose = options.store ?? (await createLaunchPackStoreFromEnv());
  const store: LaunchPackStore = storeWithClose;
  const closeStore = storeWithClose.close;
  const secretsStore = await createSecretsStore();

  const copyService = new CopyGeneratorService(store, runtime);
  const pumpService = new PumpLauncherService(store, {
    maxDevBuy: env.MAX_SOL_DEV_BUY,
    maxPriorityFee: env.MAX_PRIORITY_FEE,
    maxLaunchesPerDay: env.MAX_LAUNCHES_PER_DAY,
  }, secretsStore);
  const telegramPublisher = new TelegramPublisherService(store);
  const xPublisher = new XPublisherService(store);

  if (!env.launchkitEnabled) {
    const close = async () => {
      if (secretsStore.close) await secretsStore.close();
      if (closeStore) await closeStore();
    };
    return { store, copyService, pumpService, telegramPublisher, xPublisher, close };
  }

  const adminToken = env.LAUNCHKIT_ADMIN_TOKEN || env.ADMIN_TOKEN;
  if (!adminToken) {
    if (closeStore) await closeStore();
    const err = new Error('LAUNCHKIT_ADMIN_TOKEN is required when LAUNCHKIT_ENABLE=true');
    (err as any).code = 'LAUNCHKIT_ADMIN_TOKEN_REQUIRED';
    throw err;
  }

  const port = env.LAUNCHKIT_PORT ?? 8787;
  let serverHandle: Awaited<ReturnType<typeof startLaunchKitServer>>;
  try {
    serverHandle = await startLaunchKitServer({
      port,
      adminToken,
      store,
      runtime,
      copyService,
      pumpService,
    });
  } catch (err) {
    if (closeStore) await closeStore();
    throw err;
  }

  logger.info({ baseUrl: serverHandle.baseUrl, port: serverHandle.port }, 'LaunchKit server started');

  const close = async () => {
    try {
      await serverHandle.close();
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error closing LaunchKit server');
    } finally {
      if (secretsStore.close) await secretsStore.close();
      if (closeStore) await closeStore();
    }
  };

  return {
    store,
    copyService,
    pumpService,
    telegramPublisher,
    xPublisher,
    server: { baseUrl: serverHandle.baseUrl, close },
    close,
  };
}
