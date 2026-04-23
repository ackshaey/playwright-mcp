'use strict';

/**
 * Per-page CDP-level emulation. Ported from
 * pinchtab/internal/stealth/emulation.go.
 *
 * These overrides run at the protocol layer (before any JS on the page is
 * evaluated), complementing the init-script patches in stealth.js. The two
 * together form defense-in-depth: CDP overrides set the network-level signals
 * (Accept-Language header, UA on HTTP requests, client-hints metadata),
 * init-script patches cover what can only be fixed in the page realm
 * (navigator getters, plugin arrays, permission API, etc.).
 */

/**
 * Apply CDP-level emulation to a single page.
 * Safe to call multiple times; later calls override earlier ones.
 *
 * Always runs `Emulation.setAutomationOverride({ enabled: false })` whenever
 * a CDP session can be opened — the automation strip is orthogonal to the
 * persona and is the single most important CDP-level defense (it hides the
 * "Chrome is being controlled by automated test software" banner and strips
 * the navigator.webdriver signal at the protocol layer). Persona-dependent
 * overrides (locale, UA) are applied on top when a persona was provided.
 *
 * @param {import('playwright').Page} page
 * @param {object|null} persona - BrowserPersona from persona.js (nullable)
 */
async function applyPageEmulation(page, persona) {
  if (!page) return;

  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (err) {
    // newCDPSession is only available on Chromium. On other browsers the
    // init script still applies; the CDP layer is absent by design.
    return;
  }

  try {
    // Automation override always applies — independent of persona.
    await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(noop);

    if (persona?.language) {
      await cdp.send('Emulation.setLocaleOverride', { locale: persona.language }).catch(noop);
    }

    if (persona?.userAgent) {
      const metadata = persona.userAgentData ? toCDPUserAgentMetadata(persona.userAgentData) : undefined;
      const params = {
        userAgent: persona.userAgent,
        acceptLanguage: persona.acceptLanguage,
        platform: persona.navigatorPlatform,
      };
      if (metadata) params.userAgentMetadata = metadata;
      await cdp.send('Emulation.setUserAgentOverride', params).catch(noop);
    }
  } finally {
    // Detaching is best-effort — an already-closed session throws, which is fine.
    await cdp.detach().catch(noop);
  }
}

/**
 * Register a listener that applies emulation to every page created in the
 * context (including popups and new tabs). Returns an unregister function.
 * Runs even when persona is null, because the automation-override strip is
 * persona-independent.
 */
function attachContextEmulation(browserContext, persona) {
  if (!browserContext) return () => {};

  const handler = async (page) => {
    try {
      await applyPageEmulation(page, persona);
    } catch (_) {
      // Swallow — a single page failing to receive emulation shouldn't crash
      // the surrounding automation. The init script is still applied.
    }
  };

  // Emulate existing pages, then hook future ones.
  for (const page of browserContext.pages()) {
    void handler(page);
  }
  browserContext.on('page', handler);

  return () => browserContext.off('page', handler);
}

function toCDPUserAgentMetadata(data) {
  return {
    brands: (data.brands || []).map(b => ({ brand: b.brand, version: b.version })),
    fullVersionList: (data.fullVersionList || []).map(b => ({ brand: b.brand, version: b.version })),
    platform: data.platform || '',
    platformVersion: data.platformVersion || '',
    architecture: data.architecture || '',
    bitness: data.bitness || '',
    mobile: !!data.mobile,
    model: data.model || '',
    wow64: !!data.wow64,
  };
}

function noop() {}

module.exports = { applyPageEmulation, attachContextEmulation };
