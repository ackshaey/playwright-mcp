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
  findNodeByRef,
  MAX_OUTPUT_LINES_CEILING,
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

  test('drops decorative images but keeps meaningful ones', () => {
    const yaml = [
      '- img "icon" [ref=e1]',
      '- img "logo" [ref=e2]',
      '- img "" [ref=e3]',
      '- img "https://cdn.example.com/img.jpg" [ref=e4]',
      '- img "Performance Boucle Ivory Swatch" [ref=e5]',
      '- img "Layton Bed Product Photo" [ref=e6]',
      '- button "Buy" [ref=e7]',
    ].join('\n');
    const result = smartSnapshot(yaml);
    // Decorative/junk images dropped
    expect(result).not.toContain('"icon"');
    expect(result).not.toContain('"logo"');
    expect(result).not.toContain('cdn.example.com');
    // Meaningful images kept
    expect(result).toContain('img "Performance Boucle Ivory Swatch"');
    expect(result).toContain('img "Layton Bed Product Photo"');
    expect(result).toContain('[ref=e7] button "Buy"');
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

test.describe('findNodeByRef', () => {
  test('finds a top-level node by ref', () => {
    const nodes = parseSnapshot([
      '- button "Submit" [ref=e1]',
      '- textbox "Email" [ref=e2]',
    ].join('\n'));
    const found = findNodeByRef(nodes, 'e2');
    expect(found).not.toBeNull();
    expect(found.role).toBe('textbox');
    expect(found.name).toBe('Email');
  });

  test('finds a deeply nested node by ref', () => {
    const nodes = parseSnapshot([
      '- main:',
      '  - navigation:',
      '    - list:',
      '      - listitem:',
      '        - link "Deep" [ref=e10]',
    ].join('\n'));
    const found = findNodeByRef(nodes, 'e10');
    expect(found).not.toBeNull();
    expect(found.role).toBe('link');
    expect(found.name).toBe('Deep');
  });

  test('returns null when ref is missing', () => {
    const nodes = parseSnapshot('- button "Submit" [ref=e1]');
    expect(findNodeByRef(nodes, 'e999')).toBeNull();
  });

  test('handles iframe refs like f1e3', () => {
    const nodes = parseSnapshot('- button "Inner" [ref=f1e3]');
    const found = findNodeByRef(nodes, 'f1e3');
    expect(found).not.toBeNull();
    expect(found.ref).toBe('f1e3');
  });
});

test.describe('smartSnapshot rootRef scoping', () => {
  test('returns only the target subtree when rootRef is set', () => {
    const yaml = [
      '- banner:',
      '  - link "Logo" [ref=e1]',
      '  - navigation:',
      '    - link "Home" [ref=e2]',
      '- main:',
      '  - fieldset "Shipping method" [ref=e10]:',
      '    - radio "Standard" [ref=e11]',
      '    - radio "Express" [ref=e12]',
      '  - fieldset "Payment" [ref=e20]:',
      '    - textbox "Card number" [ref=e21]',
    ].join('\n');
    const result = smartSnapshot(yaml, { rootRef: 'e10' });
    // Subtree kept
    expect(result).toContain('e11');
    expect(result).toContain('Standard');
    expect(result).toContain('e12');
    expect(result).toContain('Express');
    // Sibling subtrees dropped
    expect(result).not.toContain('Card number');
    expect(result).not.toContain('Home');
    expect(result).not.toContain('Logo');
  });

  test('returns a notice when rootRef does not match any node', () => {
    const yaml = '- button "Submit" [ref=e1]';
    const result = smartSnapshot(yaml, { rootRef: 'e999' });
    expect(result).toContain('not found');
    expect(result).toContain('e999');
    expect(result).not.toContain('Submit');
  });

  test('treats whitespace-only rootRef as unscoped', () => {
    const yaml = [
      '- button "A" [ref=e1]',
      '- button "B" [ref=e2]',
    ].join('\n');
    const result = smartSnapshot(yaml, { rootRef: '   ' });
    expect(result).toContain('"A"');
    expect(result).toContain('"B"');
  });

  test('disables action-zone focus when rootRef is set', () => {
    // Build a page that has a product title + CTA (action-zone trigger).
    // Without rootRef, focus mode would slice around the CTA and insert an
    // "omitted" hint. With rootRef, we should get the raw scoped subtree and
    // no omitted-elements notice even when the output is short.
    const lines = ['- main:'];
    for (let i = 1; i <= 20; i++) {
      lines.push(`  - link "Extra ${i}" [ref=e${100 + i}]`);
    }
    lines.push('  - heading "Product Title" [level=1] [ref=e1]');
    for (let i = 1; i <= 20; i++) {
      lines.push(`  - generic "Detail ${i}" [ref=e${200 + i}]`);
    }
    lines.push('  - button "Add to Cart" [ref=e2]');
    lines.push('  - fieldset "Other" [ref=e3]:');
    lines.push('    - textbox "Unrelated" [ref=e4]');
    const yaml = lines.join('\n');
    // With rootRef, we should get just the fieldset subtree (no omitted hints).
    const scoped = smartSnapshot(yaml, { rootRef: 'e3', maxLines: 100 });
    expect(scoped).not.toContain('omitted');
    expect(scoped).toContain('Unrelated');
    expect(scoped).not.toContain('Product Title');
  });
});

test.describe('smartSnapshot maxLines guardrails', () => {
  function buildLongYaml(n: number): string {
    const lines: string[] = [];
    for (let i = 1; i <= n; i++) {
      lines.push(`- button "Button ${i}" [ref=e${i}]`);
    }
    return lines.join('\n');
  }

  test('honors a raised maxLines to avoid truncation', () => {
    const yaml = buildLongYaml(150);
    const truncatedResult = smartSnapshot(yaml, { maxLines: 50 });
    expect(truncatedResult).toContain('truncated');
    const fullResult = smartSnapshot(yaml, { maxLines: 200 });
    expect(fullResult).not.toContain('truncated');
    expect(fullResult).toContain('Button 150');
  });

  test('clamps absurdly large maxLines to the ceiling', () => {
    // Build a snapshot larger than the ceiling
    const yaml = buildLongYaml(MAX_OUTPUT_LINES_CEILING + 500);
    const result = smartSnapshot(yaml, { maxLines: 1_000_000 });
    const outputLines = result.split('\n');
    // Expect the truncation hint to still show — caller's huge request is clamped.
    expect(result).toContain('truncated');
    // Output capped near the ceiling + a few trailing hint lines.
    expect(outputLines.length).toBeLessThanOrEqual(MAX_OUTPUT_LINES_CEILING + 5);
  });

  test('falls back to default when maxLines is zero, negative, NaN, or non-number', () => {
    const yaml = buildLongYaml(200);
    for (const bad of [0, -5, NaN, Infinity, -Infinity, 'lots' as unknown as number, null as unknown as number]) {
      const result = smartSnapshot(yaml, { maxLines: bad });
      // All of these should fall back to the 80-line default → truncation must fire.
      expect(result).toContain('truncated');
    }
  });

  test('floors fractional maxLines', () => {
    const yaml = buildLongYaml(30);
    const result = smartSnapshot(yaml, { maxLines: 15.9 });
    const outputLines = result.split('\n');
    // 15 content lines + blank + truncated hint + tip = 18
    expect(outputLines.length).toBeLessThanOrEqual(18);
    expect(result).toContain('truncated');
  });

  test('truncation hint mentions rootRef escape hatch', () => {
    const yaml = buildLongYaml(100);
    const result = smartSnapshot(yaml, { maxLines: 20 });
    expect(result).toContain('rootRef');
  });
});
