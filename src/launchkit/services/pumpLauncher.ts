import { logger } from '@elizaos/core';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import { LaunchPack, LaunchPackUpdateInput } from '../model/launchPack.ts';
import { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { SecretsStore } from './secrets.ts';
import { getEnv } from '../env.ts';
import { redactSensitive } from './redact.ts';

interface PumpLauncherOptions {
  maxDevBuy: number;
  maxPriorityFee: number;
  maxLaunchesPerDay: number;
}

interface WalletRecord {
  apiKey: string;
  wallet: string;
  walletSecret: string;
}

interface CapsResult {
  maxDevBuy: number;
  maxPriorityFee: number;
  maxLaunchesPerDay: number;
  requestedDevBuy: number;
  requestedPriority: number;
}

const MAX_LOGO_BYTES = 8 * 1024 * 1024; // 8MB ceiling for logo downloads
const LOGO_FETCH_TOTAL_TIMEOUT_MS = 20000;
const LOGO_FETCH_CONNECT_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  totalTimeoutMs = LOGO_FETCH_TOTAL_TIMEOUT_MS,
  connectTimeoutMs = LOGO_FETCH_CONNECT_TIMEOUT_MS
) {
  const controller = new AbortController();
  let abortReason: 'connect' | 'total' | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;

  const clearTimers = () => {
    if (connectTimer) clearTimeout(connectTimer);
    if (totalTimer) clearTimeout(totalTimer);
  };

  const onConnectTimeout = () => {
    if (controller.signal.aborted) return;
    abortReason = 'connect';
    controller.abort();
  };

  const onTotalTimeout = () => {
    if (controller.signal.aborted) return;
    abortReason = 'total';
    controller.abort();
  };

  totalTimer = setTimeout(onTotalTimeout, totalTimeoutMs);
  connectTimer = setTimeout(onConnectTimeout, connectTimeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Once headers arrive, connection is established; clear the connect timer.
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    return response;
  } catch (error) {
    if ((error as any)?.name === 'AbortError') {
      if (abortReason === 'connect') {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch connect timeout', {
          timeoutMs: connectTimeoutMs,
        });
      }
      if (abortReason === 'total') {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch total timeout', {
          timeoutMs: totalTimeoutMs,
        });
      }
      throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch aborted');
    }
    throw error;
  } finally {
    clearTimers();
  }
}

async function readStreamWithLimit(res: Response, maxBytes: number) {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
        downloadedBytes: buf.byteLength,
        maxBytes,
      });
    }
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
          downloadedBytes: total,
          maxBytes,
        });
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

export function generateMintKeypair(): { secret: string; publicKey: string } {
  const kp = Keypair.generate();
  if (kp.secretKey.length !== 64) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint secretKey must be 64 bytes');
  }
  const publicBytes = kp.publicKey.toBytes();
  if (publicBytes.length !== 32) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint publicKey must be 32 bytes');
  }

  const secret = bs58.encode(kp.secretKey);
  const publicKey = kp.publicKey.toBase58();

  // sanity: ensure bs58 round-trip lengths are correct
  const secretLen = bs58.decode(secret).length;
  const publicLen = bs58.decode(publicKey).length;
  if (secretLen !== 64 || publicLen !== 32) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint encoding lengths invalid');
  }
  return { secret, publicKey };
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch (err) {
    return null;
  }
}

export class PumpLauncherService {
  constructor(private store: LaunchPackStore, private options: PumpLauncherOptions, private secretsStore: SecretsStore) {}

  async ensureLauncherWallet(): Promise<WalletRecord> {
    const saved = await this.secretsStore.get();
    if (saved?.apiKey && saved?.wallet && saved?.walletSecret) {
      return saved;
    }

    const res = await fetchWithTimeout('https://pumpportal.fun/api/create-wallet');
    if (!res.ok) {
      throw new Error(`Failed to create launcher wallet (${res.status})`);
    }

    const body = await safeJson(res) || {};
    const apiKey = (body as any).apiKey;
    const wallet = (body as any).wallet || (body as any).publicKey || (body as any).address;
    const walletSecret =
      (body as any).privateKey ||
      (body as any).secretKey ||
      (body as any).walletSecret ||
      (body as any).private_key;

    const missingKeys: string[] = [];
    if (!apiKey) missingKeys.push('apiKey');
    if (!wallet) missingKeys.push('wallet');
    if (!walletSecret) missingKeys.push('walletSecret');
    if (missingKeys.length) {
      throw errorWithCode('INVALID_WALLET_RESPONSE', 'Invalid wallet response', { missingKeys });
    }

    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(walletSecret);
    } catch (err) {
      throw errorWithCode('WALLET_SECRET_INVALID', 'Wallet secret is not valid base58');
    }
    if (decoded.length !== 64) {
      throw errorWithCode('WALLET_SECRET_INVALID', 'Wallet secret must decode to 64 bytes', {
        length: decoded.length,
      });
    }

