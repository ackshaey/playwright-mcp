#!/usr/bin/env node
'use strict';

/**
 * Model shootout: Test embedding models AND small LLMs for element matching.
 *
 * Run: node tests/model-shootout.js
 *
 * Tests:
 *   Embedding models: MiniLM, BGE-small, GTE-small (q8 + fp32)
 *   Small LLMs: SmolLM2-360M, Qwen2.5-0.5B (text generation for reasoning)
 */

const EMBEDDING_MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', label: 'MiniLM-L6 q8 (23MB)' },
  { id: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32', label: 'MiniLM-L6 fp32 (90MB)' },
  { id: 'Xenova/bge-small-en-v1.5', dtype: 'q8', label: 'BGE-small q8 (34MB)', prefix: 'Represent this sentence: ' },
  { id: 'Xenova/bge-small-en-v1.5', dtype: 'fp32', label: 'BGE-small fp32 (130MB)', prefix: 'Represent this sentence: ' },
  { id: 'Xenova/gte-small', dtype: 'q8', label: 'GTE-small q8 (26MB)' },
  { id: 'Xenova/gte-small', dtype: 'fp32', label: 'GTE-small fp32 (67MB)' },
];

const LLM_MODELS = [
  { id: 'onnx-community/SmolLM2-360M-Instruct', dtype: 'q4', label: 'SmolLM2-360M q4 (~250MB)' },
  { id: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q4', label: 'Qwen2.5-0.5B q4 (~350MB)' },
];

// Same elements and test cases from semantic-vs-heuristic.js
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

const TEST_CASES = [
  { intent: 'add to cart button', expected: 'e25', difficulty: 'easy' },
  { intent: 'king bed size option', expected: 'e13', difficulty: 'easy' },
  { intent: 'checkout button', expected: 'e30', difficulty: 'easy' },
  { intent: 'search box', expected: 'e4', difficulty: 'easy' },
  { intent: 'proceed to payment', expected: 'e42', difficulty: 'medium' },
  { intent: 'ivory fabric option', expected: 'e17', difficulty: 'medium' },
  { intent: 'dismiss the popup', expected: 'e45', difficulty: 'medium' },
  { intent: 'skip protection plan', expected: 'e29', difficulty: 'medium' },
  { intent: 'go to my shopping bag', expected: 'e31', difficulty: 'medium' },
  { intent: 'enter shipping zip code', expected: 'e40', difficulty: 'medium' },
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

function formatElement(el) {
  const parts = [];
  if (el.role) parts.push(el.role);
  if (el.name) parts.push(el.name);
  return parts.join(': ') || 'unknown';
}

async function testModel(modelConfig) {
  const { pipeline, env, cos_sim } = await import('@huggingface/transformers');
  env.cacheDir = './.cache/transformers';

  console.log(`\nLoading ${modelConfig.label}...`);
  const loadStart = Date.now();
  const extractor = await pipeline('feature-extraction', modelConfig.id, {
    dtype: modelConfig.dtype,
  });
  const loadMs = Date.now() - loadStart;
  console.log(`  Loaded in ${loadMs}ms`);

  // Prepare element descriptions
  const descriptions = PAGE_ELEMENTS.map(formatElement);

  let correct = 0;
  let totalMs = 0;
  const byDifficulty = { easy: { correct: 0, total: 0 }, medium: { correct: 0, total: 0 }, hard: { correct: 0, total: 0 } };
  const details = [];

  for (const tc of TEST_CASES) {
    const intentText = modelConfig.prefix ? modelConfig.prefix + tc.intent : tc.intent;
    const allTexts = [intentText, ...descriptions.map(d => modelConfig.prefix ? modelConfig.prefix + d : d)];

    const start = Date.now();
    const allEmbs = await extractor(allTexts, { pooling: 'mean', normalize: true });
    const elapsed = Date.now() - start;
    totalMs += elapsed;

    const allVecs = allEmbs.tolist();
    const intentVec = allVecs[0];

    const scored = allVecs.slice(1).map((vec, i) => ({
      ref: PAGE_ELEMENTS[i].ref,
      name: PAGE_ELEMENTS[i].name,
      role: PAGE_ELEMENTS[i].role,
      score: cos_sim(intentVec, vec),
    }));

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    const isCorrect = top.ref === tc.expected;
    if (isCorrect) { correct++; byDifficulty[tc.difficulty].correct++; }
    byDifficulty[tc.difficulty].total++;

    // Find rank of expected
    const expectedRank = scored.findIndex(s => s.ref === tc.expected) + 1;

    details.push({
      intent: tc.intent,
      difficulty: tc.difficulty,
      correct: isCorrect,
      topRef: top.ref,
      topName: top.name,
      topScore: (top.score * 100).toFixed(0),
      expectedRank,
    });
  }

  await extractor.dispose();

  return {
    label: modelConfig.label,
    correct,
    total: TEST_CASES.length,
    accuracy: (correct / TEST_CASES.length * 100).toFixed(0),
    loadMs,
    avgMs: (totalMs / TEST_CASES.length).toFixed(1),
    byDifficulty,
    details,
  };
}

// Small LLM test — uses text generation to reason about which element matches
async function testLLM(modelConfig) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = './.cache/transformers';

  console.log(`\nLoading ${modelConfig.label}...`);
  const loadStart = Date.now();
  const generator = await pipeline('text-generation', modelConfig.id, {
    dtype: modelConfig.dtype,
  });
  const loadMs = Date.now() - loadStart;
  console.log(`  Loaded in ${loadMs}ms`);

  let correct = 0;
  let totalMs = 0;
  const byDifficulty = { easy: { correct: 0, total: 0 }, medium: { correct: 0, total: 0 }, hard: { correct: 0, total: 0 } };
  const details = [];

  for (const tc of TEST_CASES) {
    // Build a compact element list for the prompt
    const elementList = PAGE_ELEMENTS.map(e => `${e.ref}: ${e.role} "${e.name}"`).join('\n');

    const messages = [
      { role: 'user', content: `Given these page elements:\n${elementList}\n\nWhich element best matches the intent: "${tc.intent}"?\nRespond with ONLY the ref ID (e.g. e25). Nothing else.` },
    ];

    const start = Date.now();
    let output;
    try {
      output = await generator(messages, {
        max_new_tokens: 10,
        do_sample: false,
        temperature: 0,
      });
    } catch (err) {
      // Some models may fail on specific inputs
      console.log(`    Skipping "${tc.intent}": ${err.message?.substring(0, 60)}`);
      byDifficulty[tc.difficulty].total++;
      details.push({ intent: tc.intent, difficulty: tc.difficulty, correct: false, topRef: 'ERR', topName: '', topScore: '0', expectedRank: -1 });
      continue;
    }
    const elapsed = Date.now() - start;
    totalMs += elapsed;

    // Extract the ref from the generated text
    const generated = output[0]?.generated_text;
    const assistantMsg = Array.isArray(generated)
      ? generated.find(m => m.role === 'assistant')?.content || ''
      : String(generated || '');

    const refMatch = assistantMsg.match(/\b(e\d+)\b/);
    const predictedRef = refMatch ? refMatch[1] : null;

    const isCorrect = predictedRef === tc.expected;
    if (isCorrect) { correct++; byDifficulty[tc.difficulty].correct++; }
    byDifficulty[tc.difficulty].total++;

    const matchedEl = PAGE_ELEMENTS.find(e => e.ref === predictedRef);
    details.push({
      intent: tc.intent,
      difficulty: tc.difficulty,
      correct: isCorrect,
      topRef: predictedRef || 'NONE',
      topName: matchedEl?.name || '???',
      topScore: '-',
      expectedRank: -1,
    });

    if (elapsed > 2000) {
      process.stdout.write(`    ${tc.intent}: ${elapsed}ms (${predictedRef} ${isCorrect ? '✓' : '✗'})\n`);
    }
  }

  await generator.dispose();

  return {
    label: modelConfig.label,
    correct,
    total: TEST_CASES.length,
    accuracy: (correct / TEST_CASES.length * 100).toFixed(0),
    loadMs,
    avgMs: (totalMs / TEST_CASES.length).toFixed(0),
    byDifficulty,
    details,
  };
}

// Heuristic baseline
function heuristicBaseline() {
  let correct = 0;
  const byDifficulty = { easy: { correct: 0, total: 0 }, medium: { correct: 0, total: 0 }, hard: { correct: 0, total: 0 } };

  for (const tc of TEST_CASES) {
    const intentWords = tc.intent.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    const scored = [];

    for (const node of PAGE_ELEMENTS) {
      let score = 0;
      const name = (node.name || '').toLowerCase();
      const role = (node.role || '').toLowerCase();
      for (const word of intentWords) {
        if (name.includes(word)) score += 30;
        if (role.includes(word)) score += 20;
      }
      const fullIntent = intentWords.join(' ');
      if (name === fullIntent) score += 50;
      const roleWords = intentWords.filter(w => role.includes(w));
      const nameWords = intentWords.filter(w => name.includes(w));
      if (roleWords.length > 0 && nameWords.length > 0) score += 25;
      if (score > 0) scored.push({ ref: node.ref, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const isCorrect = scored[0]?.ref === tc.expected;
    if (isCorrect) { correct++; byDifficulty[tc.difficulty].correct++; }
    byDifficulty[tc.difficulty].total++;
  }

  return {
    label: 'Heuristic (string)',
    correct,
    total: TEST_CASES.length,
    accuracy: (correct / TEST_CASES.length * 100).toFixed(0),
    loadMs: 0,
    avgMs: '0.1',
    byDifficulty,
  };
}

async function main() {
  console.log('Model Shootout: Element Matching Accuracy');
  console.log('==========================================');
  console.log(`${PAGE_ELEMENTS.length} elements, ${TEST_CASES.length} test intents\n`);

  const allResults = [];

  // Heuristic baseline
  allResults.push(heuristicBaseline());

  // Test embedding models
  console.log('\n--- Embedding Models ---');
  for (const model of EMBEDDING_MODELS) {
    try {
      const result = await testModel(model);
      allResults.push(result);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      allResults.push({ label: model.label, correct: 0, total: 20, accuracy: '0', loadMs: 0, avgMs: 'ERR', byDifficulty: { easy: { correct: 0, total: 4 }, medium: { correct: 0, total: 6 }, hard: { correct: 0, total: 10 } } });
    }
  }

  // Test small LLMs
  console.log('\n--- Small LLMs ---');
  for (const model of LLM_MODELS) {
    try {
      const result = await testLLM(model);
      allResults.push(result);
    } catch (err) {
      console.log(`  ERROR loading ${model.label}: ${err.message}`);
      allResults.push({ label: model.label, correct: 0, total: 20, accuracy: '0', loadMs: 0, avgMs: 'ERR', byDifficulty: { easy: { correct: 0, total: 4 }, medium: { correct: 0, total: 6 }, hard: { correct: 0, total: 10 } } });
    }
  }

  // Summary table
  console.log('\n\n' + '='.repeat(100));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(100) + '\n');

  const col = 22;
  console.log(
    'Model'.padEnd(col),
    'Accuracy'.padEnd(10),
    'Easy'.padEnd(8),
    'Medium'.padEnd(8),
    'Hard'.padEnd(8),
    'Load'.padEnd(10),
    'Avg/query'.padEnd(10),
  );
  console.log('-'.repeat(88));

  for (const r of allResults) {
    const easy = `${r.byDifficulty.easy.correct}/${r.byDifficulty.easy.total}`;
    const med = `${r.byDifficulty.medium.correct}/${r.byDifficulty.medium.total}`;
    const hard = `${r.byDifficulty.hard.correct}/${r.byDifficulty.hard.total}`;
    console.log(
      r.label.padEnd(col),
      `${r.accuracy}%`.padEnd(10),
      easy.padEnd(8),
      med.padEnd(8),
      hard.padEnd(8),
      `${r.loadMs}ms`.padEnd(10),
      `${r.avgMs}ms`.padEnd(10),
    );
  }

  // Show per-case breakdown for the best model
  const bestModel = allResults.slice(1).sort((a, b) => b.correct - a.correct)[0];
  if (bestModel?.details) {
    console.log(`\nBest model (${bestModel.label}) — per-case breakdown:`);
    console.log('-'.repeat(88));
    for (const d of bestModel.details) {
      const mark = d.correct ? '✓' : `✗ (got ${d.topRef} "${d.topName}", expected rank #${d.expectedRank})`;
      console.log(`  [${d.difficulty[0].toUpperCase()}] ${d.intent.padEnd(38)} ${mark}`);
    }
  }
}

main().catch(console.error);
