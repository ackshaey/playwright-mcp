'use strict';

// Custom MCP tool definitions matching the format that toMcpTool() produces.
// These are JSON Schema objects, not Zod schemas.

const smartSnapshotTool = {
  name: 'browser_smart_snapshot',
  description: [
    'Capture a token-efficient snapshot of the current page.',
    'Returns a pruned, flat list of interactive and semantic elements with compact refs.',
    'Typically uses ~5x fewer tokens than browser_snapshot.',
    'Use this instead of browser_snapshot when you need to conserve context window space.',
    'Format: [ref=eN] role "name" [attributes]',
    'Example output:',
    '  [ref=e1] heading "Welcome"',
    '  navigation:',
    '    [ref=e2] link "Home"',
    '    [ref=e3] link "About"',
    '  [ref=e4] textbox "Email"',
    '  [ref=e5] button "Submit"',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {},
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
    'Find interactive elements on the page by intent description.',
    'Returns a ranked list of matching elements with their refs, roles, and names.',
    'Use this to discover elements before interacting with them via browser_click, browser_type, etc.',
    '',
    'Example: browser_find({ intent: "submit button" })',
    'Returns: [{ ref: "e5", role: "button", name: "Submit", score: 80 }]',
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

const CUSTOM_TOOLS = [smartSnapshotTool, queryTool, findTool];
const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map(t => t.name));

module.exports = {
  smartSnapshotTool,
  queryTool,
  findTool,
  CUSTOM_TOOLS,
  CUSTOM_TOOL_NAMES,
};
