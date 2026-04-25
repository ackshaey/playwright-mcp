'use strict';

const { smartSnapshot, parseSnapshot, REF_PATTERN } = require('./smart-snapshot');
const { resolveQuery, flattenNodes } = require('./query-resolver');
const { CUSTOM_TOOLS, CUSTOM_TOOL_NAMES } = require('./tools');
const { solveChallenge, isStealthEnabled } = require('./stealth');

// Description overrides for upstream tools — steer the agent toward efficient tools
const TOOL_DESCRIPTION_OVERRIDES = {
  browser_take_screenshot: [
    'Take a screenshot of the current page.',
    'WARNING: Screenshots consume ~1,600 vision tokens each and are slow.',
    'STRONGLY PREFER browser_smart_snapshot instead — it returns a compact text representation',
    'that is 5-10x more token-efficient and provides element refs you can act on directly.',
    'Only use screenshots when you need to verify visual layout, see images, or when text-based tools fail.',
  ].join(' '),

  browser_snapshot: [
    'Capture full accessibility snapshot of the current page.',
    'NOTE: Consider using browser_smart_snapshot instead — it returns a pruned, compact version',
    'that is ~5x fewer tokens. Use this full snapshot only when you need the complete page structure.',
  ].join(' '),

  browser_click: [
    'Perform click on a web page.',
    'TIP: Use browser_find first to locate the element by intent (e.g. browser_find({ intent: "submit button" }))',
    'then click the returned ref. This is faster and more reliable than reading the full snapshot.',
  ].join(' '),

  browser_fill_form: [
    'Fill multiple form fields at once in a single call.',
    'PREFERRED over calling browser_type repeatedly for each field.',
    'Pass all fields in the fields array to minimize round-trips.',
  ].join(' '),
};

