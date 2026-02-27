/**
 * Unit tests for smart-snapshot.js — AXTree parser, pruner, flattener.
 * These do NOT require a browser; they test pure string transformation logic.
 */

import { test, expect } from '@playwright/test';

const {
  parseLine,
  parseSnapshot,
  pruneTree,
  flattenToLines,
  smartSnapshot,
} = require('../src/smart-snapshot');

test.describe('parseLine', () => {
  test('parses role and name with ref', () => {
    const node = parseLine('button "Submit" [ref=e5]');
    expect(node.role).toBe('button');
    expect(node.name).toBe('Submit');
    expect(node.ref).toBe('e5');
  });

  test('parses role with attributes and inline text', () => {
    const node = parseLine('generic [active] [ref=e1]: Hello, world!');
    expect(node.role).toBe('generic');
    expect(node.ref).toBe('e1');
    expect(node.attributes).toContain('active');
    expect(node.inlineText).toBe('Hello, world!');
  });

  test('parses container role with colon', () => {
    const node = parseLine('navigation:');
    expect(node.role).toBe('navigation');
    expect(node.hasChildren).toBe(true);
  });

  test('parses heading with ref', () => {
    const node = parseLine('heading "Welcome" [ref=e2]');
    expect(node.role).toBe('heading');
    expect(node.name).toBe('Welcome');
    expect(node.ref).toBe('e2');
  });

  test('parses textbox with value', () => {
    const node = parseLine('textbox "Email" [ref=e3]: user@example.com');
    expect(node.role).toBe('textbox');
    expect(node.name).toBe('Email');
    expect(node.ref).toBe('e3');
    expect(node.inlineText).toBe('user@example.com');
  });

  test('parses iframe ref format', () => {
    const node = parseLine('button "Inner" [ref=f1e1]');
    expect(node.ref).toBe('f1e1');
  });

  test('parses multiple attributes', () => {
    const node = parseLine('checkbox "Accept" [checked] [ref=e7]');
    expect(node.role).toBe('checkbox');
    expect(node.name).toBe('Accept');
    expect(node.ref).toBe('e7');
    expect(node.attributes).toContain('checked');
  });

  test('handles role-only line', () => {
    const node = parseLine('separator');
    expect(node.role).toBe('separator');
    expect(node.name).toBeNull();
    expect(node.ref).toBeNull();
  });
});

