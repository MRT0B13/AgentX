import type { Plugin } from '@elizaos/core';
import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import type { LaunchPackStore } from './launchkit/db/launchPackRepository.ts';
import { CopyGeneratorService } from './launchkit/services/copyGenerator.ts';
import { PumpLauncherService } from './launchkit/services/pumpLauncher.ts';
import { TelegramPublisherService } from './launchkit/services/telegramPublisher.ts';
import { XPublisherService } from './launchkit/services/xPublisher.ts';
import { generateLaunchPackCopyAction } from './launchkit/eliza/generateAction.ts';
import { launchLaunchPackAction, publishTelegramAction, publishXAction } from './launchkit/eliza/publishActions.ts';
import { initLaunchKit } from './launchkit/init.ts';

class LaunchKitBootstrapService extends Service {
  static serviceType = 'launchkit_bootstrap';
  private server?: { baseUrl: string; close: () => Promise<void> };
  private closeFn?: () => Promise<void>;
  private store?: LaunchPackStore;
  private copyService?: CopyGeneratorService;
  private pumpService?: PumpLauncherService;
  private telegramPublisher?: TelegramPublisherService;
  private xPublisher?: XPublisherService;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  capabilityDescription = 'LaunchKit bootstrap and HTTP server lifecycle management';

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting LaunchKit bootstrap ***');
    const service = new LaunchKitBootstrapService(runtime);
    const { server, close, store, copyService, pumpService, telegramPublisher, xPublisher } = await initLaunchKit(runtime);
    service.server = server;
    service.closeFn = close ?? server?.close;
    service.store = store;
    service.copyService = copyService;
    service.pumpService = pumpService;
    service.telegramPublisher = telegramPublisher;
    service.xPublisher = xPublisher;
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(LaunchKitBootstrapService.serviceType) as LaunchKitBootstrapService | undefined;
    if (service) await service.stop();
  }

  async stop() {
    if (this.closeFn) {
      await this.closeFn();
    } else if (this.server) {
      await this.server.close();
    }
    this.server = undefined;
    this.closeFn = undefined;
    this.store = undefined;
    this.copyService = undefined;
    this.pumpService = undefined;
    this.telegramPublisher = undefined;
    this.xPublisher = undefined;
  }

  getLaunchKit() {
    return {
      store: this.store,
      copyService: this.copyService,
      pumpService: this.pumpService,
      telegramPublisher: this.telegramPublisher,
      xPublisher: this.xPublisher,
    };
  }
}

const plugin: Plugin = {
  name: 'launchkit',
  description: 'LaunchKit actions and HTTP server bootstrap',
  priority: 0,
  services: [LaunchKitBootstrapService],
  actions: [generateLaunchPackCopyAction, launchLaunchPackAction, publishTelegramAction, publishXAction],
};

export { LaunchKitBootstrapService };
export default plugin;
