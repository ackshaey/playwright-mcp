#!/usr/bin/env node
'use strict';

/**
 * Direct comparison: semantic matching vs heuristic matching.
 *
 * Feeds the same intents + elements to both approaches and compares:
 * - Which element each picks as #1
 * - Score distribution
 * - Accuracy against known correct answers
 * - Latency
 *
 * Run: node tests/semantic-vs-heuristic.js
 */

const { semanticMatch, preload } = require('../src/semantic-matcher');

// Simulated AXTree elements from a complex e-commerce page (Pottery Barn style)
const PAGE_ELEMENTS = [
  { ref: 'e1', role: 'link', name: 'Home' },
  { ref: 'e2', role: 'link', name: 'Living' },
  { ref: 'e3', role: 'link', name: 'Bedroom' },
  { ref: 'e4', role: 'searchbox', name: 'Search' },
  { ref: 'e5', role: 'button', name: 'Search' },
  { ref: 'e6', role: 'link', name: 'Sign In' },
  { ref: 'e7', role: 'link', name: 'Cart (3)' },
  { ref: 'e8', role: 'heading', name: 'Layton Upholstered Rounded Ledge Bed' },
  { ref: 'e9', role: 'img', name: 'Performance Boucle Ivory, King' },
  { ref: 'e10', role: 'button', name: 'Size Full Bed' },
  { ref: 'e11', role: 'radio', name: 'Full Bed' },
  { ref: 'e12', role: 'radio', name: 'Queen Bed' },
  { ref: 'e13', role: 'radio', name: 'King Bed' },
  { ref: 'e14', role: 'radio', name: 'California King Bed' },
  { ref: 'e15', role: 'button', name: 'Fabric and Color' },
  { ref: 'e16', role: 'radio', name: 'Oatmeal Performance Textured Chenille' },
  { ref: 'e17', role: 'radio', name: 'Ivory Performance Boucle' },
  { ref: 'e18', role: 'radio', name: 'Oat Performance Boucle' },
  { ref: 'e19', role: 'radio', name: 'Charcoal Performance Boucle' },
  { ref: 'e20', role: 'img', name: 'Ivory swatch' },
  { ref: 'e21', role: 'link', name: 'View fabric details' },
  { ref: 'e22', role: 'heading', name: 'Your Selections' },
  { ref: 'e23', role: 'radio', name: 'White Glove Delivery' },
  { ref: 'e24', role: 'radio', name: 'Doorstep Delivery' },
  { ref: 'e25', role: 'button', name: 'ADD TO CART' },
  { ref: 'e26', role: 'button', name: 'Add to Registry' },
  { ref: 'e27', role: 'link', name: 'Shipping & Returns' },
  { ref: 'e28', role: 'button', name: 'Accept' },
  { ref: 'e29', role: 'button', name: 'No Thanks' },
  { ref: 'e30', role: 'link', name: 'CHECKOUT' },
  { ref: 'e31', role: 'link', name: 'VIEW CART' },
  { ref: 'e32', role: 'button', name: 'Continue Shopping' },
  { ref: 'e33', role: 'button', name: 'Guest Checkout' },
  { ref: 'e34', role: 'textbox', name: 'Email Address' },
  { ref: 'e35', role: 'textbox', name: 'Full Name' },
  { ref: 'e36', role: 'combobox', name: 'Street Address' },
  { ref: 'e37', role: 'textbox', name: 'Apt, Suite, Unit' },
  { ref: 'e38', role: 'textbox', name: 'City' },
  { ref: 'e39', role: 'combobox', name: 'State' },
  { ref: 'e40', role: 'textbox', name: 'ZIP Code' },
  { ref: 'e41', role: 'textbox', name: 'Phone Number' },
  { ref: 'e42', role: 'button', name: 'Continue to Payment' },
  { ref: 'e43', role: 'link', name: 'Privacy Policy' },
  { ref: 'e44', role: 'link', name: 'Terms of Use' },
  { ref: 'e45', role: 'button', name: 'Close dialog' },
  { ref: 'e46', role: 'heading', name: 'Review Your Selection' },
  { ref: 'e47', role: 'checkbox', name: 'I acknowledge the measuring guidelines' },
  { ref: 'e48', role: 'link', name: 'Apply Coupon Code' },
  { ref: 'e49', role: 'button', name: 'Remove item' },
  { ref: 'e50', role: 'heading', name: 'Allstate Protection Plan' },
];

// Test cases: intent → expected correct ref
const TEST_CASES = [
  // Easy: exact or near-exact matches
  { intent: 'add to cart button', expected: 'e25', difficulty: 'easy' },
  { intent: 'king bed size option', expected: 'e13', difficulty: 'easy' },
  { intent: 'checkout button', expected: 'e30', difficulty: 'easy' },
  { intent: 'search box', expected: 'e4', difficulty: 'easy' },

  // Medium: requires semantic understanding
  { intent: 'proceed to payment', expected: 'e42', difficulty: 'medium' },
  { intent: 'ivory fabric option', expected: 'e17', difficulty: 'medium' },
  { intent: 'dismiss the popup', expected: 'e45', difficulty: 'medium' },
  { intent: 'skip protection plan', expected: 'e29', difficulty: 'medium' },
  { intent: 'go to my shopping bag', expected: 'e31', difficulty: 'medium' },
  { intent: 'enter shipping zip code', expected: 'e40', difficulty: 'medium' },

  // Hard: requires inference / disambiguation
  { intent: 'accept the custom order policy', expected: 'e28', difficulty: 'hard' },
  { intent: 'select the biggest bed size', expected: 'e14', difficulty: 'hard' },
  { intent: 'white colored boucle fabric', expected: 'e17', difficulty: 'hard' },
  { intent: 'continue without signing in', expected: 'e33', difficulty: 'hard' },
  { intent: 'apartment number field', expected: 'e37', difficulty: 'hard' },
  { intent: 'acknowledge measurement guidelines', expected: 'e47', difficulty: 'hard' },
  { intent: 'finish purchasing', expected: 'e42', difficulty: 'hard' },
  { intent: 'remove from bag', expected: 'e49', difficulty: 'hard' },
  { intent: 'delivery preferences', expected: 'e23', difficulty: 'hard' },
  { intent: 'close the modal', expected: 'e45', difficulty: 'hard' },
];

