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

// Upper bound on maxLines regardless of caller request — guardrail so a bad
// caller can't fill the whole context window. Chosen as ~25x the default.
const MAX_OUTPUT_LINES_CEILING = 2000;

/**
 * Depth-first (left-first) search for a node with the given ref in a parsed AXTree.
 * Iterative to avoid stack overflow on pathologically-nested pages.
 *
 * @param {Array} nodes - Parsed tree from parseSnapshot()
 * @param {string} ref - Target ref to find (e.g. "e5", "f1e3")
 * @returns {object|null} The first matching node in DFS left-first order, or null
 */
function findNodeByRef(nodes, ref) {
  const stack = [];
  // Push in reverse so stack.pop() returns the leftmost sibling first,
  // preserving the intuitive "first match in document order" semantics.
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.ref === ref) return node;
    if (node.children && node.children.length > 0) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return null;
}

/**
 * Valid shape of a ref emitted by Playwright's AXTree.
 * Examples: e5, e123, f1e3, f1e2e5. Anything else (newlines, parens, spaces) is
 * rejected by the backend before it reaches smart-snapshot, which protects the
 * response header from injection and helps callers catch typos early.
 */
const REF_PATTERN = /^[ef]\d+(e\d+)*$/i;

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

  // Decorative/useless images — drop these but keep meaningful ones
  if (node.role === 'img') {
    if (!node.name) return true;
    const imgName = nameLower;
    // Generic decorative names
    if (/^(icon|logo|decoration|decorative|spacer|divider|arrow|bullet|dot|pixel|blank)$/i.test(imgName)) return true;
    // URLs as alt text (lazy/broken alt)
    if (imgName.startsWith('http') || imgName.startsWith('data:') || imgName.startsWith('//')) return true;
    // Single character or very short meaningless alt
    if (imgName.length <= 2) return true;
    // Duplicate of common UI chrome (checkmarks, arrows, icons for buttons)
    if (/^(checkmark|check mark|close|x|menu|hamburger|caret|chevron|dropdown|expand|collapse|search|magnify)$/i.test(imgName)) return true;
    // Keep everything else — product photos, swatches, meaningful content images
    return false;
  }

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
 * Focus on the primary action zone of a page.
 *
 * On e-commerce product pages, the useful content is between the product title
 * and the primary CTA (Add to Cart / Buy Now / Checkout). Everything before
 * (image galleries, breadcrumbs) and after (cross-sells, recommendations,
 * credit card promos, product details accordions) is noise.
 *
 * For non-product pages, returns lines unchanged.
 */
function focusActionZone(lines) {
  // Find the primary heading (product title) — usually the first h1
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/heading\s+"[^"]+"\s+\[level=1\]/.test(lines[i])) {
      titleIdx = i;
      break;
    }
  }

  // Find the primary CTA (Add to Cart, Buy Now, Checkout, Submit, Place Order)
  let ctaIdx = -1;
  const ctaPatterns = [
    /button\s+"[^"]*add\s*to\s*cart/i,
    /button\s+"[^"]*buy\s*now/i,
    /button\s+"[^"]*checkout/i,
    /button\s+"[^"]*place\s*order/i,
    /button\s+"[^"]*submit\s*order/i,
    /button\s+"[^"]*purchase/i,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (ctaPatterns.some(p => p.test(lines[i]))) {
      ctaIdx = i;
      break;
    }
  }

  // If we can't find both markers, return as-is (not a product page)
  if (titleIdx === -1 || ctaIdx === -1) return lines;
  if (ctaIdx <= titleIdx) return lines;

  // Keep: a small context window before the title, everything through CTA + a few lines after
  const contextBefore = 3;
  const contextAfter = 5;
  const start = Math.max(0, titleIdx - contextBefore);
  const end = Math.min(lines.length, ctaIdx + contextAfter + 1);

  const focused = lines.slice(start, end);

  // Add hints about what was trimmed
  if (start > 0) {
    focused.unshift(`(${start} elements above product title omitted — use browser_find to locate)`);
  }
  if (end < lines.length) {
    focused.push(`(${lines.length - end} elements below primary action omitted — use browser_find to locate)`);
  }

  return focused;
}

