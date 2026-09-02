'use strict';

/**
 * Public entry point for the stealth subsystem.
 *
 * Caller flow:
 *   1. `applyStealthToLaunchConfig(config, options)` before launching the
 *      browser — mutates the Playwright MCP config to add stealth launch args
 *      and ignoreDefaultArgs.
 *   2. `attachStealthToContext(browserContext, options)` after the context is
 *      created — installs the init script on every page and registers a
 *      per-page CDP emulation listener.
 *   3. `solveChallenge(page)` on demand — exposed via the
 *      `browser_solve_challenge` MCP tool.
 */

const { buildLaunchContract, IGNORE_DEFAULT_ARGS } = require('./launch-args');
const { getExecutableChromeVersion } = require('./persona');
const { buildBootstrap, normalizeLevel } = require('./bootstrap');
const { attachContextEmulation } = require('./cdp-emulation');
const {
  isChallenge,
  detectChallengeType,
  findTurnstileBox,
  solveChallenge,
} = require('./cloudflare-solver');

const VALID_LEVELS = new Set(['off', 'light', 'medium', 'full']);

function isStealthEnabled(level) {
  return !!level && level !== 'off';
}

/**
 * Validate a level string; throws if invalid. Returns the normalized level
 * (lowercase, trimmed). `off` is passed through unchanged.
 */
function validateLevel(level) {
  const normalized = String(level ?? 'off').trim().toLowerCase();
  if (!VALID_LEVELS.has(normalized)) {
    throw new Error(`Invalid stealth level "${level}". Expected one of: off, light, medium, full.`);
  }
  return normalized;
}

/**
 * Mutate a Playwright MCP config to inject stealth launch arguments.
 * No-op if stealth is off. Safe to call multiple times — additional calls
 * replace previous stealth args but preserve unrelated args.
 *
 * @param {object} config - Playwright MCP config (from resolveConfig/resolveCLIConfig)
 * @param {object} options
 * @param {'off'|'light'|'medium'|'full'} options.level
 * @param {string} [options.userAgent]
 * @param {string} [options.chromeVersion]
 */
function applyStealthToLaunchConfig(config, options = {}) {
  const level = validateLevel(options.level);
  if (!isStealthEnabled(level)) return { level, persona: null };

  // When the caller pins a binary via executablePath but gives no explicit
  // persona, derive the persona version from that binary (`--version`) rather
  // than from playwright-core's bundled-Chromium version — otherwise the UA
  // announces one Chrome while TLS/JA4 and client hints carry another, and
  // that self-inconsistent identity is itself a bot signal (PerimeterX
  // press-and-hold, DDC-1298).
  let chromeVersion = options.chromeVersion;
  if (!chromeVersion && !options.userAgent) {
    const executablePath = config?.browser?.launchOptions?.executablePath;
    const derived = getExecutableChromeVersion(executablePath);
    if (derived) {
      console.error(`[playwright-mcp stealth] Persona version ${derived} derived from executablePath.`);
      chromeVersion = derived;
    }
  }

  const contract = buildLaunchContract({
    userAgent: options.userAgent,
    chromeVersion,
  });

  config.browser = config.browser || {};
  config.browser.launchOptions = config.browser.launchOptions || {};

  const launchOptions = config.browser.launchOptions;
  launchOptions.args = mergeArgs(launchOptions.args || [], contract.args);
  launchOptions.ignoreDefaultArgs = [...new Set([...(launchOptions.ignoreDefaultArgs || []), ...IGNORE_DEFAULT_ARGS])];

  // An explicit executablePath (e.g. a managed Chrome-for-Testing binary passed via
  // --executable-path) fully selects the browser: setting a channel on top of it is
  // redundant and, worse, would make Playwright ignore the binary. Leave it untouched.
  // This is the supported way to run stealth on a *current* Chrome-for-Testing, which
  // both loads unpacked extensions (branded Chrome no longer does — removed in Chrome
  // 142) and presents an authentic, current-Chrome TLS/JA4 fingerprint that Akamai Bot
  // Manager accepts. The bundled Chromium is often several versions stale, and that
  // stale JA4 is exactly what gets denied (see agents_context/forklift_browser_automation.md).
  if (launchOptions.executablePath) {
    console.error(`[playwright-mcp stealth] Using explicit executablePath (${launchOptions.executablePath}); not forcing a channel.`);
  } else if (launchOptions.channel === 'chrome') {
    // Force chromium channel when stealth is on — branded Chrome blocks many of the
    // flags above (notably --load-extension and some automation flags). Respect any
    // other explicit channel the user set (msedge, firefox, etc.). Emit a diagnostic
    // so the user isn't silently retargeted.
    console.error('[playwright-mcp stealth] Switching browser channel from "chrome" to "chromium" — branded Chrome disables the automation-related flags stealth needs.');
    launchOptions.channel = 'chromium';
  } else if (!launchOptions.channel) {
    launchOptions.channel = 'chromium';
  }

  return { level, persona: contract.persona };
}

/**
 * Merge new launch args into an existing list. For prefix args
 * (`--flag=value`), a new entry replaces any existing arg sharing the prefix.
 * For flag-only args, dedupe on exact match. Pure function — returns a new
 * array so callers can assign it back onto launchOptions.
 */
function mergeArgs(existing, incoming) {
  const incomingPrefixes = new Set();
  for (const arg of incoming) {
    const eq = arg.indexOf('=');
    if (eq > 0) incomingPrefixes.add(arg.slice(0, eq + 1));
  }

  // Drop any existing arg whose prefix is being replaced.
  const kept = existing.filter(a => {
    const eq = a.indexOf('=');
    const prefix = eq > 0 ? a.slice(0, eq + 1) : null;
    return !(prefix && incomingPrefixes.has(prefix));
  });

  const seen = new Set(kept);
  for (const arg of incoming) {
    if (!seen.has(arg)) {
      kept.push(arg);
      seen.add(arg);
    }
  }
  return kept;
}

/**
 * Install the init script and per-page CDP emulation on a browser context.
 *
 * Returns an async `detach` function that removes the `page` listener.
 * The init script is not removable — it stays registered for the context's
 * lifetime (which matches Playwright's semantics anyway).
 *
 * @param {import('playwright').BrowserContext} browserContext
 * @param {object} options
 * @param {'light'|'medium'|'full'} options.level
 * @param {boolean} [options.headless=false]
 * @param {object} [options.persona] - BrowserPersona from persona.js
 * @param {number} [options.seed]
 */
async function attachStealthToContext(browserContext, options = {}) {
  const level = normalizeLevel(options.level);
  const headless = !!options.headless;
  const persona = options.persona || null;

  const script = buildBootstrap({
    level,
    headless,
    persona,
    seed: options.seed,
  });

  await browserContext.addInitScript({ content: script });

  const detachEmulation = attachContextEmulation(browserContext, persona);

  return async () => {
    detachEmulation();
  };
}

module.exports = {
  applyStealthToLaunchConfig,
  attachStealthToContext,
  validateLevel,
  isStealthEnabled,
  // Re-exports for tests + tools
  isChallenge,
  detectChallengeType,
  findTurnstileBox,
  solveChallenge,
};
