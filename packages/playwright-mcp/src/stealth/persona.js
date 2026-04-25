'use strict';

/**
 * Browser persona: a coherent set of navigator identifiers (UA string + client
 * hints + language + platform). Ported from pinchtab/internal/stealth/ua.go.
 *
 * A persona has to be internally consistent — a Mac UA string paired with a
 * Win32 platform or Linux client hints is itself a bot signal. This module
 * builds coherent personas from a target UA (or a Chrome version, which is
 * expanded to a platform-appropriate UA).
 */

const fs = require('fs');
const os = require('os');

// Frozen fallback if browsers.json can't be read — kept current as of port date.
// The dynamic resolver below will always prefer the actually-installed Chromium
// version, so this only matters in pathological environments (corrupted install,
// ESM-only env, etc.).
const FALLBACK_CHROME_VERSION = '146.0.7680.0';

let cachedDefault = null;

/**
 * Read the bundled Chromium version from playwright-core's browsers.json.
 * Cached after the first successful read. Falls back to FALLBACK_CHROME_VERSION
 * when discovery fails.
 *
 * Doing this at runtime (rather than baking a constant) keeps the persona's UA
 * matched to whatever Playwright actually launches — so the UA doesn't drift
 * into a bot signal as Playwright rolls Chromium forward.
 */
function getDefaultChromeVersion() {
  if (cachedDefault) return cachedDefault;
  try {
    const browsersJsonPath = require.resolve('playwright-core/browsers.json');
    const data = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'));
    const chromium = (data?.browsers || []).find(b => b.name === 'chromium');
    if (chromium?.browserVersion) {
      cachedDefault = chromium.browserVersion;
      return cachedDefault;
    }
  } catch (_) { /* swallow — fall through to fallback */ }
  cachedDefault = FALLBACK_CHROME_VERSION;
  return cachedDefault;
}

/**
 * Resolve a UA string. If `userAgent` is provided, it's used as-is. If
 * `chromeVersion` is provided, a platform-appropriate UA is built from it.
 * If neither is set, falls back to the bundled Chromium version so callers
 * who pass `--stealth full` with no further args still get a coherent persona
 * matching the Chromium they're about to launch.
 */
function resolveUserAgent(userAgent, chromeVersion) {
  if (userAgent) return userAgent;
  const version = chromeVersion || getDefaultChromeVersion();
  if (!version) return '';

  const platform = os.platform();
  switch (platform) {
    case 'darwin':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    case 'win32':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    default:
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
}

/**
 * Build a coherent BrowserPersona from a target UA string and Chrome version.
 *
 * If both inputs are empty, returns a minimal persona with only language
 * defaults set — callers should check persona.userAgent before applying
 * UA-specific overrides.
 */
function buildPersona(userAgent, chromeVersion) {
  const ua = resolveUserAgent(userAgent, chromeVersion);
  const language = 'en-US';
  const languages = ['en-US', 'en'];
  const acceptLanguage = 'en-US,en';

  if (!ua) {
    return {
      userAgent: '',
      language,
      languages,
      acceptLanguage,
      navigatorPlatform: '',
      userAgentData: null,
    };
  }

  // Pull major from chromeVersion if given; otherwise from the runtime-resolved
  // bundled-Chromium version (so brands match the UA we just built).
  const effectiveVersion = chromeVersion || getDefaultChromeVersion();
  const major = effectiveVersion.split('.')[0] || '146';

  let navigatorPlatform = 'Linux x86_64';
  let uaDataPlatform = 'Linux';
  let platformVersion = '6.5.0';
  if (ua.includes('Windows')) {
    navigatorPlatform = 'Win32';
    uaDataPlatform = 'Windows';
    platformVersion = '15.0.0';
  } else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
    navigatorPlatform = 'MacIntel';
    uaDataPlatform = 'macOS';
    platformVersion = '14.0.0';
  }

  // UA hints expose arm64 machines as "arm" regardless of what the UA string
  // says — most real Chromes do this.
  let architecture = 'x86';
  if (ua.includes('arm64') || ua.includes('aarch64') || ua.includes('ARM')) {
    architecture = 'arm';
  } else if (os.arch() === 'arm64') {
    architecture = 'arm';
  }

  const fullVersion = effectiveVersion;

  const brands = [
    { brand: 'Not(A:Brand', version: '99' },
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
  ];
  const fullVersionList = [
    { brand: 'Not(A:Brand', version: '99.0.0.0' },
    { brand: 'Google Chrome', version: fullVersion },
    { brand: 'Chromium', version: fullVersion },
  ];

  return {
    userAgent: ua,
    language,
    languages,
    acceptLanguage,
    navigatorPlatform,
    userAgentData: {
      brands,
      fullVersionList,
      mobile: false,
      platform: uaDataPlatform,
      platformVersion,
      architecture,
      bitness: '64',
      model: '',
      wow64: false,
    },
  };
}

module.exports = {
  buildPersona,
  resolveUserAgent,
  getDefaultChromeVersion,
  FALLBACK_CHROME_VERSION,
};
