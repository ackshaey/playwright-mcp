# Enhanced Playwright MCP

Fork of [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) with a token-efficiency optimization layer for AI agents.

## Why This Exists

The vanilla Playwright MCP server dumps the full AXTree (~38,000+ tokens for a complex e-commerce page) on every interaction. AI agents waste most of their token budget reading page structure, taking screenshots, and reasoning about elements they don't need. This fork adds a wrapper layer that compresses page snapshots by 40-98% depending on page complexity, provides intent-based element search, and steers agents toward efficient tools via description overrides.

**Benchmark result (Pottery Barn product page — select options, add to cart, checkout, fill shipping form):**
- Vanilla: $2.01, 50 tool calls, 19 screenshots, **failed** (hit max turns)
- Enhanced: $1.14, 29 tool calls, 1 screenshot, **succeeded** — 43% cheaper, 58% faster

## Architecture

Wrapper pattern — zero modifications to Playwright internals:

```
MCP Server → EnhancedBrowserServerBackend → BrowserServerBackend → Playwright
                    ↑ our code                    ↑ upstream (34+ tools)
```

All changes are in `packages/playwright-mcp/`. The upstream Playwright code in `node_modules/` is untouched.

## What We Changed

### Files

| File | Purpose |
|------|---------|
| `src/smart-snapshot.js` | AXTree parser, junk filter, pruner, action zone focuser |
| `src/query-resolver.js` | Shape query parser + heuristic resolver |
| `src/tools.js` | 3 custom MCP tool definitions with agent-steering descriptions |
| `src/enhanced-backend.js` | Wrapper backend: adds tools, overrides descriptions, post-processes snapshots |
| `cli.js` | Modified CLI with `--smart-snapshot` and `--extension-path` flags |
| `index.js` | Modified library entry with enhanced `createConnection` |

### New Tools

- **`browser_smart_snapshot`** — Pruned, flat snapshot. Description says "RECOMMENDED" and explains it's 5-10x more efficient than screenshots.
- **`browser_find`** — Find elements by intent (e.g., "add to cart button" → returns refs). Description says "RECOMMENDED: use BEFORE clicking."
- **`browser_query`** — Structured shape queries (`{ products[] { name, price } }` → JSON).

### Tool Description Overrides

The key insight: you don't need prompt engineering if the tool descriptions themselves steer the agent. We override descriptions on upstream tools:

- **`browser_take_screenshot`**: "WARNING: Screenshots consume ~1,600 vision tokens. STRONGLY PREFER browser_smart_snapshot instead."
- **`browser_snapshot`**: "Consider using browser_smart_snapshot — it's ~5x fewer tokens."
- **`browser_click`**: "TIP: Use browser_find first to locate the element by intent."
- **`browser_fill_form`**: "PREFERRED over calling browser_type repeatedly for each field."

This eliminated the need for custom prompts — the same generic prompt produces different behavior depending on which MCP server is connected.

### Snapshot Optimization Pipeline

The `smartSnapshot()` function runs this pipeline on the raw AXTree YAML:

1. **Parse** — Stack-based YAML parser, builds node tree
2. **Junk container filtering** — Drop entire subtrees: footers (`contentinfo`), banners (`banner`), cookie consent dialogs, newsletter signups, "Also In This Collection" sections, "You May Also Need" cross-sells
3. **Junk node filtering** — Drop decorative images (icons, logos, blank alt), noise patterns (zoomable, carousel, social share, favorites, ratings, breadcrumbs)
4. **Structural pruning** — Flatten `generic`/`paragraph`/`group` containers (lift children). Keep interactive elements (buttons, links, inputs), landmarks (navigation, main, form), and semantic elements (headings, lists, tables)
5. **Action zone focusing** — Find the h1 product title and the primary CTA (Add to Cart / Buy Now). Keep only that zone ± a few lines of context. Everything before (image galleries) and after (cross-sells, product details accordions) is trimmed.
6. **Line cap** — If still over 80 lines, truncate with a hint: "Use browser_find to locate specific elements."

Result: Pottery Barn product page goes from **38,849 tokens → 765 tokens** (52x reduction).

### CLI Flags

- `--smart-snapshot` — Auto-prune ALL snapshot responses (navigate, click, etc.)
- `--extension-path <path>` — Load a Chrome extension at browser launch

## What We Tried That Didn't Work

### ML-based semantic matching (all-MiniLM-L6-v2)

We tested 6 embedding models and 2 small LLMs for element matching in `browser_find`. Result: all embedding models scored 45% accuracy (same as string heuristics) at 150x more latency. The small LLMs scored 10% at 9000x more latency. The heuristic is instant, zero dependencies, and equally accurate. The agent (Sonnet) is already smart enough to pick the right element from a top-5 list.

### `disallowedTools` in the Agent SDK

We tried using `disallowedTools` to block built-in Claude Code tools (Bash, Read, Grep) so the agent would only use MCP tools. This crashed the SDK. The `disallowedTools` option appears incompatible with `allowedTools` + `permissionMode: 'bypassPermissions'`.

## How to Run

```bash
# As MCP server (with smart snapshots)
node packages/playwright-mcp/cli.js --smart-snapshot --viewport-size=1366x768

# With a Chrome extension
node packages/playwright-mcp/cli.js --smart-snapshot --extension-path ./my-extension

# Run tests (48 tests)
cd packages/playwright-mcp && npx playwright test

# Capture a page snapshot for local benchmarking (zero tokens)
node tests/capture-snapshot.js https://some-url.com fixture-name

# Benchmark pruning on saved fixtures
node tests/benchmark-pruning.js
```

## Iterating on Pruning

The capture + benchmark loop lets you iterate without spending tokens:

```bash
# Capture once (opens real browser)
node tests/capture-snapshot.js https://www.potterybarn.com/products/some-product potterybarn

# Iterate instantly (edit smart-snapshot.js, re-run)
node tests/benchmark-pruning.js potterybarn
```

Fixtures are saved in `tests/fixtures/*.yaml`.
