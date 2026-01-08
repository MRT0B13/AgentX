import { describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import plugin, { LaunchKitBootstrapService } from '../plugin';

function createRuntime(service?: LaunchKitBootstrapService): IAgentRuntime {
  return {
    getService: mock().mockReturnValue(service),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

describe('LaunchKit plugin', () => {
  it('exposes launchkit metadata', () => {
    expect(plugin.name).toBe('launchkit');
    expect(plugin.priority).toBe(0);
    const actionNames = (plugin.actions || []).map((action) => action.name);
    expect(actionNames).toEqual(
      expect.arrayContaining([
        'GENERATE_LAUNCHPACK_COPY',
        'LAUNCH_LAUNCHPACK',
        'PUBLISH_TELEGRAM',
        'PUBLISH_X',
      ])
    );
  });
});

describe('LaunchKitBootstrapService', () => {
  it('falls back to server close when closeFn is missing', async () => {
    const runtime = createRuntime();
    const service = new LaunchKitBootstrapService(runtime);
    const close = mock(async () => {});
    (service as any).server = { baseUrl: 'http://localhost', close };

    await service.stop();
    expect(close).toHaveBeenCalled();
  });

  it('static stop calls instance stop when registered', async () => {
    const service = new LaunchKitBootstrapService(createRuntime());
    const stop = mock(async () => {});
    (service as any).stop = stop;
    const runtime = createRuntime(service);

    await LaunchKitBootstrapService.stop(runtime);
    expect(stop).toHaveBeenCalled();
  });
});
