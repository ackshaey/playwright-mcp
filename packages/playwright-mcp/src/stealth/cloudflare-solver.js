'use strict';

/**
 * Cloudflare challenge solver. Ported from
 * pinchtab/internal/autosolver/solvers/cloudflare.go.
 *
 * Handles the three Turnstile challenge modes — non-interactive, managed, and
 * interactive. Non-interactive resolves itself by waiting for the page title
 * to change; managed and interactive need a click on the widget checkbox.
 *
 * The click goes through Playwright's page.mouse.click which drives CDP
 * Input.dispatchMouseEvent — the same surface Cloudflare is validating
 * against, so a real mouse-trusted event is delivered rather than a synthetic
 * MouseEvent.
 *
 * Limitation: aggressive Turnstile deployments may require a scored behavior
 * profile we don't emulate yet (mouse movement, timing, etc.). For those we
 * fall back to returning { solved: false } and callers can route to a paid
 * solver or ask a human.
 */

const CHALLENGE_TITLES = [
  'just a moment',
  'attention required',
  'checking your browser',
];

const TURNSTILE_IFRAME_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com/cdn-cgi/challenge-platform"]',
  'iframe[src*="challenges.cloudflare.com"]',
];

const TURNSTILE_CONTAINER_SELECTORS = [
  '#cf_turnstile div',
  '#cf-turnstile div',
  '.turnstile>div>div',
  '.main-content p+div>div>div',
];

/**
 * Detect whether the page title looks like a Cloudflare challenge screen.
 */
function isChallenge(title) {
  if (!title) return false;
  const lower = String(title).toLowerCase();
  return CHALLENGE_TITLES.some(t => lower.includes(t));
}

/**
 * Classify the Turnstile challenge variant by inspecting the page source.
 * Returns 'non-interactive' | 'managed' | 'interactive' | 'embedded' | ''.
 */
async function detectChallengeType(page) {
  const content = await page.content().catch(() => '');

  for (const cType of ['non-interactive', 'managed', 'interactive']) {
    if (content.includes(`cType: '${cType}'`)) return cType;
  }

  const hasEmbedded = await page.evaluate(() => {
    return !!document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v"]');
  }).catch(() => false);

  return hasEmbedded ? 'embedded' : '';
}

/**
 * Locate the Turnstile widget bounding box. Returns { x, y, width, height }
 * or null if not found.
 */
async function findTurnstileBox(page) {
  const result = await page.evaluate(({ iframeSelectors, containerSelectors }) => {
    for (const sel of iframeSelectors) {
      const iframe = document.querySelector(sel);
      if (iframe) {
        const r = iframe.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
    }
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
    }
    return null;
  }, {
    iframeSelectors: TURNSTILE_IFRAME_SELECTORS,
    containerSelectors: TURNSTILE_CONTAINER_SELECTORS,
  }).catch(() => null);

  return result;
}

/**
 * Poll page.title() every 500ms until the title no longer matches a
 * challenge pattern, or the timeout expires.
 */
async function pollForResolution(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!isChallenge(title)) {
      // Give the page a beat to settle — CF often navigates shortly after
      // clearing the challenge.
      await sleep(1000);
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * Wait for the "Verifying you are human..." spinner to complete, up to
 * timeoutMs. Returns once the spinner text is gone or timeout elapses.
 */
async function waitForSpinner(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!text.includes('Verifying you are human')) return;
    await sleep(500);
  }
}

/**
 * Attempt to solve the current Cloudflare challenge, if any.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.nonInteractiveTimeoutMs=15000]
 * @param {number} [options.interactiveTimeoutMs=15000]
 * @param {number} [options.spinnerTimeoutMs=10000]
 * @returns {Promise<{ solved: boolean, challengeType: string, attempts: number, finalTitle: string, reason?: string }>}
 */
async function solveChallenge(page, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const nonInteractiveTimeoutMs = options.nonInteractiveTimeoutMs ?? 15000;
  const interactiveTimeoutMs = options.interactiveTimeoutMs ?? 15000;
  const spinnerTimeoutMs = options.spinnerTimeoutMs ?? 10000;

  const initialTitle = await page.title().catch(() => '');

  if (!isChallenge(initialTitle)) {
    return {
      solved: true,
      challengeType: 'none',
      attempts: 0,
      finalTitle: initialTitle,
    };
  }

  const challengeType = await detectChallengeType(page);

  if (challengeType === 'non-interactive') {
    const resolved = await pollForResolution(page, nonInteractiveTimeoutMs);
    return {
      solved: resolved,
      challengeType,
      attempts: 0,
      finalTitle: await page.title().catch(() => ''),
      reason: resolved ? undefined : 'non-interactive challenge did not resolve within timeout',
    };
  }

  // Interactive / managed / embedded / unknown — try to click the checkbox.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await waitForSpinner(page, spinnerTimeoutMs);

    const box = await findTurnstileBox(page);
    if (!box) {
      // Challenge may have resolved while we were looking.
      const title = await page.title().catch(() => '');
      if (!isChallenge(title)) {
        return {
          solved: true,
          challengeType,
          attempts: attempt + 1,
          finalTitle: title,
        };
      }
      await sleep(1000);
      continue;
    }

    // The checkbox sits in the left portion of the Turnstile widget. The
    // 9%/40% coordinates match PinchTab's empirical offsets (cloudflare.go).
    const clickX = box.x + box.width * 0.09;
    const clickY = box.y + box.height * 0.40;

    // Surface click errors (parity with Go cloudflare.go:74-76) — a broken
    // page or detached frame is diagnostic, not a thing to silently retry.
    await page.mouse.click(clickX, clickY);

    if (await pollForResolution(page, interactiveTimeoutMs)) {
      return {
        solved: true,
        challengeType,
        attempts: attempt + 1,
        finalTitle: await page.title().catch(() => ''),
      };
    }
  }

  const finalTitle = await page.title().catch(() => '');
  return {
    solved: !isChallenge(finalTitle),
    challengeType,
    attempts: maxAttempts,
    finalTitle,
    reason: isChallenge(finalTitle)
      ? 'challenge still present after max attempts'
      : undefined,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  isChallenge,
  detectChallengeType,
  findTurnstileBox,
  solveChallenge,
};
