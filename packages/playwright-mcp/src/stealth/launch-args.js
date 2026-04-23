'use strict';

/**
 * Chromium launch arguments for stealth. Ported from
 * pinchtab/internal/stealth/launch.go.
 *
 * These flags are necessary-but-not-sufficient — they close obvious automation
 * signals at the browser level. The heavy lifting happens in the init script
 * (stealth.js) and CDP emulation hooks.
 */

const { buildPersona } = require('./persona');

/**
 * Build the launch-args contract for a stealth session.
 *
 * @param {object} options
 * @param {string} [options.userAgent] - Target UA string. If set, overrides the derived UA.
 * @param {string} [options.chromeVersion] - Chrome version (e.g. "144.0.7559.133") used to
 *   derive a platform-appropriate UA when userAgent is absent.
 * @returns {{ args: string[], flags: object }}
 */
function buildLaunchContract({ userAgent, chromeVersion } = {}) {
  const persona = buildPersona(userAgent, chromeVersion);

  const args = [
    '--disable-automation',
    '--enable-automation=false',
    '--disable-blink-features=AutomationControlled',
    '--enable-network-information-downlink-max',
  ];

  if (persona.userAgent) {
    args.push(`--user-agent=${persona.userAgent}`);
  }
  if (persona.language) {
    args.push(`--lang=${persona.language}`);
  }

  return {
    args,
    persona,
    flags: {
      automationControlledDisabled: true,
      enableAutomationFalse: true,
      downlinkMaxFlag: true,
      globalUserAgent: !!persona.userAgent,
      globalLanguage: !!persona.language,
    },
  };
}

/**
 * Chromium default args Playwright adds that stealth must neutralize. These
 * go into `launchOptions.ignoreDefaultArgs`.
 */
const IGNORE_DEFAULT_ARGS = [
  '--enable-automation',
  '--disable-extensions',
];

module.exports = { buildLaunchContract, IGNORE_DEFAULT_ARGS };
