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

/**
 * Parse a single line content (after "- " prefix and indentation) into a node object.
 * Examples:
 *   'button "Submit" [ref=e5]'
 *   'generic [active] [ref=e1]: Hello, world!'
 *   'navigation:'
 *   'heading "Welcome" [ref=e2]'
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

  // Check if line ends with ":" indicating children (but not after inline text)
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
  // A line like 'generic: Hello' has children indicator AND inline text
  // A line like 'navigation:' just has children indicator
  // A line like 'textbox "Email" [ref=e5]: user@example.com' has inline text
  if (colonIdx !== -1) {
    const afterColon = content.substring(colonIdx + 1).trim();
    // Remove ref and attributes from afterColon to see if there's actual text
    const cleanAfterColon = afterColon
      .replace(/\[ref=[^\]]+\]/g, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/"[^"]*"/g, '')
      .trim();
    if (cleanAfterColon.length > 0) {
      // There's text content after the colon
      node.inlineText = content.substring(colonIdx + 1).trim();
    }
    // If nothing is after the colon, it indicates children
    if (afterColon.length === 0) {
      node.hasChildren = true;
    }
  }

  // Extract role: first word remaining
  const roleMatch = workingContent.match(/^(\S+)/);
  if (roleMatch) {
    // Remove trailing colon from role
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

    // Detect indentation: count leading spaces before "- "
    const indentMatch = line.match(/^(\s*)- (.+)$/);
    if (!indentMatch) {
      // Line without "- " prefix — might be continuation text, skip it
      continue;
    }

    const indent = indentMatch[1].length;
    const depth = indent / 2;
    const content = indentMatch[2];

    const node = parseLine(content);
    node.depth = depth;
    node.children = [];

    // Pop stack until we find the parent (depth < current)
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(node);

    // If this node can have children, push it onto the stack
    if (node.hasChildren || node.role) {
      stack.push(node);
    }
  }

  return root.children;
}

/**
 * Recursively prune the tree, removing decorative nodes and lifting their children.
 */
function pruneTree(nodes) {
  const result = [];

  for (const node of nodes) {
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

    if (hasRef || isInteractive) {
      // Always keep interactive elements and elements with refs
      node.children = prunedChildren;
      result.push(node);
    } else if (isLandmark || isSemantic) {
      // Keep landmark/semantic elements if they have content
      if (hasName || hasText || hasChildren) {
        node.children = prunedChildren;
        result.push(node);
      } else {
        // Empty landmark — skip
      }
    } else if (isPrunable) {
      // Flatten: lift children to parent level
      if (hasName || hasText) {
        // Has meaningful content — keep it but flatten children
        node.children = prunedChildren;
        result.push(node);
      } else {
        // Pure container — lift children
        result.push(...prunedChildren);
      }
    } else {
      // Unknown role — keep if it has content or children
      if (hasRef || hasName || hasText || hasChildren) {
        node.children = prunedChildren;
        result.push(node);
      }
      // Otherwise drop it
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
    const parts = [];

    // Ref comes first for quick scanning
    if (node.ref) {
      parts.push(`[ref=${node.ref}]`);
    }

    // Role
    if (node.role) {
      parts.push(node.role);
    }

    // Quoted name
    if (node.name) {
      parts.push(`"${node.name}"`);
    }

    // Attributes (excluding common noise)
    for (const attr of node.attributes) {
      if (attr !== 'active' && attr !== 'focusable') {
        parts.push(`[${attr}]`);
      }
    }

    // Inline text
    if (node.inlineText) {
      parts.push(`= "${node.inlineText}"`);
    }

    const line = parts.join(' ');

    if (node.children && node.children.length > 0) {
      const isContainer = LANDMARK_ROLES.has(node.role) || SEMANTIC_ROLES.has(node.role);
      if (isContainer && !node.ref) {
        // Container with children: show as header, indent children
        lines.push(`${indent}${line}:`);
        lines.push(...flattenToLines(node.children, depth + 1));
      } else {
        // Element with children: show element, then children at same level
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
 * Main entry point: parse, prune, flatten.
 * Takes raw YAML snapshot text, returns compact ref-based representation.
 */
function smartSnapshot(yamlText) {
  if (!yamlText || !yamlText.trim()) return '';

  const nodes = parseSnapshot(yamlText);
  const pruned = pruneTree(nodes);
  const lines = flattenToLines(pruned);
  return lines.join('\n');
}

module.exports = {
  parseLine,
  parseSnapshot,
  pruneTree,
  flattenToLines,
  smartSnapshot,
  INTERACTIVE_ROLES,
  LANDMARK_ROLES,
  SEMANTIC_ROLES,
  PRUNABLE_ROLES,
};
