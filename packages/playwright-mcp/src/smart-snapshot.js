'use strict';

// Roles that are interactive — always keep these
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option',
  'searchbox', 'textarea', 'menuitemcheckbox', 'menuitemradio',
  'scrollbar', 'treeitem',
]);

// Landmark/structural roles — keep as section headers
const LANDMARK_ROLES = new Set([
  'navigation', 'search', 'form', 'main', 'banner', 'complementary',
  'contentinfo', 'region', 'dialog', 'alertdialog', 'alert',
]);

// Semantic roles — keep for context
const SEMANTIC_ROLES = new Set([
  'heading', 'img', 'table', 'row', 'cell', 'columnheader', 'rowheader',
  'list', 'listitem', 'progressbar', 'tabpanel', 'tablist', 'menu',
  'toolbar', 'status', 'tree', 'figure', 'separator', 'article',
  'math', 'note', 'definition', 'term', 'feed',
]);

// Roles that should be flattened — their children are lifted to the parent
const PRUNABLE_ROLES = new Set([
  'generic', 'paragraph', 'group', 'presentation', 'none',
  'document', 'application', 'section', 'blockquote', 'code',
  'emphasis', 'strong', 'subscript', 'superscript', 'time',
]);

// --- Junk filters: names and patterns that indicate non-useful page regions ---

// Landmark names that indicate junk regions (matched case-insensitive)
const JUNK_LANDMARK_NAMES = new Set([
  'footer', 'site footer', 'page footer', 'global footer',
  'cookie', 'cookie banner', 'cookie consent', 'cookie notice', 'cookie policy',
  'gdpr', 'privacy banner', 'consent banner', 'consent manager',
  'newsletter', 'newsletter signup', 'subscribe', 'email signup',
  'social media', 'social links', 'follow us', 'connect with us',
  'back to top', 'scroll to top',
  'breadcrumb', 'breadcrumbs',
  'advertisement', 'ad', 'sponsored',
  'chat widget', 'live chat', 'help widget',
  'skip to content', 'skip to main', 'skip navigation',
]);

// Patterns in element names that indicate junk (regex, case-insensitive)
const JUNK_NAME_PATTERNS = [
  /^(©|copyright|\u00a9)/i,
  /cookie\s*(policy|preferences|settings|consent|notice)/i,
  /privacy\s*(policy|notice|settings)/i,
  /terms\s*(of\s*(use|service)|&\s*conditions)/i,
  /do not sell/i,
  /manage\s*(cookies|preferences|consent)/i,
  /accept\s*(all\s*)?(cookies|all)/i,
  /reject\s*(all\s*)?cookies/i,
  /subscribe\s*to\s*(our\s*)?newsletter/i,
  /sign\s*up\s*for\s*(our\s*)?(emails|newsletter)/i,
  /follow\s*us\s*on/i,
  /download\s*(the|our)\s*app/i,
  /accessibility\s*statement/i,
  /site\s*map/i,
  /powered\s*by/i,
];

// Roles that are almost never useful for agent interaction
const JUNK_ROLES = new Set([
  'separator', 'figure', 'math', 'definition', 'term', 'feed',
  'note', 'subscript', 'superscript', 'time',
]);

// Max output lines — if the snapshot exceeds this, truncate and add a hint
const MAX_OUTPUT_LINES = 80;

/**
 * Parse a single line content (after "- " prefix and indentation) into a node object.
 */
function parseLine(content) {
  const node = {
    role: '',
    name: null,
    ref: null,
    attributes: [],
    inlineText: null,
    hasChildren: false,
  };

  let workingContent = content;
  const colonIdx = workingContent.indexOf(':');

  // Extract ref first: [ref=eN] or [ref=fNeN]
  const refMatch = workingContent.match(/\[ref=([^\]]+)\]/);
  if (refMatch) {
    node.ref = refMatch[1];
    workingContent = workingContent.replace(refMatch[0], '').trim();
  }

  // Extract quoted name: "..."
  const nameMatch = workingContent.match(/"([^"]*)"/);
  if (nameMatch) {
    node.name = nameMatch[1];
    workingContent = workingContent.replace(nameMatch[0], '').trim();
  }

  // Extract attributes: [attr] (but not [ref=...] which is already removed)
  const attrRegex = /\[([^\]]+)\]/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(workingContent)) !== null) {
    node.attributes.push(attrMatch[1]);
  }
  workingContent = workingContent.replace(/\[[^\]]+\]/g, '').trim();

  // Extract inline text (after colon at end)
  if (colonIdx !== -1) {
    const afterColon = content.substring(colonIdx + 1).trim();
    const cleanAfterColon = afterColon
      .replace(/\[ref=[^\]]+\]/g, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/"[^"]*"/g, '')
      .trim();
    if (cleanAfterColon.length > 0) {
      node.inlineText = content.substring(colonIdx + 1).trim();
    }
    if (afterColon.length === 0) {
      node.hasChildren = true;
    }
  }

  // Extract role: first word remaining
  const roleMatch = workingContent.match(/^(\S+)/);
  if (roleMatch) {
    node.role = roleMatch[1].replace(/:$/, '');
  }

  return node;
}

