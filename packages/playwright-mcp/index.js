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

// Playwright's exports field restricts deep imports, so we resolve via filesystem paths.
const playwrightDir = nodePath.dirname(require.resolve('playwright/package.json'));
const { BrowserServerBackend } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/browserServerBackend'));
const { resolveConfig } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/config'));
const { contextFactory } = require(nodePath.join(playwrightDir, 'lib/mcp/browser/browserContextFactory'));
const mcpServer = require(nodePath.join(playwrightDir, 'lib/mcp/sdk/server'));
const { EnhancedBrowserServerBackend } = require('./src/enhanced-backend');
const { applyStealthToLaunchConfig } = require('./src/stealth');
const { wrapFactoryWithStealth } = require('./src/stealth-factory');

const packageJSON = require('./package.json');

/**
 * Create an MCP connection with enhanced browser tools.
 *
 * Accepts all standard Playwright MCP config options, plus:
 * - smartSnapshot: boolean — automatically prune all snapshots for token efficiency
 * - extensionPath: string — path to a Chrome extension directory to load
 * - stealth: 'off'|'light'|'medium'|'full' — bot-detection evasion level (default off)
 * - stealthUserAgent: string — explicit UA for the stealth persona
 * - stealthChromeVersion: string — Chrome version for deriving the stealth persona
 *
 * @param {object} userConfig - Configuration options
 * @param {function} [contextGetter] - Optional custom BrowserContext getter
 * @returns {Promise<Server>} MCP Server instance
 */
async function createConnection(userConfig = {}, contextGetter) {
  // Extract our custom config fields
  const smartSnapshotMode = !!userConfig.smartSnapshot;
  const extensionPath = userConfig.extensionPath;
  const stealthOptions = {
    level: userConfig.stealth || 'off',
    userAgent: userConfig.stealthUserAgent,
    chromeVersion: userConfig.stealthChromeVersion,
  };

  // Clean config: remove our custom fields before passing to upstream
  const cleanConfig = { ...userConfig };
  delete cleanConfig.smartSnapshot;
  delete cleanConfig.extensionPath;
  delete cleanConfig.stealth;
  delete cleanConfig.stealthUserAgent;
  delete cleanConfig.stealthChromeVersion;

  // Inject extension path into launch args
  if (extensionPath) {
    const absPath = nodePath.resolve(extensionPath);
    cleanConfig.browser = cleanConfig.browser || {};
    cleanConfig.browser.launchOptions = cleanConfig.browser.launchOptions || {};
    cleanConfig.browser.launchOptions.args = cleanConfig.browser.launchOptions.args || [];
    cleanConfig.browser.launchOptions.args.push(
      `--disable-extensions-except=${absPath}`,
      `--load-extension=${absPath}`
    );
  }

  const config = await resolveConfig(cleanConfig);

  // Apply stealth launch args (no-op when level is 'off').
  const stealthResult = applyStealthToLaunchConfig(config, stealthOptions);

  let factory;
  if (contextGetter) {
    factory = new SimpleBrowserContextFactory(contextGetter);
  } else {
    factory = contextFactory(config);
  }

  factory = wrapFactoryWithStealth(factory, stealthResult, config);

  const originalBackend = new BrowserServerBackend(config, factory);
  const enhancedBackend = new EnhancedBrowserServerBackend(originalBackend, {
    smartSnapshotMode,
    stealthResult,
  });

  return mcpServer.createServer('Playwright', packageJSON.version, enhancedBackend, false);
}

class SimpleBrowserContextFactory {
  constructor(contextGetter) {
    this.name = 'custom';
    this.description = 'Connect to a browser using a custom context getter';
    this._contextGetter = contextGetter;
  }

  async createContext() {
    const browserContext = await this._contextGetter();
    return {
      browserContext,
      close: () => browserContext.close(),
    };
  }
}

module.exports = { createConnection };
