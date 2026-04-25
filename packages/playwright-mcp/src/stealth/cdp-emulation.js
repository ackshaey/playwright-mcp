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
 * context (including popups and new tabs). Also hooks service workers — for
 * those, we can't drive CDP directly (Playwright's newCDPSession only accepts
 * Page|Frame), but we can run a best-effort `worker.evaluate` that patches the
 * worker's own navigator. Returns an unregister function.
 *
 * Runs even when persona is null, because the page-level automation-override
 * strip is persona-independent.
 */
function attachContextEmulation(browserContext, persona) {
  if (!browserContext) return () => {};

  const pageHandler = async (page) => {
    try {
      await applyPageEmulation(page, persona);
    } catch (_) {
      // Swallow — a single page failing to receive emulation shouldn't crash
      // the surrounding automation. The init script is still applied.
    }
  };

  const workerHandler = async (worker) => {
    if (!persona?.userAgent) return; // Nothing to patch without a persona.
    try {
      await applyWorkerEmulation(worker, persona);
    } catch (_) { /* best-effort — worker may already be running */ }
  };

  // Emulate existing pages and workers, then hook future ones.
  for (const page of browserContext.pages()) {
    void pageHandler(page);
  }
  for (const worker of typeof browserContext.serviceWorkers === 'function' ? browserContext.serviceWorkers() : []) {
    void workerHandler(worker);
  }
  browserContext.on('page', pageHandler);
  browserContext.on('serviceworker', workerHandler);

  return () => {
    browserContext.off('page', pageHandler);
    browserContext.off('serviceworker', workerHandler);
  };
}

/**
 * Best-effort fingerprint patches inside a service worker.
 *
 * Caveat: this runs AFTER the worker has started, so any synchronous
 * fingerprinting at worker init has already executed against the real
 * navigator. The protocol-layer overrides (Emulation.setUserAgentOverride
 * via the page's CDP session) cover the worker's outgoing HTTP UA header
 * regardless — so this only matters for code that reads navigator.userAgent
 * inside the worker's JS realm.
 */
async function applyWorkerEmulation(worker, persona) {
  if (!worker || typeof worker.evaluate !== 'function') return;
  await worker.evaluate(({ userAgent, language, languages, navigatorPlatform }) => {
    const proto = Object.getPrototypeOf(self.navigator) || self.WorkerNavigator?.prototype;
    if (!proto) return;
    const define = (name, value) => {
      try {
        Object.defineProperty(proto, name, { get: () => value, configurable: true });
      } catch (_) { /* ignore — some props are non-configurable in workers */ }
    };
    if (userAgent) define('userAgent', userAgent);
    if (language) define('language', language);
    if (Array.isArray(languages)) define('languages', Object.freeze(languages.slice()));
    if (navigatorPlatform) define('platform', navigatorPlatform);
  }, {
    userAgent: persona.userAgent,
    language: persona.language,
    languages: persona.languages,
    navigatorPlatform: persona.navigatorPlatform,
  });
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

module.exports = { applyPageEmulation, applyWorkerEmulation, attachContextEmulation };
