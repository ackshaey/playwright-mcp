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
 * run in separate JS realms that addInitScript does not touch. For UA-level
 * signals inside workers (e.g. navigator.userAgent as seen from a worker),
 * we rely on the CDP-level `Emulation.setUserAgentOverride` override in
 * cdp-emulation.js, which applies at the protocol layer and so covers worker
 * contexts transparently. Pure-JS patches in stealth.js (plugin arrays,
 * permission API, etc.) do NOT reach worker realms — callers scraping sites
 * that sniff from workers should be aware of this gap.
 */

const fs = require('fs');
const path = require('path');

const STEALTH_SCRIPT_PATH = path.join(__dirname, 'stealth.js');
const POPUP_GUARD_PATH = path.join(__dirname, 'popup-guard.js');

let cachedStealthBody;
let cachedPopupGuard;

function loadAsset(filePath, cacheRef) {
  if (cacheRef.value !== undefined) return cacheRef.value;
  cacheRef.value = fs.readFileSync(filePath, 'utf8');
  return cacheRef.value;
}

const stealthBodyCache = { value: undefined };
const popupGuardCache = { value: undefined };

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

  const stealthBody = loadAsset(STEALTH_SCRIPT_PATH, stealthBodyCache);
  const popupGuard = loadAsset(POPUP_GUARD_PATH, popupGuardCache);

  const header =
    `var __pinchtab_seed = ${actualSeed};\n` +
    `var __pinchtab_stealth_level = ${JSON.stringify(actualLevel)};\n` +
    `var __pinchtab_headless = ${headless ? 'true' : 'false'};\n` +
    `var __pinchtab_profile = ${profileJson};\n`;

  return `${header}\n${stealthBody}\n${popupGuard}`;
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
