import { describe, expect, it } from 'bun:test';
import plugin from '../plugin';
import { generateLaunchPackCopyAction } from '../launchkit/eliza/generateAction.ts';

const action = plugin.actions?.find((a) => a.name === 'GENERATE_LAUNCHPACK_COPY');

describe('LaunchKit actions', () => {
  it('exposes GENERATE_LAUNCHPACK_COPY', () => {
    expect(action).toBeDefined();
    expect(action?.name).toBe('GENERATE_LAUNCHPACK_COPY');
  });

  it('validate rejects invalid payload', async () => {
    const valid = await generateLaunchPackCopyAction.validate(
      {} as any,
      { content: { data: {} } } as any,
      {} as any
    );
    expect(valid).toBe(false);
  });

  it('validate accepts valid payload', async () => {
    const valid = await generateLaunchPackCopyAction.validate(
      {} as any,
      {
        content: { data: { launchPackId: '00000000-0000-4000-8000-000000000000' } },
      } as any,
      {} as any
    );
    expect(valid).toBe(true);
  });
});
