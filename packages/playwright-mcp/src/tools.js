'use strict';

// Custom MCP tool definitions matching the format that toMcpTool() produces.
// These are JSON Schema objects, not Zod schemas.

const smartSnapshotTool = {
  name: 'browser_smart_snapshot',
  description: [
    'RECOMMENDED: Capture a token-efficient snapshot of the current page.',
    'This is the preferred way to check page state — use this instead of browser_take_screenshot or browser_snapshot.',
    'Returns a pruned, flat list of only interactive and semantic elements with compact refs.',
    'Uses ~5x fewer tokens than browser_snapshot and ~10x fewer than browser_take_screenshot.',
    'The refs returned can be used directly with browser_click, browser_type, etc.',
    '',
    'Format: [ref=eN] role "name" [attributes]',
    'Example output:',
    '  [ref=e1] heading "Welcome"',
    '  navigation:',
    '    [ref=e2] link "Home"',
    '    [ref=e3] link "About"',
    '  [ref=e4] textbox "Email"',
    '  [ref=e5] button "Submit"',
    '',
    'Scoping a dense page:',
    '  If the page is big (long dropdowns, many form fields) and truncates, either:',
    '    1. Call browser_find to get a ref to a specific container, then pass it as rootRef:',
    '         browser_smart_snapshot({ rootRef: "e5" })',
    '       returns only that subtree — cheap, targeted, and never truncates normal-sized sections.',
    '    2. Or raise maxLines for the whole page: browser_smart_snapshot({ maxLines: 300 }).',
    '  Prefer rootRef over a larger maxLines whenever you know which section you need.',
    '  A stale or invalid rootRef returns an error response; fetch a fresh ref with browser_find.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      rootRef: {
        type: 'string',
        description: 'Optional ref (e.g. "e5" or "f1e3") to scope the snapshot to a single subtree. Use this with a ref previously returned by browser_find or an earlier snapshot. When set, only that element and its descendants are returned, and the action-zone focus heuristic is disabled. If the ref is not found (stale snapshot), returns a short notice.',
      },
      maxLines: {
        type: 'number',
        description: 'Optional override for the maximum number of output lines before truncation. Default: 80. Clamped to [1, 2000]. Raise this when you need to see a long-but-bounded region (e.g. a checkout form) without truncation. Prefer rootRef for targeted reads.',
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
};

const queryTool = {
  name: 'browser_query',
  description: [
    'Extract structured data from the current page using a shape query.',
    'Provide a query describing the structure you want, and the browser resolves it against the page content.',
    '',
    'Query syntax:',
    '  { field1, field2 }                    - Extract named fields',
    '  { items[] { name, price } }           - Extract arrays of objects',
    '  { login_form { email, password } }    - Extract nested structures',
    '',
    'Field names are matched against element accessible names, roles, and text content.',
    '',
    'If the query cannot be resolved, falls back to returning a smart snapshot of the page.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Shape query describing the data structure to extract. Example: { products[] { name, price } }',
      },
    },
    required: ['query'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
};

const findTool = {
  name: 'browser_find',
  description: [
    'RECOMMENDED: Find interactive elements on the page by intent — use this BEFORE clicking or typing.',
    'Instead of taking a snapshot, reading the whole page, and finding the element yourself,',
    'call browser_find with a description of what you want and get refs back directly.',
    'Then pass the ref to browser_click, browser_type, browser_select_option, etc.',
    '',
    'This saves significant tokens by avoiding full page reads.',
    '',
    'Example: browser_find({ intent: "submit button" })',
    'Returns: [ref=e5] button "Submit" (score: 80)',
    '',
    'Example: browser_find({ intent: "email input field" })',
    'Returns: [ref=e12] textbox "Email Address" (score: 75)',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'Natural language description of what you are looking for. Example: "login form submit button"',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return. Default: 5',
      },
    },
    required: ['intent'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
};

const solveChallengeTool = {
  name: 'browser_solve_challenge',
  description: [
    'Detect and attempt to solve a Cloudflare Turnstile challenge on the current page.',
    'No-op when no challenge is detected (returns solved: true, challengeType: "none").',
    '',
    'Only available when the server was started with --stealth (level != off). Without',
    'stealth the underlying click will not carry a trusted mouse signal and Cloudflare',
    'will reject it.',
    '',
    'Handles non-interactive challenges by waiting for auto-resolution, and',
    'managed/interactive challenges by clicking the Turnstile checkbox with up to',
    '3 attempts. Returns a structured result describing the outcome:',
    '  { solved: boolean, challengeType: string, attempts: number, finalTitle: string, reason?: string }',
    '',
    'If solved is false, escalate to a human or a paid solver (2Captcha, CapSolver).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      maxAttempts: {
        type: 'number',
        description: 'Max click attempts for interactive challenges. Default: 3.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Per-attempt resolution poll timeout in ms. Default: 15000.',
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
  },
};

const CUSTOM_TOOLS = [smartSnapshotTool, queryTool, findTool, solveChallengeTool];
const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map(t => t.name));

module.exports = {
  smartSnapshotTool,
  queryTool,
  findTool,
  solveChallengeTool,
  CUSTOM_TOOLS,
  CUSTOM_TOOL_NAMES,
};
