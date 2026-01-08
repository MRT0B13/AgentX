import { describe, expect, it } from 'bun:test';
import plugin from '../plugin';

describe('LaunchKit plugin configuration', () => {
  it('does not require init config', () => {
    expect(plugin.init).toBeUndefined();
    expect(plugin.config).toBeUndefined();
  });
});
