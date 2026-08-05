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

## Relationship to `microsoft/playwright-mcp`

**This is a copy, not a GitHub fork** (`isFork: false`, no parent) — an independent
private repo seeded from upstream's history in Nov 2025, with `upstream` as a git
remote. That distinction matters: GitHub suppresses scheduled workflows in real forks,
but treats this one as first-class, so every inherited cron actually ran.

**Do not try to `git merge upstream/main`.** Since our merge-base (`43e31e8`,
2026-02-26) upstream has:

1. **Flattened the monorepo** — `packages/playwright-mcp/*` moved to the repo root
   (`chore: flatten repo to single-package layout` #1567). A merge produces
   modify/delete conflicts on every file we own, and our `src/` collides with a root
   `src/` that now exists upstream.
2. **Emptied itself** — upstream's `src/` is now a single `README.md`. The whole MCP
   engine moved into the `playwright` / `playwright-core` npm packages.

**Upstream bug fixes therefore arrive via npm, not git.** `cli.js` resolves the engine
at runtime out of `playwright/lib/mcp/*`, so bumping the dependency *is* the upgrade
path. Use the inherited `roll.js` for it — despite being upstream scaffolding, it is the
single most useful file we inherited. Keep the `upstream` remote for reading and
cherry-picking only.

Our own diff is small and almost purely additive (~8.8k insertions, 10 deletions, 7
upstream files touched), so hand-porting a specific upstream fix is usually easy.

Microsoft's release automation (`publish.yml`) and policy docs (`SECURITY.md`,
`CONTRIBUTING.md`) were removed in 2026-08-05 — they published to Microsoft's npm scope
and Azure ACR and routed vulnerability reports to MSRC. Don't restore them.

## CI gotchas

Three traps, all inherited from upstream. All three had `main` red from 2026-07-17
until 2026-08-05.

- **`npm run lint` rewrites `README.md`** — it is `node update-readme.js`, which
  regenerates the options/tools tables from CLI metadata. The `lint` job then runs
  `git diff --exit-code`. Add or change a CLI flag and you **must** run `npm run lint`
  and commit the regenerated `README.md`, or CI fails on "Ensure no changes".

- **New top-level files under `packages/playwright-mcp/` need a `Dockerfile` COPY** —
  the runtime stage copies an explicit list, not the whole package. `cli.js` requires
  `./src/*` (enhanced backend, stealth, smart snapshot), so `src/` is copied
  separately; a multi-source `COPY` would flatten its contents. Miss this and the
  container dies at startup with `Cannot find module …`, which surfaces in
  `test_mcp_docker` as `MCP error -32000: Connection closed` on *every* test.

- **`ci.yml` is the only workflow, and it is ours to maintain** — upstream's `Publish`
  workflow used to sit alongside it, publishing an `@playwright/mcp` canary to npm on a
  daily cron. This repo is consumed from a local checkout (see `ddc/.mcp.json`) and
  publishes nothing, so that job could only ever fail; it spent 2026-07-18 to 08-05
  mailing a daily failure (`EBADENGINE`: node-20 pin vs `npm@latest` needing >=22.22.2)
  and masking the two real failures above. It has been deleted. Any workflow arriving
  from upstream deserves the same question: *does this repo publish anything?* No.
