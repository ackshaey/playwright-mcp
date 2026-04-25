'use strict';

/**
 * Bootstrap wrapper for the stealth init script.
 *
 * The stealth.js asset (ported verbatim from pinchtab) reads four globals at
 * startup — __pinchtab_seed, __pinchtab_stealth_level, __pinchtab_headless,
 * __pinchtab_profile. This module concatenates a header that sets those
 * globals with the stealth script body plus the popup-guard script, producing
 * a single self-contained string suitable for
 * `browserContext.addInitScript({ content: ... })`.
 *
 * COVERAGE: The resulting script runs at document_start on every page in the
 * context, including all iframes (per Playwright's addInitScript semantics).
 * It does NOT run in Web Workers, Service Workers, or Shared Workers — those
 * run in separate JS realms that addInitScript does not touch.
 *
 * The worker realm gap is partially closed by cdp-emulation.js:
 *   - Outgoing HTTP UA in workers is fixed by the page's CDP
 *     Emulation.setUserAgentOverride (applies at the protocol layer).
 *   - Service worker `navigator.userAgent`, `language`, `languages`, and
 *     `platform` are post-hoc patched via `worker.evaluate` after the
 *     `serviceworker` event fires — best-effort, since the worker's first
 *     synchronous fingerprinting has already run against the real navigator
 *     by the time we patch.
 *   - Heavier JS-only patches in stealth.js (plugin arrays, permission API,
 *     battery, WebGL spoofing, etc.) still do NOT reach worker realms.
 *     Callers scraping sites that sniff via plugin/permission surfaces from
 *     a worker should be aware of this residual gap.
 */

const fs = require('fs');
const path = require('path');

const STEALTH_SCRIPT_PATH = path.join(__dirname, 'stealth.js');
const POPUP_GUARD_PATH = path.join(__dirname, 'popup-guard.js');

let cachedStealthBody;
let cachedPopupGuard;

function loadStealthBody() {
  return cachedStealthBody ??= fs.readFileSync(STEALTH_SCRIPT_PATH, 'utf8');
}

function loadPopupGuard() {
  return cachedPopupGuard ??= fs.readFileSync(POPUP_GUARD_PATH, 'utf8');
}

/**
 * @param {object} options
 * @param {'light'|'medium'|'full'} options.level
 * @param {boolean} options.headless
 * @param {object|null} options.persona - BrowserPersona from persona.js (or null/minimal)
 * @param {number} [options.seed] - Deterministic seed; defaults to a fresh random int.
 * @returns {string} Self-contained init-script content.
 */
function buildBootstrap({ level, headless, persona, seed } = {}) {
  const actualSeed = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 2_000_000_000);
  const actualLevel = normalizeLevel(level);
  const profileJson = personaToProfileJson(persona);

  const header =
    `var __pinchtab_seed = ${actualSeed};\n` +
    `var __pinchtab_stealth_level = ${JSON.stringify(actualLevel)};\n` +
    `var __pinchtab_headless = ${JSON.stringify(!!headless)};\n` +
    `var __pinchtab_profile = ${profileJson};\n`;

  return `${header}\n${loadStealthBody()}\n${loadPopupGuard()}`;
}

function normalizeLevel(level) {
  const normalized = String(level || 'light').trim().toLowerCase();
  if (normalized === 'medium' || normalized === 'full') return normalized;
  return 'light';
}

/**
 * Serialize a persona into the shape stealth.js expects on the
 * __pinchtab_profile global. Keys are camelCase; missing fields are tolerated.
 */
function personaToProfileJson(persona) {
  if (!persona || !persona.userAgent) return '{}';

  const profile = {
    userAgent: persona.userAgent,
    language: persona.language,
    languages: persona.languages,
    navigatorPlatform: persona.navigatorPlatform,
  };

  if (persona.userAgentData) {
    profile.userAgentData = persona.userAgentData;
  }

  return JSON.stringify(profile);
}

module.exports = { buildBootstrap, normalizeLevel };