/**
 * Parse the full YAML-like snapshot text into a tree of nodes.
 * Uses 2-space indentation to detect nesting.
 */
function parseSnapshot(yamlText) {
  if (!yamlText || !yamlText.trim()) return [];

  const lines = yamlText.split('\n');
  const root = { children: [], depth: -1 };
  const stack = [root];

  for (const line of lines) {
    if (!line.trim()) continue;

    const indentMatch = line.match(/^(\s*)- (.+)$/);
    if (!indentMatch) continue;

    const indent = indentMatch[1].length;
    const depth = indent / 2;
    const content = indentMatch[2];

    const node = parseLine(content);
    node.depth = depth;
    node.children = [];

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(node);

    if (node.hasChildren || node.role) {
      stack.push(node);
    }
  }

  return root.children;
}

/**
 * Check if a node is in a junk region (footer, cookie banner, etc.)
 */
function isJunkNode(node) {
  const nameLower = (node.name || '').toLowerCase().trim();

  // Check if this is a junk landmark by name
  if (JUNK_LANDMARK_NAMES.has(nameLower)) return true;

  // Check junk name patterns
  for (const pattern of JUNK_NAME_PATTERNS) {
    if (pattern.test(nameLower)) return true;
  }

  // contentinfo role = footer in ARIA — drop it entirely
  if (node.role === 'contentinfo') return true;

  // Images — drop all unless they're inside a button/link (handled by parent)
  // Agent can't interact with images directly; they just waste tokens
  if (node.role === 'img') return true;

  // Links with junk destinations
  if (node.role === 'link') {
    if (JUNK_LANDMARK_NAMES.has(nameLower)) return true;
    for (const pattern of JUNK_NAME_PATTERNS) {
      if (pattern.test(nameLower)) return true;
    }
  }

  // Purely decorative roles
  if (JUNK_ROLES.has(node.role) && !node.ref) return true;

  // Noise element patterns by name or inline text
  const textLower = (node.inlineText || '').toLowerCase().trim();
  const combinedText = nameLower + ' ' + textLower;
  const noiseNamePatterns = [
    /zoomable/i,
    /magnification/i,
    /carousel/i,
    /slider\s*control/i,
    /social\s*share/i,
    /share\s*on\s*social/i,
    /hover\s*to\s*zoom/i,
    /item\s*\d+\s*of\s*\d+/i,
    /arrow\s*(up|down|left|right|prev|next)/i,
    /toggle\s*favorite/i,
    /add\s*to\s*favorites/i,
    /add\s*to\s*wishlist/i,
    /rating\s*star/i,
    /^(SKU|sku):/,
  ];
  if (noiseNamePatterns.some(p => p.test(combinedText))) return true;

  return false;
}

/**
 * Check if a node is a junk container whose entire subtree should be dropped.
 * These are landmark nodes wrapping footer/cookie/newsletter sections.
 */
function isJunkContainer(node) {
  const nameLower = (node.name || '').toLowerCase().trim();

  // Footer landmarks
  if (node.role === 'contentinfo') return true;

  // Site header/banner — usually nav chrome, not page content
  if (node.role === 'banner') return true;

  // Common noise sections by heading/name patterns
  const containerNameLower = (node.name || '').toLowerCase();
  const noisePatterns = [
    /also\s*in\s*this\s*collection/i,
    /you\s*may\s*also\s*(like|need|enjoy)/i,
    /recently\s*viewed/i,
    /recommended\s*for\s*you/i,
    /customers\s*also\s*(bought|viewed|liked)/i,
    /similar\s*(items|products)/i,
    /related\s*products/i,
    /trending\s*now/i,
    /shop\s*the\s*look/i,
    /complete\s*the\s*(look|set|room)/i,
    /people\s*also\s*bought/i,
    /social\s*share/i,
  ];
  if (noisePatterns.some(p => p.test(containerNameLower))) return true;

  // Named junk regions
  if ((node.role === 'region' || node.role === 'complementary' || node.role === 'navigation')
      && JUNK_LANDMARK_NAMES.has(nameLower)) {
    return true;
  }

  // Dialog/alert for cookie consent
  if ((node.role === 'dialog' || node.role === 'alertdialog' || node.role === 'alert')
      && /cookie|consent|gdpr|privacy/i.test(nameLower)) {
    return true;
  }

  // Heading that introduces a noise section — drop the heading and its siblings will get caught individually
  if (node.role === 'heading') {
    const headingLower = (node.name || '').toLowerCase();
    const noiseHeadings = [
      /also\s*in\s*this\s*collection/i,
      /you\s*may\s*also\s*(like|need|enjoy)/i,
      /recently\s*viewed/i,
      /recommended\s*for\s*you/i,
      /choose\s*your\s*coordinating/i,
      /complete\s*the\s*(look|set|room)/i,
    ];
    if (noiseHeadings.some(p => p.test(headingLower))) return true;
  }

  return false;
}

/**
 * Recursively prune the tree, removing decorative nodes and lifting their children.
 */
