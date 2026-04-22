/**
 * Integration tests for the enhanced Playwright MCP backend.
 * Tests custom tools (browser_smart_snapshot, browser_query, browser_find)
 * and the --smart-snapshot auto-pruning mode.
 */

import { test, expect } from './fixtures';

test('custom tools appear in tool list', async ({ client }) => {
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name);

  // Our custom tools
  expect(names).toContain('browser_smart_snapshot');
  expect(names).toContain('browser_query');
  expect(names).toContain('browser_find');

  // Original tools still present
  expect(names).toContain('browser_navigate');
  expect(names).toContain('browser_click');
  expect(names).toContain('browser_snapshot');
  expect(names).toContain('browser_evaluate');
});

test('browser_smart_snapshot returns compact output', async ({ client, server }) => {
  server.setContent('/', `
    <title>Test Page</title>
    <div><div><div>
      <h1>Welcome</h1>
      <nav>
        <a href="/home">Home</a>
        <a href="/about">About</a>
      </nav>
      <div><div>
        <input type="text" placeholder="Email">
        <button>Submit</button>
      </div></div>
    </div></div></div>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: {},
  });

  const text = result.content[0].text;

  // Should contain the Smart Snapshot header
  expect(text).toContain('### Smart Snapshot');

  // Should contain interactive/semantic elements
  expect(text).toContain('heading "Welcome"');
  expect(text).toContain('button "Submit"');
  expect(text).toContain('textbox');

  // Should contain refs
  expect(text).toMatch(/\[ref=e\d+\]/);

  // Should NOT contain deeply nested generic containers
  expect(text).not.toMatch(/generic:\n\s+generic:/);
});

test('browser_query extracts structured data', async ({ client, server }) => {
  server.setContent('/', `
    <title>Products</title>
    <ul>
      <li>Widget</li>
      <li>Gadget</li>
      <li>Doohickey</li>
    </ul>
    <button>Add to Cart</button>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_query',
    arguments: { query: '{ add_to_cart }' },
  });

  const text = result.content[0].text;
  // Should return some result (either resolved JSON or fallback snapshot)
  expect(text).toBeTruthy();
  expect(text.length).toBeGreaterThan(0);
});

test('browser_query falls back to smart snapshot on failure', async ({ client, server }) => {
  server.setContent('/', `
    <title>Simple Page</title>
    <button>Click Me</button>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_query',
    arguments: { query: '{ nonexistent_field_xyz123 }' },
  });

  const text = result.content[0].text;
  // Should fall back with smart snapshot
  expect(text).toContain('smart snapshot');
});

test('browser_find locates elements by intent', async ({ client, server }) => {
  server.setContent('/', `
    <title>Form Page</title>
    <form>
      <input type="email" placeholder="Email address">
      <input type="password" placeholder="Password">
      <button type="submit">Sign In</button>
      <button type="button">Cancel</button>
    </form>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_find',
    arguments: { intent: 'sign in button' },
  });

  const text = result.content[0].text;
  expect(text).toContain('Sign In');
  expect(text).toContain('button');
  expect(text).toMatch(/ref=e\d+/);
});

test('browser_find returns ranked results', async ({ client, server }) => {
  server.setContent('/', `
    <title>Page</title>
    <a href="/home">Home</a>
    <a href="/about">About Us</a>
    <a href="/contact">Contact</a>
    <button>Submit Form</button>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_find',
    arguments: { intent: 'about', maxResults: 2 },
  });

  const text = result.content[0].text;
  expect(text).toContain('About');
  // Should contain score information
  expect(text).toContain('score:');
});

test('browser_query with empty query returns error', async ({ client, server }) => {
  server.setContent('/', '<title>Test</title><p>Hello</p>', 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_query',
    arguments: { query: '' },
  });

  const text = result.content[0].text;
  expect(text).toContain('Error');
});

test('browser_find with no matches falls back to smart snapshot', async ({ client, server }) => {
  server.setContent('/', `
    <title>Simple</title>
    <button>Click Me</button>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_find',
    arguments: { intent: 'xyznonexistent123' },
  });

  const text = result.content[0].text;
  // Should fall back with snapshot when nothing matches
  expect(text).toContain('No matches');
});

test('all original tools still work with enhanced backend', async ({ client, server }) => {
  server.setContent('/', `
    <title>Test</title>
    <button id="btn">Click Me</button>
  `, 'text/html');

  // Navigate works
  const navResult = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(navResult.content[0].text).toContain('Click Me');

  // Standard snapshot works
  const snapResult = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });
  expect(snapResult.content[0].text).toContain('button');

  // Evaluate works
  const evalResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.title' },
  });
  expect(evalResult.content[0].text).toContain('Test');
});

test('--smart-snapshot flag auto-prunes navigate response', async ({ startClient, server }) => {
  const { client } = await startClient({
    args: ['--smart-snapshot'],
  });

  server.setContent('/', `
    <title>Auto Prune Test</title>
    <div><div><div>
      <h1>Hello World</h1>
      <button>Submit</button>
    </div></div></div>
  `, 'text/html');

  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const text = result.content[0].text;

  // With --smart-snapshot, the response should use Smart Snapshot header
  expect(text).toContain('Smart Snapshot');

  // Should contain the important elements
  expect(text).toContain('heading "Hello World"');
  expect(text).toContain('button "Submit"');
});

