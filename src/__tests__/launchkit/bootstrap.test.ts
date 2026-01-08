import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { initLaunchKit } from '../../launchkit/init.ts';
import { createInMemoryLaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';
import type { LaunchPackStoreWithClose } from '../../launchkit/db/storeFactory.ts';

function createRuntime(): IAgentRuntime {
  return {
    useModel: mock(async () => 'ok'),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

const envSnapshot = { ...process.env } as Record<string, string>;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
});

describe('initLaunchKit bootstrap', () => {
  it('returns without server when disabled', async () => {
    process.env.LAUNCHKIT_ENABLE = 'false';
    process.env.DATABASE_URL = '';

    const store = createInMemoryLaunchPackStore() as LaunchPackStoreWithClose;
    const closeMock = mock(async () => {});
    store.close = closeMock;

    const runtime = createRuntime();
    const result = await initLaunchKit(runtime, { store });

    expect(result.server).toBeUndefined();
    expect(typeof result.close).toBe('function');

    await result.close?.();
    expect(closeMock).toHaveBeenCalled();
  });

  it('throws coded error when enabled without admin token', async () => {
    process.env.LAUNCHKIT_ENABLE = 'true';
    delete process.env.LAUNCHKIT_ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;

    const store = createInMemoryLaunchPackStore() as LaunchPackStoreWithClose;
    const closeMock = mock(async () => {});
    store.close = closeMock;

    const runtime = createRuntime();

    await expect(initLaunchKit(runtime, { store })).rejects.toMatchObject({
      code: 'LAUNCHKIT_ADMIN_TOKEN_REQUIRED',
    });
    expect(closeMock).toHaveBeenCalled();
  });

  it('starts server when enabled and closes store on shutdown', async () => {
    process.env.LAUNCHKIT_ENABLE = 'true';
    process.env.LAUNCHKIT_ADMIN_TOKEN = 'test-admin';
    process.env.LAUNCHKIT_PORT = '0';
    process.env.DATABASE_URL = '';

    const store = createInMemoryLaunchPackStore() as LaunchPackStoreWithClose;
    const closeMock = mock(async () => {});
    store.close = closeMock;

    const runtime = createRuntime();
    const result = await initLaunchKit(runtime, { store });

    expect(result.server?.baseUrl).toBeTruthy();
    await result.close?.();
    expect(closeMock).toHaveBeenCalled();
  });
});
