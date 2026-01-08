import { describe, expect, it } from 'bun:test';
import { generateLaunchPackCopyAction } from '../launchkit/eliza/generateAction.ts';

const runtime = {} as any;
const state = {} as any;

describe('LaunchKit action validation', () => {
  it('rejects invalid payloads', async () => {
    const message = { content: { data: {} } } as any;
    const valid = await generateLaunchPackCopyAction.validate(runtime, message, state);
    expect(valid).toBe(false);
  });

  it('accepts payload with launchPackId', async () => {
    const message = {
      content: { data: { launchPackId: '00000000-0000-4000-8000-000000000000' } },
    } as any;
    const valid = await generateLaunchPackCopyAction.validate(runtime, message, state);
    expect(valid).toBe(true);
  });
});
