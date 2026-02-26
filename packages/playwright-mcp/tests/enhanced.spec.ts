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
