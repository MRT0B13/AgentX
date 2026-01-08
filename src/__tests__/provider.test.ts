import { describe, expect, it } from 'bun:test';
import plugin from '../plugin';

describe('LaunchKit providers', () => {
  it('does not register demo providers', () => {
    expect(plugin.providers ?? []).toHaveLength(0);
  });
});
