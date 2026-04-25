'use strict';

/**
 * Wraps an upstream Playwright MCP browser-context factory so that every
 * context it creates has the stealth init script and per-page CDP emulation
 * installed before anything else touches it.
 *
 * The factory contract is: `createContext(clientInfo, abortSignal, options)`
 * returns `{ browserContext, close }`. We preserve that contract, call the
 * original, then attach stealth before returning.
 *
 * If stealth is off, this returns the factory unchanged (zero-cost).
 */

const { attachStealthToContext, isStealthEnabled } = require('./stealth');

function wrapFactoryWithStealth(factory, stealthResult, config) {
  if (!factory || !stealthResult) return factory;
  if (!isStealthEnabled(stealthResult.level)) return factory;

  const headless = !!config?.browser?.launchOptions?.headless;
  const { persona, level } = stealthResult;

  const original = factory.createContext.bind(factory);

  factory.createContext = async (...args) => {
    const result = await original(...args);
    if (!result?.browserContext) return result;

    // Stash the live browserContext on the shared stealthResult so the
    // enhanced-backend's browser_solve_challenge handler can reach the
    // current page without relying on upstream's private `_context` field.
    stealthResult.browserContext = result.browserContext;

    try {
      const detach = await attachStealthToContext(result.browserContext, {
        level,
        headless,
        persona,
      });

      // Chain the detach handler into the context's close method so emulation
      // listeners are cleaned up on context teardown.
      const originalClose = result.close;
      result.close = async () => {
        try {
          await detach();
        } catch (_) { /* best-effort */ }
        if (stealthResult.browserContext === result.browserContext) {
          stealthResult.browserContext = null;
        }
        if (typeof originalClose === 'function') await originalClose();
      };
    } catch (err) {
      // Don't fail the session if stealth installation fails — log and fall
      // through. The user asked for stealth, so surface a diagnostic.
      console.error(`[playwright-mcp stealth] Failed to attach stealth to context: ${err?.message || err}`);
    }

    return result;
  };

  return factory;
}

module.exports = { wrapFactoryWithStealth };