// Regex to find the Snapshot section in a tool response.
// Matches: ### Snapshot\n```yaml\n<content>\n```
const SNAPSHOT_REGEX = /(### Snapshot\n```yaml\n)([\s\S]*?)(\n```)/;

// Regex to detect incremental diffs. Incremental snapshots use lines like:
// "- button "Submit" [ref=e2]" (removed) and "+ button "Submit" [ref=e2]" (added)
// But full snapshots ALSO start with "- " prefix. The key difference is that
// incremental diffs have lines starting with "+" which full snapshots never do.
const INCREMENTAL_DIFF_REGEX = /^\+ /m;

class EnhancedBrowserServerBackend {
  /**
   * @param {object} originalBackend - The original BrowserServerBackend instance
   * @param {object} options
   * @param {boolean} options.smartSnapshotMode - Whether to auto-prune all snapshots
   */
  constructor(originalBackend, options = {}) {
    this._backend = originalBackend;
    this._smartSnapshotMode = options.smartSnapshotMode || false;
    this._stealthResult = options.stealthResult || null;
  }

  async initialize(clientInfo) {
    return this._backend.initialize(clientInfo);
  }

  async listTools() {
    const originalTools = await this._backend.listTools();

    // Apply description overrides to steer agent toward efficient tools
    const enhancedTools = originalTools.map(tool => {
      const override = TOOL_DESCRIPTION_OVERRIDES[tool.name];
      if (override) {
        return { ...tool, description: override };
      }
      return tool;
    });

    // Hide browser_solve_challenge when stealth isn't on — without trusted
    // mouse events the solver can't work, so the tool is actively misleading.
    const stealthOn = this._stealthResult && isStealthEnabled(this._stealthResult.level);
    const customTools = stealthOn
      ? CUSTOM_TOOLS
      : CUSTOM_TOOLS.filter(t => t.name !== 'browser_solve_challenge');

    return [...enhancedTools, ...customTools];
  }

  async callTool(name, rawArguments, progress) {
    if (CUSTOM_TOOL_NAMES.has(name)) {
      return this._handleCustomTool(name, rawArguments);
    }

    const result = await this._backend.callTool(name, rawArguments, progress);

    if (this._smartSnapshotMode) {
      return this._postProcessResponse(result);
    }

    return result;
  }

  serverClosed(server) {
    return this._backend.serverClosed?.(server);
  }

  // --- Custom tool handlers ---

  async _handleCustomTool(name, args) {
    try {
      switch (name) {
        case 'browser_smart_snapshot':
          return await this._handleSmartSnapshot(args);
        case 'browser_query':
          return await this._handleQuery(args);
        case 'browser_find':
          return await this._handleFind(args);
        case 'browser_solve_challenge':
          return await this._handleSolveChallenge(args);
        default:
          return {
            content: [{ type: 'text', text: `### Error\nUnknown custom tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      // Preserve the stack when present — `String(err)` drops it and makes
      // diagnosing thrown errors from inside tool handlers (e.g. detached-frame
      // failures from cloudflare-solver) much harder than necessary.
      const detail = error?.stack || String(error);
      return {
        content: [{ type: 'text', text: `### Error\n${detail}` }],
        isError: true,
      };
    }
  }

  async _handleSolveChallenge(args) {
    if (!this._stealthResult || !isStealthEnabled(this._stealthResult.level)) {
      return {
        content: [{
          type: 'text',
          text: '### browser_solve_challenge unavailable\nStealth is not enabled on this server. Restart with --stealth <light|medium|full> to use this tool.',
        }],
        isError: true,
      };
    }

    const page = this._resolveCurrentPage();
    if (!page) {
      return {
        content: [{ type: 'text', text: '### Error\nNo active page. Call browser_navigate first.' }],
        isError: true,
      };
    }

    // Validate args: maxAttempts must be a positive integer; timeoutMs must
    // be a positive integer (milliseconds). Undefined means "use default".
    const { maxAttempts, timeoutMs } = args || {};
    if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
      return {
        content: [{ type: 'text', text: '### Error\nmaxAttempts must be a positive integer.' }],
        isError: true,
      };
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      return {
        content: [{ type: 'text', text: '### Error\ntimeoutMs must be a positive integer (milliseconds).' }],
        isError: true,
      };
    }

    const result = await solveChallenge(page, {
      maxAttempts,
      // One knob → both interactive and non-interactive polls. They serve
      // the same purpose (how long to wait before giving up); exposing two
      // separate timeouts in the tool schema is just user confusion.
      interactiveTimeoutMs: timeoutMs,
      nonInteractiveTimeoutMs: timeoutMs,
    });

    return {
      content: [{
        type: 'text',
        text: `### browser_solve_challenge\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
      }],
      isError: !result.solved,
    };
  }

  /**
   * Find the active Playwright Page for tool handlers that need direct page
   * access (notably browser_solve_challenge, which drives page.mouse.click).
   *
   * Preferred path: the stealth-factory stashes the live browserContext on
   * this._stealthResult.browserContext, and we take the last-created page
   * as "current" — Playwright MCP is one-tab-at-a-time in practice and the
   * most recently opened tab is the active one.
   *
   * Fallback: upstream's private _context.currentTab(). Pinned to the
   * browserServerBackend.js / context.js shape in
   * node_modules/playwright/lib/mcp/browser; if upstream renames these
   * fields this falls through to null and the tool returns a clean error.
   */
  _resolveCurrentPage() {
    const browserContext = this._stealthResult?.browserContext;
    if (browserContext) {
      const pages = browserContext.pages();
      if (pages.length > 0) return pages[pages.length - 1];
    }
    // Fallback: only fires when the stealth-factory hasn't seen a context yet
    // (race on first tool call) or when stealth is somehow off but the handler
    // still ran. Log once so a silent upstream rename of `_context`/`currentTab`
    // is diagnosable instead of just returning null.
    const context = this._backend?._context;
    const tab = typeof context?.currentTab === 'function' ? context.currentTab() : null;
    if (!this._loggedFallback && (!context || !tab)) {
      this._loggedFallback = true;
      console.error('[playwright-mcp stealth] _resolveCurrentPage fell back to upstream _context (private API). browserContext was unavailable on stealthResult.');
    }
    return tab?.page || null;
  }

  async _handleSmartSnapshot(args) {
    const options = { asStructured: true };

    // Validate rootRef at the boundary: reject anything that doesn't look like a
    // Playwright-issued ref. This prevents prose/newlines from being injected
    // into the response header and catches typos early.
    if (args && args.rootRef !== undefined && args.rootRef !== null) {
      if (typeof args.rootRef !== 'string') {
        return {
          content: [{ type: 'text', text: `### Error\nrootRef must be a string (received ${typeof args.rootRef})` }],
          isError: true,
        };
      }
      const trimmed = args.rootRef.trim();
      if (trimmed && !REF_PATTERN.test(trimmed)) {
        return {
          content: [{ type: 'text', text: `### Error\nInvalid rootRef "${trimmed}" — expected a Playwright ref like "e5" or "f1e3"` }],
          isError: true,
        };
      }
      if (trimmed) options.rootRef = trimmed;
    }
    if (args && args.maxLines !== undefined && args.maxLines !== null) {
      if (typeof args.maxLines !== 'number') {
        return {
          content: [{ type: 'text', text: `### Error\nmaxLines must be a number (received ${typeof args.maxLines})` }],
          isError: true,
        };
      }
      options.maxLines = args.maxLines;
    }

    // Call the original browser_snapshot to get the full AXTree. Done AFTER
    // arg validation so bad args fail fast without a browser round-trip.
    const result = await this._backend.callTool('browser_snapshot', {});
    if (result.isError) return result;

    const yaml = this._extractSnapshot(result);
    if (!yaml) return result; // No snapshot found, return as-is

    const structured = smartSnapshot(yaml, options);

    if (structured.notFound) {
      return {
        content: [{
          type: 'text',
          text: `### Smart Snapshot — ref not found\n${structured.text}`,
        }],
        isError: true,
      };
    }

    // options.rootRef is already validated against REF_PATTERN above, so it's
    // safe to interpolate into the header without further escaping.
    const header = options.rootRef
      ? `### Smart Snapshot (scoped to ref=${options.rootRef})`
      : '### Smart Snapshot';

    return {
      content: [{
        type: 'text',
        text: `${header}\n${structured.text}`,
      }],
    };
  }

  async _handleQuery(args) {
    const queryStr = args?.query;
    if (!queryStr) {
      return {
        content: [{ type: 'text', text: '### Error\nMissing required parameter: query' }],
        isError: true,
      };
    }

    // Get the full snapshot
    const result = await this._backend.callTool('browser_snapshot', {});
    if (result.isError) return result;

    const yaml = this._extractSnapshot(result);
    if (!yaml) {
      return {
        content: [{ type: 'text', text: '### Error\nCould not capture page snapshot' }],
        isError: true,
      };
    }

    // Try to resolve the query
    const resolved = resolveQuery(queryStr, yaml);

    if (resolved.data) {
      return {
        content: [{
          type: 'text',
          text: `### Result\n\`\`\`json\n${JSON.stringify(resolved.data, null, 2)}\n\`\`\`\n\n_Resolved at level ${resolved.level}_`,
        }],
      };
    }

    // Fallback: return smart snapshot so the agent can figure it out
    const compact = smartSnapshot(yaml);
    return {
      content: [{
        type: 'text',
        text: `### Query could not be resolved\nFalling back to smart snapshot:\n\n${compact}`,
      }],
    };
  }

  async _handleFind(args) {
    const intent = args?.intent;
    if (!intent) {
      return {
        content: [{ type: 'text', text: '### Error\nMissing required parameter: intent' }],
        isError: true,
      };
    }

    const maxResults = args?.maxResults || 5;

    // Get the full snapshot
    const result = await this._backend.callTool('browser_snapshot', {});
    if (result.isError) return result;

    const yaml = this._extractSnapshot(result);
    if (!yaml) {
      return {
        content: [{ type: 'text', text: '### Error\nCould not capture page snapshot' }],
        isError: true,
      };
    }

    const nodes = parseSnapshot(yaml);
    const allNodes = flattenNodes(nodes);

    // Score each node with a ref against the intent
    const intentWords = intent.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    const scored = [];

    for (const node of allNodes) {
      if (!node.ref) continue;

      let score = 0;
      const name = (node.name || '').toLowerCase();
      const role = (node.role || '').toLowerCase();
      const text = (node.inlineText || '').toLowerCase();

      for (const word of intentWords) {
        if (name.includes(word)) score += 30;
        if (role.includes(word)) score += 20;
        if (text.includes(word)) score += 15;
      }

      // Bonus for exact full name match
      const fullIntent = intentWords.join(' ');
      if (name === fullIntent) score += 50;

      // Bonus if role AND name match different words
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
    const topResults = scored.slice(0, maxResults);

    if (topResults.length === 0) {
      // Fallback to smart snapshot
      const compact = smartSnapshot(yaml);
      return {
        content: [{
          type: 'text',
          text: `### No matches found for "${intent}"\nSmart snapshot:\n\n${compact}`,
        }],
      };
    }

    const formatted = topResults.map(
      r => `[ref=${r.ref}] ${r.role}${r.name ? ` "${r.name}"` : ''} (score: ${r.score})`
    ).join('\n');

    return {
      content: [{
        type: 'text',
        text: `### Found ${topResults.length} match${topResults.length === 1 ? '' : 'es'} for "${intent}"\n${formatted}`,
      }],
    };
  }

  // --- Response post-processing ---

  /**
   * Post-process a tool response to replace the snapshot section with a smart snapshot.
   * Only operates on responses containing a YAML snapshot section.
   */
  _postProcessResponse(result) {
    if (!result || !result.content) return result;

    const newContent = result.content.map(part => {
      if (part.type !== 'text') return part;

      const match = part.text.match(SNAPSHOT_REGEX);
      if (!match) return part;

      const yaml = match[2];

      // Skip incremental diffs — they use +/- prefix format and are already compact
      if (INCREMENTAL_DIFF_REGEX.test(yaml)) return part;

      const compact = smartSnapshot(yaml);
      return {
        type: 'text',
        text: part.text.replace(SNAPSHOT_REGEX, `### Smart Snapshot\n${compact}`),
      };
    });

    return { ...result, content: newContent };
  }

  /**
   * Extract the YAML snapshot text from a tool response.
   */
  _extractSnapshot(result) {
    if (!result || !result.content) return null;

    for (const part of result.content) {
      if (part.type !== 'text') continue;
      const match = part.text.match(SNAPSHOT_REGEX);
      if (match) return match[2];
    }
    return null;
  }
}

module.exports = { EnhancedBrowserServerBackend };