// Heuristic matching (same as enhanced-backend.js)
function heuristicFind(intent, elements, maxResults = 5) {
  const intentWords = intent.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const scored = [];

  for (const node of elements) {
    let score = 0;
    const name = (node.name || '').toLowerCase();
    const role = (node.role || '').toLowerCase();

    for (const word of intentWords) {
      if (name.includes(word)) score += 30;
      if (role.includes(word)) score += 20;
    }

    const fullIntent = intentWords.join(' ');
    if (name === fullIntent) score += 50;

    const roleMatchedWords = intentWords.filter(w => role.includes(w));
    const nameMatchedWords = intentWords.filter(w => name.includes(w));
    if (roleMatchedWords.length > 0 && nameMatchedWords.length > 0) {
      score += 25;
    }

    if (score > 0) {
      scored.push({ ref: node.ref, role: node.role, name: node.name, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

async function main() {
  console.log('Semantic vs Heuristic Element Matching');
  console.log('======================================\n');
  console.log(`Elements: ${PAGE_ELEMENTS.length}`);
  console.log(`Test cases: ${TEST_CASES.length}\n`);

  // Preload ML model
  console.log('Loading ML model (all-MiniLM-L6-v2 q8)...');
  const modelStart = Date.now();
  await preload();
  console.log(`Model loaded in ${Date.now() - modelStart}ms\n`);

  let heuristicCorrect = 0;
  let semanticCorrect = 0;
  let heuristicTotalMs = 0;
  let semanticTotalMs = 0;

  const results = { easy: { h: 0, s: 0, total: 0 }, medium: { h: 0, s: 0, total: 0 }, hard: { h: 0, s: 0, total: 0 } };

  console.log('Intent'.padEnd(42), 'Expected'.padEnd(14), 'Heuristic'.padEnd(20), 'Semantic'.padEnd(20), 'Diff'.padEnd(8));
  console.log('-'.repeat(104));

  for (const tc of TEST_CASES) {
    const expectedEl = PAGE_ELEMENTS.find(e => e.ref === tc.expected);
    const expectedLabel = `${expectedEl.role}:"${expectedEl.name}"`.substring(0, 12);

    // Heuristic
    const hStart = Date.now();
    const hResults = heuristicFind(tc.intent, PAGE_ELEMENTS);
    heuristicTotalMs += Date.now() - hStart;
    const hTop = hResults[0];
    const hCorrect = hTop?.ref === tc.expected;
    if (hCorrect) { heuristicCorrect++; results[tc.difficulty].h++; }

    // Semantic
    const sStart = Date.now();
    const sResults = await semanticMatch(tc.intent, PAGE_ELEMENTS, { topK: 5, minScore: 0.2 });
    semanticTotalMs += Date.now() - sStart;
    const sTop = sResults[0];
    const sCorrect = sTop?.element.ref === tc.expected;
    if (sCorrect) { semanticCorrect++; results[tc.difficulty].s++; }

    results[tc.difficulty].total++;

    const hLabel = hTop ? `${hTop.ref} (${hTop.score})` : 'NONE';
    const sLabel = sTop ? `${sTop.element.ref} (${Math.round(sTop.score * 100)})` : 'NONE';
    const hMark = hCorrect ? '✓' : '✗';
    const sMark = sCorrect ? '✓' : '✗';
    const winner = hCorrect === sCorrect ? '  tie' : (sCorrect ? ' +SEM' : ' +HEU');

    console.log(
      `[${tc.difficulty[0].toUpperCase()}] ${tc.intent}`.padEnd(42),
      expectedLabel.padEnd(14),
      `${hMark} ${hLabel}`.padEnd(20),
      `${sMark} ${sLabel}`.padEnd(20),
      winner
    );
  }

  console.log('\n' + '='.repeat(104));
  console.log('\nAccuracy:');
  console.log(`  Heuristic: ${heuristicCorrect}/${TEST_CASES.length} (${(heuristicCorrect / TEST_CASES.length * 100).toFixed(0)}%)`);
  console.log(`  Semantic:  ${semanticCorrect}/${TEST_CASES.length} (${(semanticCorrect / TEST_CASES.length * 100).toFixed(0)}%)`);

  console.log('\nBy difficulty:');
  for (const [diff, r] of Object.entries(results)) {
    console.log(`  ${diff.padEnd(8)}: Heuristic ${r.h}/${r.total}, Semantic ${r.s}/${r.total}`);
  }

  console.log('\nLatency:');
  console.log(`  Heuristic total: ${heuristicTotalMs}ms (${(heuristicTotalMs / TEST_CASES.length).toFixed(1)}ms avg)`);
  console.log(`  Semantic total:  ${semanticTotalMs}ms (${(semanticTotalMs / TEST_CASES.length).toFixed(1)}ms avg)`);

  const improvement = semanticCorrect - heuristicCorrect;
  console.log(`\nVerdict: Semantic is ${improvement > 0 ? 'better' : improvement < 0 ? 'worse' : 'equal'} by ${Math.abs(improvement)} cases`);
}

main().catch(console.error);