/**
 * Main entry point: parse, prune, flatten, focus, cap.
 * Takes raw YAML snapshot text, returns compact ref-based representation.
 *
 * @param {string} yamlText - Raw AXTree YAML from Playwright
 * @param {object} [options]
 * @param {number} [options.maxLines=80] - Max output lines before truncation.
 *   The effective value is `min(max(1, floor(maxLines)), MAX_OUTPUT_LINES_CEILING)`.
 *   Zero, negative, NaN, Infinity, or any non-number value falls back to the default.
 * @param {boolean} [options.focusMode=true] - Whether to focus on the action zone
 *   when the flattened output exceeds maxLines. Automatically disabled when a
 *   rootRef is provided (the caller has already scoped the subtree).
 * @param {string} [options.rootRef] - Optional ref (e.g. "e5", "f1e3") to scope
 *   the snapshot to a single subtree. Full YAML is still parsed; the filter runs
 *   post-parse, narrowing to the matched node and its descendants. The matched
 *   node itself is always kept (even if it would otherwise be pruned as a junk
 *   container — the caller explicitly asked for this subtree), but its descendants
 *   are pruned normally. If the ref is not found, returns a one-line notice.
 *   The caller (e.g. enhanced-backend) is responsible for validating the format
 *   and rejecting invalid strings before they reach this function.
 * @returns {string|{text: string, notFound?: boolean, clamped?: boolean}}
 *   When called without options.asStructured, returns a plain string (legacy
 *   interface). When options.asStructured is true, returns a structured object
 *   so the MCP backend can map notFound → isError and expose clamp notices.
 */
function smartSnapshot(yamlText, options) {
  const opts = options || {};
  const structured = opts.asStructured === true;

  const emit = (payload) => structured ? payload : payload.text;

  if (!yamlText || !yamlText.trim()) return emit({ text: '' });

  const rawMax = opts.maxLines;
  const rawMaxIsValid = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0;
  const maxLines = rawMaxIsValid
    ? Math.min(Math.max(1, Math.floor(rawMax)), MAX_OUTPUT_LINES_CEILING)
    : MAX_OUTPUT_LINES;
  const clamped = rawMaxIsValid && rawMax > MAX_OUTPUT_LINES_CEILING;
  const rootRef = (typeof opts.rootRef === 'string' && opts.rootRef.trim()) ? opts.rootRef.trim() : null;
  // Focus mode is a full-page heuristic (h1 → CTA). It makes no sense once we've
  // already narrowed to a subtree, so auto-disable when rootRef is set.
  const focusMode = rootRef
    ? false
    : (opts.focusMode !== undefined ? opts.focusMode : true);

  const nodes = parseSnapshot(yamlText);

  let pruned;
  if (rootRef) {
    const match = findNodeByRef(nodes, rootRef);
    if (!match) {
      return emit({
        text: `(ref "${rootRef}" not found in current snapshot — it may be stale; call browser_smart_snapshot without rootRef, or browser_find, to get a fresh ref)`,
        notFound: true,
      });
    }
    // Keep the matched root even if it's a junk container (caller asked for it
    // explicitly). Prune descendants normally so ads/footers/cross-sells inside
    // the subtree are still stripped.
    const prunedChildren = pruneTree(match.children || []);
    pruned = [{ ...match, children: prunedChildren }];
  } else {
    pruned = pruneTree(nodes);
  }

  let lines = flattenToLines(pruned);

  // Focus on primary action zone if the page is large enough to warrant it
  if (focusMode && lines.length > maxLines) {
    lines = focusActionZone(lines);
  }

  if (lines.length <= maxLines) {
    return emit({ text: lines.join('\n'), clamped });
  }

  // Still too long after focusing — truncate
  const truncated = lines.slice(0, maxLines);
  truncated.push('');
  if (clamped) {
    truncated.push(`... (${lines.length - maxLines} more elements truncated; maxLines clamped from ${rawMax} to ${MAX_OUTPUT_LINES_CEILING})`);
  } else {
    truncated.push(`... (${lines.length - maxLines} more elements truncated)`);
  }
  truncated.push('TIP: Use browser_find({ intent: "..." }) to locate specific elements, or pass { rootRef: "eN" } to scope the snapshot.');
  return emit({ text: truncated.join('\n'), clamped });
}

module.exports = {
  parseLine,
  parseSnapshot,
  pruneTree,
  flattenToLines,
  smartSnapshot,
  findNodeByRef,
  isJunkNode,
  isJunkContainer,
  INTERACTIVE_ROLES,
  LANDMARK_ROLES,
  SEMANTIC_ROLES,
  PRUNABLE_ROLES,
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_LINES_CEILING,
  REF_PATTERN,
};
