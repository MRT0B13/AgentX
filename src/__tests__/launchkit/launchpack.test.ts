import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLaunchKitServer } from '../../launchkit/api/server.ts';
import {
  LaunchPackValidation,
  LaunchPackCreateInput,
} from '../../launchkit/model/launchPack.ts';
import {
  LaunchPackRepository,
  createInMemoryLaunchPackStore,
} from '../../launchkit/db/launchPackRepository.ts';

const baseInput: LaunchPackCreateInput = {
  brand: {
    name: 'Meme King',
    ticker: 'KING',
    tagline: 'Rule the memes',
    description: 'A token for meme royalty',
    lore: 'Forged in the depths of the internet',
  },
  links: {
    telegram: 'https://t.me/memeking',
    x: 'https://x.com/memeking',
    website: 'https://memeking.io',
  },
  assets: {
    logo_url: 'https://example.com/logo.png',
    banner_url: 'https://example.com/banner.png',
    memes: [{ url: 'https://example.com/meme1.png', caption: 'All hail the king' }],
  },
  tg: {
    chat_id: '12345',
    pins: {
      welcome: 'Welcome to Meme King',
      how_to_buy: 'Buy on pump.fun',
      memekit: 'Share memes daily',
    },
    schedule: [{ when: '2024-01-01T00:00:00Z', text: 'Launch party' }],
  },
  x: {
    main_post: 'Meme King has arrived',
    thread: ['Chapter 1', 'Chapter 2'],
    reply_bank: ['gm', 'wen moon'],
    schedule: [{ when: '2024-01-01T01:00:00Z', text: 'First post' }],
  },
  launch: {
    status: 'draft',
  },
  ops: {
    checklist: { copy_complete: true },
    audit_log: [{ message: 'Drafted', at: '2024-01-01T00:00:00Z' }],
  },
};

describe('LaunchPack schema', () => {
  it('rejects missing brand name', () => {
    const invalid = { ...baseInput, brand: { ...baseInput.brand, name: '' } };
    expect(() => LaunchPackValidation.create(invalid)).toThrow();
  });

  it('parses a valid launch pack', () => {
    const parsed = LaunchPackValidation.create(baseInput);
    expect(parsed.brand.name).toBe('Meme King');
    expect(parsed.assets?.memes?.length).toBe(1);
  });
});

describe('LaunchPackRepository (pglite)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchkit-'));
  let repo: LaunchPackRepository;

  beforeAll(async () => {
    repo = await LaunchPackRepository.create(path.join(tmp, 'db'));
  });

  it('creates and retrieves a launch pack', async () => {
    const created = await repo.create(baseInput);
    expect(created.id).toBeTruthy();

    const fetched = await repo.get(created.id);
    expect(fetched?.brand.name).toBe('Meme King');
  });

  it('updates a launch pack checklist', async () => {
    const created = await repo.create({ ...baseInput, brand: { ...baseInput.brand, ticker: 'KING2' } });
    const updated = await repo.update(created.id, { ops: { checklist: { copy_complete: false, qa: true } } });
    expect(updated.ops?.checklist?.qa).toBe(true);
    const fetched = await repo.get(created.id);
    expect(fetched?.ops?.checklist?.qa).toBe(true);
  });

  it('only lets the first claimLaunch win', async () => {
    const created = await repo.create({ ...baseInput, brand: { ...baseInput.brand, ticker: 'KING2A' } });
    const first = await repo.claimLaunch(created.id, {
      requested_at: new Date().toISOString(),
      status: 'ready',
    });
    const second = await repo.claimLaunch(created.id, {
      requested_at: new Date().toISOString(),
      status: 'ready',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const fetched = await repo.get(created.id);
    expect(fetched?.launch?.requested_at).toBeDefined();
  });
});

describe('LaunchKit HTTP server', () => {
  const adminToken = 'test-admin-token';
  const store = createInMemoryLaunchPackStore();
  let server: Awaited<ReturnType<typeof startLaunchKitServer>>;

  beforeAll(async () => {
    server = await startLaunchKitServer({ port: 0, adminToken, store });
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns health without auth', async () => {
    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects requests without admin token', async () => {
    const res = await fetch(`${server.baseUrl}/v1/launchpacks`);
    expect(res.status).toBe(401);
  });

  it('creates and fetches a launch pack', async () => {
    const createRes = await fetch(`${server.baseUrl}/v1/launchpacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ ...baseInput, brand: { ...baseInput.brand, ticker: 'KING3' } }),
    });

    expect(createRes.status).toBe(201);
    const body = await createRes.json();
    const id = body.data.id as string;
    const getRes = await fetch(`${server.baseUrl}/v1/launchpacks/${id}`, {
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.data.brand.ticker).toBe('KING3');
  });

  it('patches a launch pack', async () => {
    const createRes = await fetch(`${server.baseUrl}/v1/launchpacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ ...baseInput, brand: { ...baseInput.brand, ticker: 'KING4' } }),
    });
    const body = await createRes.json();
    const id = body.data.id as string;

    const patchRes = await fetch(`${server.baseUrl}/v1/launchpacks/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ x: { main_post: 'Updated' } }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.data.x.main_post).toBe('Updated');
  });

  it('rejects invalid schedule times on PATCH', async () => {
    const createRes = await fetch(`${server.baseUrl}/v1/launchpacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ ...baseInput, brand: { ...baseInput.brand, ticker: 'KING5' } }),
    });
    const body = await createRes.json();
    const id = body.data.id as string;

    const patchRes = await fetch(`${server.baseUrl}/v1/launchpacks/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ tg: { schedule: [{ when: 'tomorrow 3pm', text: 'bad' }] } }),
    });

    expect(patchRes.status).toBe(400);
    const payload = await patchRes.json();
    expect(payload.error?.code).toBe('INVALID_INPUT');
  });

  it('returns method not allowed for generate GET', async () => {
    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${crypto.randomUUID()}/generate`, {
      method: 'GET',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(405);
  });

  it('returns not found for unknown route', async () => {
    const res = await fetch(`${server.baseUrl}/v1/does-not-exist`, {
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(404);
  });

  it('serves export payload and validates id', async () => {
    const createRes = await fetch(`${server.baseUrl}/v1/launchpacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ ...baseInput, brand: { ...baseInput.brand, ticker: 'EXP1' } }),
    });
    const body = await createRes.json();
    const id = body.data.id as string;

    const exportRes = await fetch(`${server.baseUrl}/v1/launchpacks/${id}/export`, {
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json();
    expect(exportBody.data?.pump?.symbol).toBe('EXP1');

    const badExport = await fetch(`${server.baseUrl}/v1/launchpacks/not-a-uuid/export`, {
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(badExport.status).toBe(400);
  });
});
