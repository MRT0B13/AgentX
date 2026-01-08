import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let singletonDb: PGlite | null = null;

function resolveDataDir(rawPath?: string) {
  const target = rawPath?.trim()?.length ? rawPath : process.env.PGLITE_PATH || '.pglite/launchkit';
  const resolved = path.resolve(target);
  const dir = path.extname(resolved) ? path.dirname(resolved) : resolved;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function getPglite(dbPath?: string): Promise<PGlite> {
  if (singletonDb) return singletonDb;

  // Reuse the plugin-sql PGlite instance if it already exists to avoid double initialization
  const globalSingletons = (globalThis as any)[Symbol.for('@elizaos/plugin-sql/global-singletons')];
  const sharedClient = globalSingletons?.pgLiteClientManager?.getConnection?.();
  if (sharedClient) {
    singletonDb = sharedClient as PGlite;
    await singletonDb.waitReady;
    return singletonDb;
  }

  const dataDir = resolveDataDir(dbPath);
  singletonDb = new PGlite({ dataDir });
  await singletonDb.waitReady;
  return singletonDb;
}
