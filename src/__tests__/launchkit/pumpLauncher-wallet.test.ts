import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import bs58 from 'bs58';
import { PumpLauncherService } from '../../launchkit/services/pumpLauncher.ts';
import type { SecretsStore } from '../../launchkit/services/secrets.ts';
import type { LaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';

const dummyStore = {} as unknown as LaunchPackStore;
const dummyOptions = { maxDevBuy: 1, maxPriorityFee: 1, maxLaunchesPerDay: 1 };

function memorySecrets(initial?: { apiKey: string; wallet: string; walletSecret: string }): SecretsStore {
  let current = initial ?? null;
  return {
    async get() {
      return current;
    },
    async set(secrets) {
      current = secrets;
    },
  };
}

describe('PumpLauncherService.ensureLauncherWallet', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns cached secrets when all fields are present', async () => {
    const secrets = {
      apiKey: 'api-key',
      wallet: 'wallet-pub',
      walletSecret: bs58.encode(new Uint8Array(64).fill(1)),
    };
    const secretsStore = memorySecrets(secrets);
    const pump = new PumpLauncherService(dummyStore, dummyOptions, secretsStore);
    const fetched = await pump.ensureLauncherWallet();
    expect(fetched).toEqual(secrets);
  });

  it('parses alternative response keys and persists all three fields', async () => {
    const secretsStore = memorySecrets();
    const pump = new PumpLauncherService(dummyStore, dummyOptions, secretsStore);
    const walletSecret = bs58.encode(new Uint8Array(64).fill(3));
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          apiKey: 'k',
          publicKey: 'pub123',
          privateKey: walletSecret,
        }),
        { status: 200 }
      )
    ) as any as typeof fetch;
    global.fetch = fetchMock;

    const record = await pump.ensureLauncherWallet();
    expect(record.apiKey).toBe('k');
    expect(record.wallet).toBe('pub123');
    expect(record.walletSecret).toBe(walletSecret);
  });

  it('throws INVALID_WALLET_RESPONSE when fields are missing', async () => {
    const secretsStore = memorySecrets();
    const pump = new PumpLauncherService(dummyStore, dummyOptions, secretsStore);
    const fetchMock = mock(async () => new Response(JSON.stringify({ apiKey: 'k' }), { status: 200 })) as any as typeof fetch;
    global.fetch = fetchMock;

    await expect(pump.ensureLauncherWallet()).rejects.toMatchObject({ code: 'INVALID_WALLET_RESPONSE' });
  });

  it('throws WALLET_SECRET_INVALID on bad secret length', async () => {
    const secretsStore = memorySecrets();
    const pump = new PumpLauncherService(dummyStore, dummyOptions, secretsStore);
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            apiKey: 'k',
            wallet: 'pub',
            walletSecret: bs58.encode(new Uint8Array(10).fill(2)),
          }),
          { status: 200 }
        )
    ) as any as typeof fetch;
    global.fetch = fetchMock;

    await expect(pump.ensureLauncherWallet()).rejects.toMatchObject({ code: 'WALLET_SECRET_INVALID' });
  });
});
