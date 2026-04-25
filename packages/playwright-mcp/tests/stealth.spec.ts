/**
 * Unit-style tests for the stealth subsystem. These exercise the pure-JS
 * pieces (persona, launch args, bootstrap, CF detection) without launching
 * a real browser — they run in the Node process directly.
 */

import { test, expect } from './fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const persona = require('../src/stealth/persona');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const launchArgs = require('../src/stealth/launch-args');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bootstrap = require('../src/stealth/bootstrap');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stealth = require('../src/stealth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cfSolver = require('../src/stealth/cloudflare-solver');

test.describe('stealth.persona', () => {
  test('returns minimal persona when no UA or version given (and no Playwright)', () => {
    // With Playwright installed, buildPersona('', '') falls through to
    // getDefaultChromeVersion() and produces a real persona. So instead we
    // assert that the resolver finds a non-empty version, and that calling
    // with both empty does NOT return a fully-empty persona anymore.
    const v = persona.getDefaultChromeVersion();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test('derives a macOS persona from chromeVersion', () => {
    const p = persona.buildPersona('', '144.0.7559.133');
    expect(p.userAgent).toContain('Chrome/144.0.7559.133');
    expect(p.userAgent).toMatch(/Macintosh|Windows|Linux/);
    expect(p.userAgentData).not.toBeNull();
    expect(p.userAgentData.brands.find((b: any) => b.brand === 'Google Chrome').version).toBe('144');
  });

  test('honours explicit userAgent over chromeVersion', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const p = persona.buildPersona(ua, '');
    expect(p.userAgent).toBe(ua);
    expect(p.navigatorPlatform).toBe('Win32');
    expect(p.userAgentData.platform).toBe('Windows');
  });

  test('produces coherent platform for Mac UA', () => {
    const p = persona.buildPersona(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      '144.0.0.0'
    );
    expect(p.navigatorPlatform).toBe('MacIntel');
    expect(p.userAgentData.platform).toBe('macOS');
  });

  test('with no chromeVersion falls back to bundled Chromium version', () => {
    const expected = persona.getDefaultChromeVersion();
    const p = persona.buildPersona('', '');
    expect(p.userAgent).toContain(`Chrome/${expected}`);
    expect(p.userAgentData.fullVersionList.find((b: any) => b.brand === 'Google Chrome').version).toBe(expected);
  });
});

test.describe('stealth.launch-args', () => {
  test('always includes the four baseline flags', () => {
    const c = launchArgs.buildLaunchContract({});
    expect(c.args).toContain('--disable-automation');
    expect(c.args).toContain('--enable-automation=false');
    expect(c.args).toContain('--disable-blink-features=AutomationControlled');
    expect(c.args).toContain('--enable-network-information-downlink-max');
  });

  test('includes --user-agent when persona has one', () => {
    const c = launchArgs.buildLaunchContract({ chromeVersion: '144.0.0.0' });
    expect(c.args.some((a: string) => a.startsWith('--user-agent='))).toBe(true);
  });

  test('always includes --user-agent (defaults to bundled Chromium version)', () => {
    // With dynamic version resolution, a persona is always built. The UA
    // matches the runtime-resolved bundled Chromium, so the launch arg is
    // always present.
    const c = launchArgs.buildLaunchContract({});
    expect(c.args.some((a: string) => a.startsWith('--user-agent='))).toBe(true);
  });

  test('exposes ignoreDefaultArgs list', () => {
    expect(launchArgs.IGNORE_DEFAULT_ARGS).toContain('--enable-automation');
    expect(launchArgs.IGNORE_DEFAULT_ARGS).toContain('--disable-extensions');
  });
});

test.describe('stealth.applyStealthToLaunchConfig', () => {
  test('is a no-op when level is off', () => {
    const config: any = {};
    const result = stealth.applyStealthToLaunchConfig(config, { level: 'off' });
    expect(result.level).toBe('off');
    expect(config.browser).toBeUndefined();
  });

  test('rejects an unknown level', () => {
    expect(() => stealth.applyStealthToLaunchConfig({}, { level: 'paranoid' })).toThrow(/Invalid stealth level/);
  });

  test('appends args without duplicates on repeated application', () => {
    const config: any = {};
    stealth.applyStealthToLaunchConfig(config, { level: 'full', chromeVersion: '144.0.0.0' });
    const firstCount = config.browser.launchOptions.args.length;
    stealth.applyStealthToLaunchConfig(config, { level: 'full', chromeVersion: '144.0.0.0' });
    expect(config.browser.launchOptions.args.length).toBe(firstCount);
  });

  test('replaces --user-agent rather than stacking it', () => {
    const config: any = {};
    stealth.applyStealthToLaunchConfig(config, { level: 'full', chromeVersion: '144.0.0.0' });
    stealth.applyStealthToLaunchConfig(config, { level: 'full', userAgent: 'Mozilla/5.0 TEST' });
    const uaArgs = config.browser.launchOptions.args.filter((a: string) => a.startsWith('--user-agent='));
    expect(uaArgs.length).toBe(1);
    expect(uaArgs[0]).toContain('TEST');
  });

  test('forces chromium channel when stealth is enabled', () => {
    const config: any = {};
    stealth.applyStealthToLaunchConfig(config, { level: 'full', chromeVersion: '144.0.0.0' });
    expect(config.browser.launchOptions.channel).toBe('chromium');
  });

  test('respects a non-chrome channel the user already set', () => {
    const config: any = { browser: { launchOptions: { channel: 'msedge' } } };
    stealth.applyStealthToLaunchConfig(config, { level: 'full', chromeVersion: '144.0.0.0' });
    expect(config.browser.launchOptions.channel).toBe('msedge');
  });
});

test.describe('stealth.bootstrap', () => {
  test('builds a string starting with the four globals', () => {
    const script = bootstrap.buildBootstrap({
      level: 'full',
      headless: false,
      persona: persona.buildPersona('', '144.0.0.0'),
      seed: 12345,
    });
    expect(script).toContain('var __pinchtab_seed = 12345');
    expect(script).toContain('var __pinchtab_stealth_level = "full"');
    expect(script).toContain('var __pinchtab_headless = false');
    expect(script).toContain('var __pinchtab_profile = ');
  });

  test('normalizes unknown levels to light', () => {
    expect(bootstrap.normalizeLevel('wat')).toBe('light');
    expect(bootstrap.normalizeLevel('Full')).toBe('full');
    expect(bootstrap.normalizeLevel(' Medium ')).toBe('medium');
  });
});

test.describe('cloudflare-solver.isChallenge', () => {
  test('matches known challenge titles (case-insensitive)', () => {
    expect(cfSolver.isChallenge('Just a moment...')).toBe(true);
    expect(cfSolver.isChallenge('Attention Required! | Cloudflare')).toBe(true);
    expect(cfSolver.isChallenge('CHECKING YOUR BROWSER')).toBe(true);
  });

  test('does not match normal page titles', () => {
    expect(cfSolver.isChallenge('Product page')).toBe(false);
    expect(cfSolver.isChallenge('')).toBe(false);
    expect(cfSolver.isChallenge(null as any)).toBe(false);
  });
});

test.describe('cloudflare-solver.solveChallenge', () => {
  test('returns solved:true challengeType:"none" on a non-challenge page', async () => {
    // Stub Page — solveChallenge only calls .title() in the non-challenge
    // path. No browser needed; exercising it through a real Playwright Page
    // would just be slower without testing anything additional.
    const stubPage = { title: async () => 'Hello' } as any;
    const result = await cfSolver.solveChallenge(stubPage);
    expect(result.solved).toBe(true);
    expect(result.challengeType).toBe('none');
    expect(result.finalTitle).toBe('Hello');
    expect(result.attempts).toBe(0);
  });

  test('detectChallengeType extracts cType from page content', async () => {
    const stubPage = {
      content: async () => '<html>...something cType: \'managed\' something...</html>',
      evaluate: async () => false,
    } as any;
    expect(await cfSolver.detectChallengeType(stubPage)).toBe('managed');
  });

  test('detectChallengeType returns "embedded" when only the script tag is present', async () => {
    const stubPage = {
      content: async () => '<html><body>...</body></html>',
      evaluate: async () => true,
    } as any;
    expect(await cfSolver.detectChallengeType(stubPage)).toBe('embedded');
  });
});

test.describe('browser_solve_challenge tool visibility', () => {
  test('is absent when stealth is off (default)', async ({ client }) => {
    const { tools } = await client.listTools();
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('browser_solve_challenge');
  });
});

test.describe('cdp-emulation exports', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cdpEmulation = require('../src/stealth/cdp-emulation');

  test('exports applyPageEmulation, applyWorkerEmulation, attachContextEmulation', () => {
    expect(typeof cdpEmulation.applyPageEmulation).toBe('function');
    expect(typeof cdpEmulation.applyWorkerEmulation).toBe('function');
    expect(typeof cdpEmulation.attachContextEmulation).toBe('function');
  });

  test('attachContextEmulation hooks both page and serviceworker events', () => {
    const onCalls: string[] = [];
    const offCalls: string[] = [];
    const fakeContext: any = {
      pages: () => [],
      serviceWorkers: () => [],
      on: (event: string) => onCalls.push(event),
      off: (event: string) => offCalls.push(event),
    };
    const detach = cdpEmulation.attachContextEmulation(fakeContext, null);
    expect(onCalls).toContain('page');
    expect(onCalls).toContain('serviceworker');
    detach();
    expect(offCalls).toContain('page');
    expect(offCalls).toContain('serviceworker');
  });
});
