#!/usr/bin/env node
'use strict';

/**
 * Capture a real page's AXTree snapshot and save it as a test fixture.
 *
 * Usage:
 *   node tests/capture-snapshot.js <url> <output-name>
 *
 * Examples:
 *   node tests/capture-snapshot.js https://www.potterybarn.com/products/layton-rounded-ledge-bed/ potterybarn-bed
 *   node tests/capture-snapshot.js https://www.opendoor.com opendoor-home
 *   node tests/capture-snapshot.js https://www.amazon.com/dp/B0D1XD1ZV3 amazon-product
 *
 * Saves to: tests/fixtures/<output-name>.yaml
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.argv[2];
  const name = process.argv[3];

  if (!url || !name) {
    console.error('Usage: node tests/capture-snapshot.js <url> <output-name>');
    console.error('Example: node tests/capture-snapshot.js https://www.potterybarn.com potterybarn');
    process.exit(1);
  }

  const outFile = path.join(__dirname, 'fixtures', `${name}.yaml`);

  console.log(`Navigating to ${url}...`);
  const context = await chromium.launchPersistentContext('/tmp/snapshot-capture-profile', {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1366, height: 768 },
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for page to settle
  console.log('Waiting for page to settle...');
  await page.waitForTimeout(3000);

  // Capture the AXTree snapshot
  console.log('Capturing accessibility snapshot...');
  const snapshot = await page._snapshotForAI({ track: 'response' });

  const yaml = snapshot.full;
  const lineCount = yaml.split('\n').length;
  const charCount = yaml.length;
  const tokenEstimate = Math.round(charCount / 4);

  fs.writeFileSync(outFile, yaml, 'utf-8');

  console.log(`\nSaved to: ${outFile}`);
  console.log(`Lines: ${lineCount}`);
  console.log(`Characters: ${charCount}`);
  console.log(`Estimated tokens: ~${tokenEstimate}`);

  await context.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