    const record: WalletRecord = { apiKey, wallet, walletSecret };
    await this.secretsStore.set(record);
    return record;
  }

  private ensureLaunchAllowed(pack: LaunchPack, forceRetry?: boolean) {
    const env = getEnv();
    const kill = env.launchEnabled;
    if (!kill) {
      const err = new Error('Launch disabled');
      (err as any).code = 'LAUNCH_DISABLED';
      throw err;
    }

    if (pack.launch?.status === 'launched') {
      const err = new Error('Already launched');
      (err as any).code = 'ALREADY_LAUNCHED';
      throw err;
    }
    if (pack.launch?.requested_at && pack.launch.status !== 'failed') {
      const err = new Error('Launch in progress');
      (err as any).code = 'LAUNCH_IN_PROGRESS';
      throw err;
    }

    if (pack.launch?.status === 'failed' && !forceRetry) {
      const failedAt = pack.launch.failed_at ? new Date(pack.launch.failed_at).getTime() : 0;
      const now = Date.now();
      const diffMs = now - failedAt;
      const cooldownMs = 10 * 60 * 1000;
      if (!failedAt || diffMs < cooldownMs) {
        const err = new Error('Previous launch failed; retry blocked');
        (err as any).code = 'LAUNCH_FAILED_RETRY_BLOCKED';
        throw err;
      }
    }
  }

  private enforceCaps(): CapsResult {
    const env = getEnv();
    const maxDevBuy = this.options.maxDevBuy;
    const maxPriorityFee = this.options.maxPriorityFee;
    const maxLaunchesPerDay = this.options.maxLaunchesPerDay;
    if (isNaN(maxDevBuy) || isNaN(maxPriorityFee) || isNaN(maxLaunchesPerDay)) {
      const err = new Error('Launch caps not configured');
      (err as any).code = 'CAP_EXCEEDED';
      throw err;
    }
    const requestedDevBuy = Number(env.MAX_SOL_DEV_BUY || maxDevBuy);
    const requestedPriority = Number(env.MAX_PRIORITY_FEE || maxPriorityFee);
    if (requestedDevBuy > maxDevBuy || requestedPriority > maxPriorityFee) {
      const err = new Error('Caps exceeded');
      (err as any).code = 'CAP_EXCEEDED';
      (err as any).details = {
        maxDevBuy,
        requestedDevBuy,
        maxPriorityFee,
        requestedPriority,
      };
      throw err;
    }
    // TODO: implement per-day counting using DB; skipped for MVP.
    return { maxDevBuy, maxPriorityFee, maxLaunchesPerDay, requestedDevBuy, requestedPriority };
  }

  private resolveSlippage(): number {
    const env = getEnv();
    const raw = env.LAUNCH_SLIPPAGE_PERCENT ?? 10;
    const capRaw = env.MAX_SLIPPAGE_PERCENT;
    const value = Number(raw);
    const cap = capRaw !== undefined ? Number(capRaw) : undefined;

    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw errorWithCode('SLIPPAGE_INVALID', 'Slippage percent must be between 0 and 100', {
        slippage: raw,
      });
    }

    if (cap !== undefined) {
      if (!Number.isFinite(cap) || cap < 0 || cap > 100) {
        throw errorWithCode('SLIPPAGE_INVALID', 'MAX_SLIPPAGE_PERCENT must be between 0 and 100', {
          cap: capRaw,
        });
      }
      if (value > cap) {
        throw errorWithCode('SLIPPAGE_INVALID', 'Slippage exceeds configured maximum', {
          slippage: value,
          max: cap,
        });
      }
    }

    return Math.floor(value);
  }

  private buildPumpUrl(sig?: string) {
    if (!sig) return undefined;
    return `https://pump.fun/tx/${sig}`;
  }

  async uploadMetadataToPumpIPFS(pack: LaunchPack): Promise<string> {
    if (!pack.assets?.logo_url) {
      throw errorWithCode('LOGO_REQUIRED', 'Token logo is required');
    }

    const form = new FormData();
    form.append('name', pack.brand.name);
    form.append('symbol', pack.brand.ticker);
    form.append('description', pack.brand.description || pack.brand.tagline || '');
    form.append('showName', 'true');
    if (pack.links?.x) form.append('twitter', pack.links.x);
    if (pack.links?.telegram) form.append('telegram', pack.links.telegram);
    if (pack.links?.website) form.append('website', pack.links.website);

    if (pack.assets?.logo_url) {
      const logoUrl = pack.assets.logo_url;
      const response = await fetchWithTimeout(logoUrl, { redirect: 'follow' });
      if (!response.ok) {
        throw errorWithCode('LOGO_FETCH_FAILED', `Failed to fetch logo (${response.status})`, {
          status: response.status,
        });
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength > MAX_LOGO_BYTES) {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
          contentLength,
          maxBytes: MAX_LOGO_BYTES,
        });
      }
      const bodyBytes = await readStreamWithLimit(response, MAX_LOGO_BYTES);
      const urlNoFragment = logoUrl.split('#')[0];
      const urlNoQuery = urlNoFragment.split('?')[0];
      let filename = urlNoQuery.split('/').pop() || '';
      if (!filename || !filename.includes('.')) filename = 'logo.png';
      const mime = response.headers.get('content-type') || 'image/png';
      const blob = new Blob([bodyBytes], { type: mime });
      form.append('file', new File([blob], filename, { type: mime }));
    }

    const res = await fetch('https://pump.fun/api/ipfs', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`IPFS upload failed (${res.status})`);
    const body = await safeJson(res);
    const uri = body?.metadataUri || body?.uri;
    if (!uri) throw new Error('No metadataUri returned');
    return uri as string;
  }

  async createTokenOnPumpPortal(
    pack: LaunchPack,
    metadataUri: string,
    caps: CapsResult,
    wallet: WalletRecord,
    slippagePercent: number
  ): Promise<LaunchPack> {
    const devBuy = caps.requestedDevBuy;
    const priorityFee = caps.requestedPriority;

    const { secret: mintSecret, publicKey: mintPublic } = generateMintKeypair();
    const body = {
      action: 'create',
      tokenMetadata: {
        name: pack.brand.name,
        symbol: pack.brand.ticker,
        uri: metadataUri,
      },
      denominatedInSol: 'true',
      amount: devBuy,
      slippage: slippagePercent,
      priorityFee,
      pool: 'pump',
      mint: mintSecret,
    };

    const res = await fetch(`https://pumpportal.fun/api/trade?api-key=${wallet.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const resJson = await safeJson(res);
    if (!res.ok) {
      const err = new Error(resJson?.error || `Launch failed (${res.status})`);
      (err as any).code = 'LAUNCH_FAILED';
      throw err;
    }

    const sig = resJson?.signature || resJson?.tx || resJson?.txSignature;
    const returnedMint: string | undefined = resJson?.mint;
    if (returnedMint && returnedMint !== mintPublic) {
      throw errorWithCode('MINT_MISMATCH', 'Mint mismatch returned from pump portal', {
        expected: mintPublic,
        received: returnedMint,
      });
    }
    const mint = returnedMint || mintPublic;
    let mintLen = 0;
    try {
      mintLen = bs58.decode(mint).length;
    } catch (err) {
      throw errorWithCode('MINT_MISMATCH', 'Mint base58 decoding failed');
    }
    if (mintLen !== 32) {
      throw errorWithCode('MINT_MISMATCH', 'Mint length invalid', { length: mintLen });
    }
    return {
      ...pack,
      launch: {
        ...(pack.launch || {}),
        status: 'launched',
        tx_signature: sig,
        mint,
        pump_url: this.buildPumpUrl(sig),
        completed_at: nowIso(),
        launched_at: nowIso(),
        requested_at: pack.launch?.requested_at,
        error_code: undefined,
        error_message: undefined,
      },
      ops: {
        ...(pack.ops || {}),
        audit_log: appendAudit(pack.ops?.audit_log, 'Pump launch complete', 'eliza'),
      },
    } as LaunchPack;
  }

  async launch(id: string, options?: { force?: boolean }): Promise<LaunchPack> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error('LaunchPack not found');

    if (existing.launch?.status === 'launched') {
      return existing;
    }

    this.ensureLaunchAllowed(existing, options?.force);
    const caps = this.enforceCaps();
    const slippagePercent = this.resolveSlippage();

    // atomic claim
    const claimed = await this.store.claimLaunch(id, { requested_at: nowIso(), status: 'ready' });
    if (!claimed) {
      const err = new Error('Launch in progress');
      (err as any).code = 'LAUNCH_IN_PROGRESS';
      throw err;
    }
    const withRequested = claimed;

    try {
      const wallet = await this.ensureLauncherWallet();
      const metadataUri = await this.uploadMetadataToPumpIPFS(withRequested);
      const launched = await this.createTokenOnPumpPortal(
        withRequested,
        metadataUri,
        caps,
        wallet,
        slippagePercent
      );
      const saved = await this.store.update(id, {
        launch: launched.launch,
        ops: launched.ops,
      });
      return saved;
    } catch (error) {
      const err = error as Error & { code?: string };
      const failure: LaunchPackUpdateInput = {
        launch: {
          ...(withRequested.launch || {}),
          status: 'failed',
          failed_at: nowIso(),
          error_code: err.code || 'LAUNCH_FAILED',
          error_message: err.message,
        },
        ops: {
          ...(withRequested.ops || {}),
          audit_log: appendAudit(withRequested.ops?.audit_log, `Launch failed: ${err.message}`, 'eliza'),
        },
      };
      const saved = await this.store.update(id, failure);
      logger.error({ error: err.message, details: redactSensitive((err as any).details || {}) }, 'Pump launch failed');
      throw err;
    }
  }
}
