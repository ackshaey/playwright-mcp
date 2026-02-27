#!/usr/bin/env node
'use strict';

/**
 * Benchmark smart snapshot pruning on saved fixture files.
 * Zero tokens, instant iteration.
 *
 * Usage:
 *   node tests/benchmark-pruning.js                    # Run all fixtures
 *   node tests/benchmark-pruning.js potterybarn-bed    # Run specific fixture
 *
 * First capture fixtures with:
 *   node tests/capture-snapshot.js <url> <name>
 */

const fs = require('fs');
const path = require('path');
const { smartSnapshot, parseSnapshot, pruneTree, flattenToLines, isJunkNode, isJunkContainer } = require('../src/smart-snapshot');
const { flattenNodes } = require('../src/query-resolver');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function estimateTokens(text) {
  return Math.round(text.length / 4);
}

function analyzeFixture(name, yaml) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Fixture: ${name}`);
  console.log(`${'='.repeat(70)}`);

  const rawLines = yaml.split('\n').length;
  const rawTokens = estimateTokens(yaml);

  // Parse
  const nodes = parseSnapshot(yaml);
  const allNodes = flattenNodes(nodes);
  const refNodes = allNodes.filter(n => n.ref);

  // Count junk
  let junkContainers = 0;
  let junkNodes = 0;
  const junkDetails = [];
  function countJunk(nodeList) {
    for (const node of nodeList) {
      if (isJunkContainer(node)) {
        junkContainers++;
        const childCount = flattenNodes([node]).length;
        junkDetails.push(`  [container] ${node.role} "${node.name || ''}" (${childCount} descendants dropped)`);
      } else if (isJunkNode(node)) {
        junkNodes++;
        junkDetails.push(`  [node] ${node.role} "${node.name || ''}"`);
      }
      if (node.children) countJunk(node.children);
    }
  }
  countJunk(allNodes);

  // Prune
  const pruned = pruneTree(nodes);
  const prunedFlat = flattenNodes(pruned);

  // Flatten
  const lines = flattenToLines(pruned);
  const smartText = smartSnapshot(yaml);
  const smartLines = smartText.split('\n').length;
  const smartTokens = estimateTokens(smartText);

  // Stats
  console.log('\nRaw AXTree:');
  console.log(`  Lines: ${rawLines}`);
  console.log(`  Tokens: ~${rawTokens}`);
  console.log(`  Total nodes: ${allNodes.length}`);
  console.log(`  Nodes with refs: ${refNodes.length}`);

  console.log('\nJunk filtered:');
  console.log(`  Junk containers: ${junkContainers}`);
  console.log(`  Junk nodes: ${junkNodes}`);
  if (junkDetails.length > 0) {
    console.log('  Details:');
    junkDetails.slice(0, 15).forEach(d => console.log(d));
    if (junkDetails.length > 15) console.log(`  ... and ${junkDetails.length - 15} more`);
  }

  console.log('\nAfter pruning:');
  console.log(`  Nodes: ${prunedFlat.length} (${allNodes.length - prunedFlat.length} removed)`);

  console.log('\nSmart Snapshot output:');
  console.log(`  Lines: ${smartLines}`);
  console.log(`  Tokens: ~${smartTokens}`);
  const wasTruncated = smartText.includes('truncated');
  if (wasTruncated) console.log(`  (truncated at 80 lines)`);

  const reduction = ((rawTokens - smartTokens) / rawTokens * 100).toFixed(1);
  console.log(`\n  TOKEN REDUCTION: ${reduction}% (${rawTokens} → ${smartTokens})`);
  console.log(`  RATIO: ${(rawTokens / smartTokens).toFixed(1)}x smaller`);

  // Show preview of output
  console.log('\nSmart Snapshot preview (first 20 lines):');
  console.log('-'.repeat(60));
  smartText.split('\n').slice(0, 20).forEach(l => console.log(`  ${l}`));
  if (smartLines > 20) console.log(`  ... (${smartLines - 20} more lines)`);

  // Role distribution
  const roleCounts = {};
  for (const node of prunedFlat) {
    roleCounts[node.role] = (roleCounts[node.role] || 0) + 1;
  }
  const topRoles = Object.entries(roleCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\nTop roles after pruning:');
  topRoles.forEach(([role, count]) => console.log(`  ${role}: ${count}`));

  return { name, rawTokens, smartTokens, reduction: parseFloat(reduction), rawLines, smartLines, allNodes: allNodes.length, prunedNodes: prunedFlat.length, junkContainers, junkNodes };
}

function main() {
  const specificFixture = process.argv[2];

  if (!fs.existsSync(FIXTURES_DIR)) {
    console.error(`No fixtures directory at ${FIXTURES_DIR}`);
    console.error('Capture fixtures first: node tests/capture-snapshot.js <url> <name>');
    process.exit(1);
  }

  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.yaml'));

  if (files.length === 0) {
    console.error('No fixture files found. Capture some first:');
    console.error('  node tests/capture-snapshot.js https://www.potterybarn.com/products/layton-rounded-ledge-bed/ potterybarn-bed');
    process.exit(1);
  }

  const fixtures = specificFixture
    ? files.filter(f => f.includes(specificFixture))
    : files;

  if (fixtures.length === 0) {
    console.error(`No fixture matching "${specificFixture}". Available: ${files.join(', ')}`);
    process.exit(1);
  }

  console.log(`Benchmarking ${fixtures.length} fixture(s)...\n`);

  const results = [];
  for (const file of fixtures) {
    const yaml = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    const name = file.replace('.yaml', '');
    results.push(analyzeFixture(name, yaml));
  }

  // Summary table
  if (results.length > 1) {
    console.log(`\n\n${'='.repeat(70)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(70)}\n`);

    const col = 22;
    console.log(
      'Fixture'.padEnd(col),
      'Raw tokens'.padEnd(12),
      'Smart tokens'.padEnd(14),
      'Reduction'.padEnd(12),
      'Ratio'.padEnd(8),
      'Junk dropped'.padEnd(14),
    );
    console.log('-'.repeat(82));

    for (const r of results) {
      console.log(
        r.name.padEnd(col),
        `~${r.rawTokens}`.padEnd(12),
        `~${r.smartTokens}`.padEnd(14),
        `${r.reduction}%`.padEnd(12),
        `${(r.rawTokens / r.smartTokens).toFixed(1)}x`.padEnd(8),
        `${r.junkContainers + r.junkNodes}`.padEnd(14),
      );
    }
  }
}

main();
