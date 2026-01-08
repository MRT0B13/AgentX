import { describe, expect, it } from 'bun:test';
import { getEnv } from '../../launchkit/env.ts';

describe('getEnv', () => {
  it('parses and coerces env values with defaults', () => {
    const env = getEnv({
      LAUNCH_ENABLE: 'true',
      LAUNCHKIT_ENABLE: 'true',
      LAUNCHKIT_PORT: '0',
      MAX_SOL_DEV_BUY: '0.5',
      MAX_PRIORITY_FEE: '0.001',
      MAX_LAUNCHES_PER_DAY: '5',
      LAUNCH_SLIPPAGE_PERCENT: '12',
      MAX_SLIPPAGE_PERCENT: '20',
      PGLITE_DATA_DIR: '.pglite',
      DATABASE_URL: '',
    });

    expect(env.launchEnabled).toBe(true);
    expect(env.launchkitEnabled).toBe(true);
    expect(env.LAUNCHKIT_PORT).toBe(0);
    expect(env.MAX_SOL_DEV_BUY).toBeCloseTo(0.5);
    expect(env.MAX_PRIORITY_FEE).toBeCloseTo(0.001);
    expect(env.MAX_LAUNCHES_PER_DAY).toBe(5);
    expect(env.LAUNCH_SLIPPAGE_PERCENT).toBe(12);
    expect(env.MAX_SLIPPAGE_PERCENT).toBe(20);
  });

  it('rejects invalid boolean strings', () => {
    expect(() => getEnv({ LAUNCH_ENABLE: 'yes' })).toThrow();
  });
});