test('browser_smart_snapshot with rootRef returns only that subtree', async ({ client, server }) => {
  server.setContent('/', `
    <title>Scoped</title>
    <header>
      <a href="/home">Home</a>
      <a href="/about">About</a>
    </header>
    <main>
      <fieldset id="shipping">
        <legend>Shipping method</legend>
        <label><input type="radio" name="ship" value="standard"> Standard</label>
        <label><input type="radio" name="ship" value="express"> Express</label>
      </fieldset>
      <fieldset id="payment">
        <legend>Payment</legend>
        <label>Card <input type="text"></label>
      </fieldset>
    </main>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // First get a ref to the shipping fieldset via browser_find
  const find = await client.callTool({
    name: 'browser_find',
    arguments: { intent: 'shipping method' },
  });
  const findText = find.content[0].text;
  const refMatch = findText.match(/ref=(e\d+)/);
  expect(refMatch).not.toBeNull();
  const shippingRef = refMatch[1];

  // Now scope the snapshot to that ref
  const scoped = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: { rootRef: shippingRef },
  });
  const scopedText = scoped.content[0].text;

  // Header reflects the scope
  expect(scopedText).toContain(`scoped to ref=${shippingRef}`);
  // Subtree content is present
  expect(scopedText).toContain('Standard');
  expect(scopedText).toContain('Express');
  // Sibling subtree dropped
  expect(scopedText).not.toContain('Card');
  expect(scopedText).not.toContain('Home');
  expect(scopedText).not.toContain('About');
});

test('browser_smart_snapshot with unknown rootRef returns isError with distinct header', async ({ client, server }) => {
  server.setContent('/', '<title>T</title><button>Go</button>', 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: { rootRef: 'e999999' },
  });
  // Regression: previously returned a normal snapshot with a parenthetical notice
  // under the regular "### Smart Snapshot" header — easy for an agent to miss.
  // Now: isError is set, header signals the failure explicitly, no misleading "scoped to" claim.
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  expect(text).toContain('ref not found');
  expect(text).toContain('e999999');
  expect(text).not.toContain('Go');
  // The "scoped to" header MUST NOT appear when the scope was invalid.
  expect(text).not.toMatch(/scoped to ref=/);
});

test('browser_smart_snapshot rejects malformed rootRef without running a snapshot', async ({ client, server }) => {
  // Regression: rootRef was previously echoed verbatim into the response header,
  // which allowed newline/markdown injection like "e5)\n\n### Fake Section".
  // The backend now validates against a strict ref pattern before round-tripping
  // to the browser.
  server.setContent('/', '<title>T</title><button>Go</button>', 'text/html');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  for (const bad of ['e5)\n### Fake', 'foo bar', '../etc/passwd', 'e5 and more', '']) {
    const result = await client.callTool({
      name: 'browser_smart_snapshot',
      arguments: { rootRef: bad },
    });
    // Empty string is treated as "not provided" (returns a successful full snapshot),
    // every other bad value must error.
    if (bad === '') {
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Smart Snapshot');
    } else {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid rootRef');
      // The real guarantee is that a rejected input cannot be mistaken for a
      // successful scoped snapshot: no "Smart Snapshot" section header and no
      // "scoped to ref=" claim should appear in the response.
      expect(result.content[0].text).not.toMatch(/^### Smart Snapshot(?: \(scoped to ref=)?/m);
      expect(result.content[0].text).not.toMatch(/scoped to ref=/);
    }
  }
});

test('browser_smart_snapshot rejects non-string rootRef and non-number maxLines', async ({ client, server }) => {
  server.setContent('/', '<title>T</title><button>Go</button>', 'text/html');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const badRootRef = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: { rootRef: 42 as unknown as string },
  });
  expect(badRootRef.isError).toBe(true);
  expect(badRootRef.content[0].text).toContain('rootRef must be a string');

  const badMaxLines = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: { maxLines: 'lots' as unknown as number },
  });
  expect(badMaxLines.isError).toBe(true);
  expect(badMaxLines.content[0].text).toContain('maxLines must be a number');
});

test('browser_smart_snapshot maxLines override prevents truncation on a long page', async ({ client, server }) => {
  // Generate a page with enough interactive elements to exceed the default 80-line cap.
  const buttons: string[] = [];
  for (let i = 1; i <= 150; i++) buttons.push(`<button>Button ${i}</button>`);
  server.setContent('/', `
    <title>Long</title>
    <main>${buttons.join('\n')}</main>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // Default run: truncates.
  const defaultResult = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: {},
  });
  expect(defaultResult.content[0].text).toContain('truncated');

  // Raised maxLines: no truncation.
  const largerResult = await client.callTool({
    name: 'browser_smart_snapshot',
    arguments: { maxLines: 500 },
  });
  const largerText = largerResult.content[0].text;
  expect(largerText).not.toContain('truncated');
  expect(largerText).toContain('Button 150');
});
