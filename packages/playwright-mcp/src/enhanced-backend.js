'use strict';

const { smartSnapshot, parseSnapshot } = require('./smart-snapshot');
const { resolveQuery, flattenNodes } = require('./query-resolver');
const { CUSTOM_TOOLS, CUSTOM_TOOL_NAMES } = require('./tools');

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

    return [...enhancedTools, ...CUSTOM_TOOLS];
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
        default:
          return {
            content: [{ type: 'text', text: `### Error\nUnknown custom tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `### Error\n${String(error)}` }],
        isError: true,
      };
    }
  }

  async _handleSmartSnapshot(args) {
    // Call the original browser_snapshot to get the full AXTree
    const result = await this._backend.callTool('browser_snapshot', {});
    if (result.isError) return result;

    const yaml = this._extractSnapshot(result);
    if (!yaml) return result; // No snapshot found, return as-is

    const options = {};
    if (args && typeof args.rootRef === 'string' && args.rootRef.trim()) {
      options.rootRef = args.rootRef.trim();
    }
    if (args && typeof args.maxLines === 'number') {
      options.maxLines = args.maxLines;
    }

    const compact = smartSnapshot(yaml, options);
    const header = options.rootRef
      ? `### Smart Snapshot (scoped to ref=${options.rootRef})`
      : '### Smart Snapshot';

    return {
      content: [{
        type: 'text',
        text: `${header}\n${compact}`,
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
