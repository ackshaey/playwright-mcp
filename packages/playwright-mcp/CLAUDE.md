# packages/playwright-mcp — Enhanced MCP Server

This is where the enhancement layer lives. All our code is in `src/` and the modified entry points (`cli.js`, `index.js`).

## File Map

```
cli.js              — Modified CLI entry point. Adds --smart-snapshot, --extension-path flags.
                      Overrides the action handler to wrap BrowserServerBackend in our enhanced backend.

index.js            — Modified library entry point. Exports enhanced createConnection() that
                      accepts smartSnapshot and extensionPath config options.

src/
  enhanced-backend.js  — EnhancedBrowserServerBackend class. The wrapper that sits between the
                         MCP server and Playwright's BrowserServerBackend. Intercepts listTools()
                         to add custom tools + override descriptions, intercepts callTool() to
                         handle custom tools and post-process snapshots.

  smart-snapshot.js    — The core optimization. Parses AXTree YAML, filters junk containers
                         (footers, banners, cookie consent, cross-sells), filters junk nodes
                         (decorative images, noise patterns), prunes structural containers
                         (generic, paragraph, group), focuses on the action zone (h1 → CTA),
                         and caps output at 80 lines.

  query-resolver.js    — Shape query parser and heuristic resolver for browser_query tool.
                         Parses { field, field[] { child } } syntax and matches against AXTree.

  tools.js             — MCP tool definitions for browser_smart_snapshot, browser_find,
                         browser_query. Includes RECOMMENDED/WARNING language in descriptions
                         to steer agent behavior.

tests/
  smart-snapshot.spec.ts  — Unit tests for the pruning pipeline (31 tests, no browser needed)
  enhanced.spec.ts        — Integration tests for the full enhanced backend (17 tests, needs browser)
  capture-snapshot.js     — Utility: capture a real page's AXTree and save as a fixture
  benchmark-pruning.js    — Utility: benchmark pruning on saved fixtures (zero tokens)
  fixtures/               — Saved AXTree snapshots for offline benchmarking
```

## How the wrapper works

The key constraint: the real Playwright MCP code lives in `node_modules/playwright/lib/mcp/`, NOT in this package. The package's `exports` field restricts deep imports, so `cli.js` resolves internal modules via filesystem paths:

```javascript
const playwrightDir = path.dirname(require.resolve('playwright/package.json'));
const { BrowserServerBackend } = require(path.join(playwrightDir, 'lib/mcp/browser/browserServerBackend'));
```

The enhanced backend wraps the original:
- `listTools()` — returns upstream tools (with description overrides) + our 3 custom tools
- `callTool()` — routes custom tool names to our handlers, delegates everything else to upstream, optionally post-processes the response to prune snapshots
- `_postProcessResponse()` — regex-matches `### Snapshot\n```yaml\n...\n``` ` sections in tool responses and replaces the YAML with pruned output

## Snapshot post-processing detail

The regex `/(### Snapshot\n```yaml\n)([\s\S]*?)(\n```)/` finds snapshot sections in responses. It skips incremental diffs (detected by lines starting with `+`). Full snapshots get run through `smartSnapshot()` which applies the pruning pipeline.

The `--smart-snapshot` flag enables this for ALL tool responses. Without it, only `browser_smart_snapshot` returns pruned output.

## Tool description overrides

In `enhanced-backend.js`, `TOOL_DESCRIPTION_OVERRIDES` maps upstream tool names to rewritten descriptions. The override for `browser_take_screenshot` adds a WARNING about token cost and recommends `browser_smart_snapshot`. The override for `browser_click` suggests using `browser_find` first. These are applied in `listTools()` before returning tools to the MCP client.

This is the single most effective optimization — it steers the agent away from screenshots without any prompt engineering.

## Iterating on pruning

```bash
# Capture a page (one-time, opens browser)
node tests/capture-snapshot.js https://some-url.com fixture-name

# Benchmark pruning (instant, zero tokens, re-run after every code change)
node tests/benchmark-pruning.js [fixture-name]
```

## Running tests

```bash
# From this directory
npx playwright test                              # all 48 tests
npx playwright test tests/smart-snapshot.spec.ts  # unit tests only (no browser)
npx playwright test tests/enhanced.spec.ts        # integration tests (needs browser)
```