test.describe('parseSnapshot', () => {
  test('parses flat list', () => {
    const yaml = '- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]';
    const nodes = parseSnapshot(yaml);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].role).toBe('button');
    expect(nodes[0].ref).toBe('e1');
    expect(nodes[1].role).toBe('textbox');
    expect(nodes[1].ref).toBe('e2');
  });

  test('parses nested structure', () => {
    const yaml = [
      '- navigation:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].role).toBe('navigation');
    expect(nodes[0].children).toHaveLength(2);
    expect(nodes[0].children[0].role).toBe('link');
    expect(nodes[0].children[0].name).toBe('Home');
  });

  test('parses deeply nested structure', () => {
    const yaml = [
      '- generic:',
      '  - generic:',
      '    - button "Submit" [ref=e1]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children[0].children).toHaveLength(1);
    expect(nodes[0].children[0].children[0].role).toBe('button');
  });

  test('returns empty array for empty input', () => {
    expect(parseSnapshot('')).toEqual([]);
    expect(parseSnapshot(null)).toEqual([]);
    expect(parseSnapshot(undefined)).toEqual([]);
  });

  test('handles mixed nesting levels', () => {
    const yaml = [
      '- heading "Title" [ref=e1]',
      '- navigation:',
      '  - link "Home" [ref=e2]',
      '- button "Submit" [ref=e3]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].role).toBe('heading');
    expect(nodes[1].role).toBe('navigation');
    expect(nodes[1].children).toHaveLength(1);
    expect(nodes[2].role).toBe('button');
  });
});

test.describe('pruneTree', () => {
  test('removes generic containers, lifts children', () => {
    const yaml = [
      '- generic:',
      '  - button "Submit" [ref=e1]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].role).toBe('button');
    expect(pruned[0].name).toBe('Submit');
  });

  test('removes deeply nested generic containers', () => {
    const yaml = [
      '- generic:',
      '  - generic:',
      '    - generic:',
      '      - button "Submit" [ref=e1]',
      '      - textbox "Email" [ref=e2]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(2);
    expect(pruned[0].role).toBe('button');
    expect(pruned[1].role).toBe('textbox');
  });

  test('keeps interactive elements', () => {
    const yaml = [
      '- button "Submit" [ref=e1]',
      '- textbox "Email" [ref=e2]',
      '- link "Home" [ref=e3]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(3);
  });

  test('keeps landmark roles with content', () => {
    const yaml = [
      '- navigation:',
      '  - link "Home" [ref=e1]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].role).toBe('navigation');
    expect(pruned[0].children).toHaveLength(1);
  });

  test('removes empty landmark roles', () => {
    const yaml = '- navigation:';
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(0);
  });

  test('keeps heading elements', () => {
    const yaml = '- heading "Welcome" [ref=e1]';
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].role).toBe('heading');
  });

  test('keeps elements with refs regardless of role', () => {
    const yaml = '- generic [ref=e1]: Important content';
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].ref).toBe('e1');
  });
});

test.describe('flattenToLines', () => {
  test('formats element with ref', () => {
    const nodes = parseSnapshot('- button "Submit" [ref=e1]');
    const pruned = pruneTree(nodes);
    const lines = flattenToLines(pruned);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[ref=e1] button "Submit"');
  });

  test('indents children of landmarks', () => {
    const yaml = [
      '- navigation:',
      '  - link "Home" [ref=e1]',
    ].join('\n');
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    const lines = flattenToLines(pruned);
    expect(lines[0]).toBe('navigation:');
    expect(lines[1]).toBe('  [ref=e1] link "Home"');
  });

  test('includes attributes', () => {
    const yaml = '- checkbox "Accept" [checked] [ref=e1]';
    const nodes = parseSnapshot(yaml);
    const pruned = pruneTree(nodes);
    const lines = flattenToLines(pruned);
    expect(lines[0]).toContain('[checked]');
  });
});

test.describe('smartSnapshot (end-to-end)', () => {
  test('prunes and flattens a realistic page', () => {
    const yaml = [
      '- generic [active] [ref=e1]: Hello',
      '- heading "Welcome to Our Store" [ref=e2]',
      '- generic:',
      '  - generic:',
      '    - navigation:',
      '      - link "Home" [ref=e3]',
      '      - link "Products" [ref=e4]',
      '      - link "About" [ref=e5]',
      '  - generic:',
      '    - generic:',
      '      - textbox "Search products..." [ref=e6]',
      '      - button "Search" [ref=e7]',
      '- generic:',
      '  - generic:',
      '    - heading "Featured Items" [ref=e8]',
      '    - list:',
      '      - listitem:',
      '        - link "Summer Sale" [ref=e9]',
      '      - listitem:',
      '        - link "New Arrivals" [ref=e10]',
      '- generic:',
      '  - link "Privacy Policy" [ref=e11]',
    ].join('\n');

    const result = smartSnapshot(yaml);

    // Should contain all interactive/semantic elements
    expect(result).toContain('[ref=e2] heading "Welcome to Our Store"');
    expect(result).toContain('[ref=e3] link "Home"');
    expect(result).toContain('[ref=e6] textbox "Search products..."');
    expect(result).toContain('[ref=e7] button "Search"');
    expect(result).toContain('[ref=e9] link "Summer Sale"');
    // Privacy Policy should be filtered out as footer junk
    expect(result).not.toContain('Privacy Policy');

    // Should NOT contain raw 'generic:' container lines
    const lines = result.split('\n');
    const genericLines = lines.filter(l => l.trim() === 'generic:');
    expect(genericLines).toHaveLength(0);

    // Should be significantly shorter than input
    expect(result.length).toBeLessThan(yaml.length);
  });

  test('handles empty input', () => {
    expect(smartSnapshot('')).toBe('');
    expect(smartSnapshot(null)).toBe('');
  });

  test('preserves navigation container', () => {
    const yaml = [
      '- navigation:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    expect(result).toContain('navigation:');
    expect(result).toContain('[ref=e1] link "Home"');
    expect(result).toContain('[ref=e2] link "About"');
  });

  test('drops footer (contentinfo) entirely', () => {
    const yaml = [
      '- main:',
      '  - button "Submit" [ref=e1]',
      '- contentinfo:',
      '  - link "Privacy Policy" [ref=e2]',
      '  - link "Terms of Use" [ref=e3]',
      '  - link "Site Map" [ref=e4]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    expect(result).toContain('[ref=e1] button "Submit"');
    expect(result).not.toContain('Privacy Policy');
    expect(result).not.toContain('Terms of Use');
    expect(result).not.toContain('Site Map');
  });

  test('drops cookie consent banners', () => {
    const yaml = [
      '- dialog "Cookie Consent":',
      '  - button "Accept All Cookies" [ref=e1]',
      '  - button "Reject Cookies" [ref=e2]',
      '  - link "Cookie Policy" [ref=e3]',
      '- main:',
      '  - heading "Welcome" [ref=e4]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    expect(result).not.toContain('Cookie');
    expect(result).not.toContain('Reject');
    expect(result).toContain('[ref=e4] heading "Welcome"');
  });

  test('drops all images (agent cannot interact with them)', () => {
    const yaml = [
      '- img "icon" [ref=e1]',
      '- img "logo" [ref=e2]',
      '- img "Product Photo Large" [ref=e3]',
      '- button "Buy" [ref=e4]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    expect(result).not.toContain('img');
    expect(result).toContain('[ref=e4] button "Buy"');
  });

  test('truncates at max lines with hint', () => {
    // Build a snapshot with 100 buttons
    const lines = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`- button "Button ${i}" [ref=e${i}]`);
    }
    const yaml = lines.join('\n');
    const result = smartSnapshot(yaml, { maxLines: 20 });
    const outputLines = result.split('\n');
    // 20 content lines + 1 blank + 1 truncation message + 1 tip = 23
    expect(outputLines.length).toBeLessThanOrEqual(24);
    expect(result).toContain('truncated');
    expect(result).toContain('browser_find');
  });

  test('drops newsletter signup regions', () => {
    const yaml = [
      '- region "Newsletter Signup":',
      '  - textbox "Email" [ref=e1]',
      '  - button "Subscribe" [ref=e2]',
      '- main:',
      '  - button "Add to Cart" [ref=e3]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    expect(result).not.toContain('Newsletter');
    expect(result).not.toContain('Subscribe');
    expect(result).toContain('[ref=e3] button "Add to Cart"');
  });
});
