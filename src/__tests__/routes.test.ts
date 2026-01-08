import { describe, expect, it } from 'bun:test';
import plugin from '../plugin';

describe('LaunchKit routes', () => {
  it('does not expose demo routes', () => {
    expect(plugin.routes ?? []).toHaveLength(0);
  });
});
