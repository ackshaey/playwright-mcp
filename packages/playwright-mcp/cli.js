#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const nodePath = require('path');
const { program } = require('playwright-core/lib/utilsBundle');
const { decorateMCPCommand } = require('playwright/lib/mcp/program');

// Playwright's exports field restricts deep imports, so we resolve via filesystem paths.
const playwrightDir = nodePath.dirname(require.resolve('playwright/package.json'));
const mcpServer = require(nodePath.join(playwrightDir, 'lib/mcp/sdk/server'));
const { resolveCLIConfig } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/config'));
const { contextFactory } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/browserContextFactory'));
const { BrowserServerBackend } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/browserServerBackend'));
const { setupExitWatchdog } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/watchdog'));

const { EnhancedBrowserServerBackend } = require('./src/enhanced-backend');
const { applyStealthToLaunchConfig } = require('./src/stealth');
const { wrapFactoryWithStealth } = require('./src/stealth-factory');

let ExtensionContextFactory;
try {
  ExtensionContextFactory = require(nodePath.join(playwrightDir, 'lib/mcp/extension/extensionContextFactory')).ExtensionContextFactory;
} catch (e) {
  // Extension context factory may not be available in all builds
}

const packageJSON = require('./package.json');
const p = program.version('Version ' + packageJSON.version).name('Playwright MCP (Enhanced)');

// Let upstream decorateMCPCommand add all ~50 standard options + its action handler
decorateMCPCommand(p, packageJSON.version);

// Add our custom options
p.option('--smart-snapshot', 'automatically prune all snapshots for token efficiency (~5x reduction)');
p.option('--extension-path <path>', 'path to a Chrome extension directory to load');
p.option('--stealth <level>', 'enable bot-detection evasion: off | light | medium | full (default: off)');
p.option('--stealth-chrome-version <version>', 'Chrome version used to derive stealth persona UA (e.g. "144.0.7559.133")');
p.option('--stealth-user-agent <ua>', 'explicit UA string for the stealth persona (overrides --stealth-chrome-version)');

// Override the action handler — Commander replaces the previous one
p.action(async (options) => {
  // --- Replicate upstream action handler logic (program.js lines 42-71) ---
  options.sandbox = options.sandbox === true ? undefined : false;
  setupExitWatchdog();

  if (options.vision) {
    console.error('The --vision option is deprecated, use --caps=vision instead');
    options.caps = 'vision';
  }
  if (options.caps?.includes('tracing'))
    options.caps.push('devtools');

  const config = await resolveCLIConfig(options);

  // --- Our addition: inject extension path into launch args ---
  if (options.extensionPath) {
    const absPath = nodePath.resolve(options.extensionPath);
    config.browser.launchOptions = config.browser.launchOptions || {};
    config.browser.launchOptions.args = config.browser.launchOptions.args || [];
    config.browser.launchOptions.args.push(
      `--disable-extensions-except=${absPath}`,
      `--load-extension=${absPath}`
    );
  }

  // --- Stealth: mutate launch config, persona flows into the context wrapper ---
  const stealthLevel = options.stealth || 'off';
  const stealthResult = applyStealthToLaunchConfig(config, {
    level: stealthLevel,
    userAgent: options.stealthUserAgent,
    chromeVersion: options.stealthChromeVersion,
  });

  const smartSnapshotMode = !!options.smartSnapshot;

  // --- Handle extension mode (--extension flag) ---
  if (config.extension && ExtensionContextFactory) {
    const extensionContextFactory = new ExtensionContextFactory(
      config.browser.launchOptions.channel || 'chrome',
      config.browser.userDataDir,
      config.browser.launchOptions.executablePath
    );
    const serverBackendFactory = {
      name: 'Playwright w/ extension',
      nameInConfig: 'playwright-extension',
      version: packageJSON.version,
      create: () => new EnhancedBrowserServerBackend(
        new BrowserServerBackend(config, wrapFactoryWithStealth(extensionContextFactory, stealthResult, config)),
        { smartSnapshotMode, stealthResult }
      ),
    };
    await mcpServer.start(serverBackendFactory, config.server);
    return;
  }

  // --- Standard mode: launch browser with our enhanced backend ---
  const browserContextFactory = contextFactory(config);
  const factory = {
    name: 'Playwright',
    nameInConfig: 'playwright',
    version: packageJSON.version,
    create: () => new EnhancedBrowserServerBackend(
      new BrowserServerBackend(config, wrapFactoryWithStealth(browserContextFactory, stealthResult, config)),
      { smartSnapshotMode, stealthResult }
    ),
  };
  await mcpServer.start(factory, config.server);
});

void program.parseAsync(process.argv);