function pruneTree(nodes) {
  const result = [];

  for (const node of nodes) {
    // Drop entire junk containers (footer, cookie banners, etc.)
    if (isJunkContainer(node)) continue;

    // Drop individual junk nodes
    if (isJunkNode(node)) continue;

    // Always recurse into children first
    const prunedChildren = node.children ? pruneTree(node.children) : [];

    const isInteractive = INTERACTIVE_ROLES.has(node.role);
    const isLandmark = LANDMARK_ROLES.has(node.role);
    const isSemantic = SEMANTIC_ROLES.has(node.role);
    const isPrunable = PRUNABLE_ROLES.has(node.role);
    const hasRef = !!node.ref;
    const hasName = !!node.name;
    const hasText = !!node.inlineText;
    const hasChildren = prunedChildren.length > 0;

    if (isInteractive) {
      // Always keep interactive elements
      node.children = prunedChildren;
      result.push(node);
    } else if (hasRef && isPrunable) {
      // Generic/paragraph/group with a ref — keep only if it has meaningful content
      if (hasName || hasText) {
        node.children = prunedChildren;
        result.push(node);
      } else {
        // Ref'd container with no meaningful name — lift children
        result.push(...prunedChildren);
      }
    } else if (hasRef) {
      // Non-prunable, non-interactive element with a ref — keep it
      node.children = prunedChildren;
      result.push(node);
    } else if (isLandmark || isSemantic) {
      if (hasName || hasText || hasChildren) {
        node.children = prunedChildren;
        result.push(node);
      }
    } else if (isPrunable) {
      if (hasName || hasText) {
        node.children = prunedChildren;
        result.push(node);
      } else {
        result.push(...prunedChildren);
      }
    } else {
      if (hasRef || hasName || hasText || hasChildren) {
        node.children = prunedChildren;
        result.push(node);
      }
    }
  }

  return result;
}

/**
 * Convert pruned tree to flat compact lines.
 * Format: [ref=eN] role "name" [attr]: text
 * Indentation capped at 2 levels for landmark containers.
 */
function flattenToLines(nodes, depth) {
  if (depth === undefined) depth = 0;
  const lines = [];
  const indent = '  '.repeat(Math.min(depth, 2));

  for (const node of nodes) {
    // Skip pseudo-property lines that leaked through parsing (e.g., "/url", "text")
    if (node.role && (node.role.startsWith('/') || node.role === 'text')) continue;

    // Skip empty listitems with no name, text, or useful children
    if (node.role === 'listitem' && !node.name && !node.inlineText
        && (!node.children || node.children.length === 0)) continue;

    // Skip empty lists with no children
    if (node.role === 'list' && (!node.children || node.children.length === 0)) continue;

    const parts = [];

    if (node.ref) {
      parts.push(`[ref=${node.ref}]`);
    }

    if (node.role) {
      parts.push(node.role);
    }

    if (node.name) {
      parts.push(`"${node.name}"`);
    }

    for (const attr of node.attributes) {
      if (attr !== 'active' && attr !== 'focusable') {
        parts.push(`[${attr}]`);
      }
    }

    if (node.inlineText) {
      parts.push(`= "${node.inlineText}"`);
    }

    const line = parts.join(' ');

    if (node.children && node.children.length > 0) {
      const isContainer = LANDMARK_ROLES.has(node.role) || SEMANTIC_ROLES.has(node.role);
      if (isContainer && !node.ref) {
        lines.push(`${indent}${line}:`);
        lines.push(...flattenToLines(node.children, depth + 1));
      } else {
        if (line.trim()) lines.push(`${indent}${line}`);
        lines.push(...flattenToLines(node.children, depth));
      }
    } else {
      if (line.trim()) lines.push(`${indent}${line}`);
    }
  }

  return lines;
}

/**
 * Main entry point: parse, prune, flatten, cap.
 * Takes raw YAML snapshot text, returns compact ref-based representation.
 *
 * @param {string} yamlText - Raw AXTree YAML from Playwright
 * @param {object} [options]
 * @param {number} [options.maxLines=80] - Max output lines before truncation
 * @returns {string} Compact snapshot text
 */
function smartSnapshot(yamlText, options) {
  if (!yamlText || !yamlText.trim()) return '';

  const maxLines = (options && options.maxLines) || MAX_OUTPUT_LINES;

  const nodes = parseSnapshot(yamlText);
  const pruned = pruneTree(nodes);
  const lines = flattenToLines(pruned);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  // Truncate and add hint
  const truncated = lines.slice(0, maxLines);
  truncated.push('');
  truncated.push(`... (${lines.length - maxLines} more elements truncated)`);
  truncated.push('TIP: Use browser_find({ intent: "..." }) to locate specific elements.');
  return truncated.join('\n');
}

module.exports = {
  parseLine,
  parseSnapshot,
  pruneTree,
  flattenToLines,
  smartSnapshot,
  isJunkNode,
  isJunkContainer,
  INTERACTIVE_ROLES,
  LANDMARK_ROLES,
  SEMANTIC_ROLES,
  PRUNABLE_ROLES,
  MAX_OUTPUT_LINES,
};
