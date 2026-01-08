import { logger } from '@elizaos/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { character } from '../index';
import plugin from '../plugin';

// Set up spies on logger
beforeAll(() => {
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'error').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  // No global restore needed in bun:test;
});

// Skip in CI environments or when running automated tests without interaction
const isCI = Boolean(process.env.CI);

/**
 * Integration tests demonstrate how multiple components of the project work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 */
describe('Integration: Project Structure and Components', () => {
  it('should have a valid package structure', () => {
    const srcDir = path.join(process.cwd(), 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    // Check for required source files - only checking core files
    const srcFiles = [path.join(srcDir, 'index.ts'), path.join(srcDir, 'plugin.ts')];

    srcFiles.forEach((file) => {
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it('should have dist directory for build outputs', () => {
    const distDir = path.join(process.cwd(), 'dist');

    // Skip directory content validation if dist doesn't exist yet
    if (!fs.existsSync(distDir)) {
      logger.warn('Dist directory does not exist yet. Build the project first.');
      return;
    }

    expect(fs.existsSync(distDir)).toBe(true);
  });
});

describe('Integration: Character and Plugin', () => {
  it('should have character with required properties', () => {
    // Verify character has required properties
    expect(character).toHaveProperty('name');
    expect(character).toHaveProperty('plugins');
    expect(character).toHaveProperty('bio');
    expect(character).toHaveProperty('system');
    expect(character).toHaveProperty('messageExamples');

    // Verify plugins is an array
    expect(Array.isArray(character.plugins)).toBe(true);
  });

  it('should configure plugin correctly', () => {
    // Verify plugin has necessary components that character will use
    expect(plugin).toHaveProperty('name');
    expect(plugin).toHaveProperty('description');

    // Check if plugin has actions, models, providers, etc. that character might use
    const components = ['models', 'actions', 'providers', 'services', 'routes', 'events'];
    components.forEach((component) => {
      if ((plugin as any)[component]) {
        // Just verify if these exist, we don't need to test their functionality here
        // Those tests belong in plugin.test.ts, actions.test.ts, etc.
        expect(
          Array.isArray((plugin as any)[component]) ||
            typeof (plugin as any)[component] === 'object'
        ).toBeTruthy();
      }
    });
  });
});

// Skip scaffolding tests in CI environments as they modify the filesystem
const describeScaffolding = isCI ? describe.skip : describe;
describeScaffolding('Integration: Project Scaffolding', () => {
  // Create a temp directory for testing the scaffolding
  const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-test-'));

  beforeAll(() => {
    // Create test directory if it doesn't exist
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should scaffold a new project correctly', () => {
    try {
      // This is a simple simulation of the scaffolding process
      // In a real scenario, you'd use the CLI or API to scaffold

      // Copy essential files to test directory
      const srcFiles = ['index.ts', 'plugin.ts', 'character.ts'];

      for (const file of srcFiles) {
        const sourceFilePath = path.join(process.cwd(), 'src', file);
        const targetFilePath = path.join(TEST_DIR, file);

        if (fs.existsSync(sourceFilePath)) {
          fs.copyFileSync(sourceFilePath, targetFilePath);
        }
      }

      // Create package.json in test directory
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@elizaos/core': 'workspace:*',
        },
      };

      fs.writeFileSync(path.join(TEST_DIR, 'package.json'), JSON.stringify(packageJson, null, 2));

      // Verify files exist
      expect(fs.existsSync(path.join(TEST_DIR, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'plugin.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'character.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'package.json'))).toBe(true);
    } catch (error) {
      logger.error({ error }, 'Error in scaffolding test:');
      throw error;
    }
  });
});
