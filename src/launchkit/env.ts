import { z } from 'zod';

const numberOrUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((val) => {
    if (val === '' || val === undefined || val === null) return undefined;
    return val;
  }, schema);

const EnvSchema = z.object({
  LAUNCH_ENABLE: z.enum(['true', 'false']).default('false'),
  LAUNCHKIT_ENABLE: z.enum(['true', 'false']).default('false'),
  LAUNCHKIT_PORT: z.coerce.number().default(8787),
  LAUNCHKIT_ADMIN_TOKEN: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  LOCAL_WITHDRAW_ENABLE: z.enum(['true', 'false']).default('false'),
  MAX_SOL_DEV_BUY: z.coerce.number().default(0),
  MAX_PRIORITY_FEE: z.coerce.number().default(0),
  MAX_LAUNCHES_PER_DAY: z.coerce.number().default(0),
  LAUNCH_SLIPPAGE_PERCENT: numberOrUndefined(z.coerce.number().optional()).default(10),
  MAX_SLIPPAGE_PERCENT: numberOrUndefined(z.coerce.number().optional()),
  PGLITE_PATH: z.string().default('.pglite/launchkit'),
  PGLITE_DATA_DIR: z.string().default('.pglite'),
  DATABASE_URL: z.string().optional(),
  PUMP_PORTAL_API_KEY: z.string().optional(),
  PUMP_PORTAL_WALLET_SECRET: z.string().optional(),
  PUMP_PORTAL_WALLET_ADDRESS: z.string().optional(),
  TG_ENABLE: z.enum(['true', 'false']).optional(),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  X_ENABLE: z.enum(['true', 'false']).optional(),
  X_API_KEY: z.string().optional(),
  X_API_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_SECRET: z.string().optional(),
});

export type LaunchkitEnv = z.infer<typeof EnvSchema> & {
  launchEnabled: boolean;
  launchkitEnabled: boolean;
  localWithdrawEnabled: boolean;
};

function parseEnv(source: Record<string, unknown>): LaunchkitEnv {
  const parsed = EnvSchema.parse(source);
  if (
    parsed.LAUNCH_ENABLE === 'true' &&
    parsed.LOCAL_WITHDRAW_ENABLE === 'true' &&
    !parsed.PUMP_PORTAL_WALLET_SECRET
  ) {
    const err = new Error('PUMP_PORTAL_WALLET_SECRET is required when LAUNCH_ENABLE=true and LOCAL_WITHDRAW_ENABLE=true');
    (err as any).code = 'WALLET_SECRET_REQUIRED';
    throw err;
  }
  return {
    ...parsed,
    launchEnabled: parsed.LAUNCH_ENABLE === 'true',
    launchkitEnabled: parsed.LAUNCHKIT_ENABLE === 'true',
    localWithdrawEnabled: parsed.LOCAL_WITHDRAW_ENABLE === 'true',
  } as LaunchkitEnv;
}

export function getEnv(overrides?: Record<string, string | undefined>): LaunchkitEnv {
  const merged = { ...process.env, ...overrides } as Record<string, unknown>;
  return parseEnv(merged);
}
