'use strict';

const { parseSnapshot } = require('./smart-snapshot');

/**
 * Tokenize a shape query string into tokens.
 * Tokens: { } , [] and identifier words.
 */
function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') { tokens.push({ type: 'LBRACE' }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'RBRACE' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA' }); i++; continue; }
    if (ch === '[' && str[i + 1] === ']') { tokens.push({ type: 'ARRAY' }); i += 2; continue; }

    // Identifier: word characters, hyphens, underscores
    const idMatch = str.slice(i).match(/^[\w-]+/);
    if (idMatch) {
      tokens.push({ type: 'IDENT', value: idMatch[0] });
      i += idMatch[0].length;
      continue;
    }

    // Skip unknown characters
    i++;
  }
  return tokens;
}

/**
 * Parse tokenized query into AST.
 * Grammar:
 *   query  := '{' fields '}'
 *   fields := field (',' field)*
 *   field  := IDENT ['[]'] [query]
 */
function parseQuery(queryStr) {
  const tokens = tokenize(queryStr);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume(type) {
    const t = tokens[pos];
    if (!t || t.type !== type) return null;
    pos++;
    return t;
  }

  function parseFields() {
    const fields = [];
    while (peek() && peek().type !== 'RBRACE') {
      const ident = consume('IDENT');
      if (!ident) break;

      const field = { name: ident.value, isArray: false, children: null };

      if (peek() && peek().type === 'ARRAY') {
        consume('ARRAY');
        field.isArray = true;
      }

      if (peek() && peek().type === 'LBRACE') {
        consume('LBRACE');
        field.children = { type: 'object', fields: parseFields() };
        consume('RBRACE');
      }

      fields.push(field);
      consume('COMMA'); // optional trailing comma
    }
    return fields;
  }

  if (!consume('LBRACE')) {
    return { type: 'object', fields: [] };
  }
  const fields = parseFields();
  consume('RBRACE');

  return { type: 'object', fields };
}

/**
 * Flatten all nodes in the tree into a single array (depth-first).
 */
function flattenNodes(nodes) {
  const result = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children && node.children.length > 0) {
      result.push(...flattenNodes(node.children));
    }
  }
  return result;
}

/**
 * Normalize a string for comparison: lowercase, replace hyphens/underscores with spaces.
 */
function normalize(str) {
  return (str || '').toLowerCase().replace(/[-_]/g, ' ').trim();
}

/**
 * Score how well a node matches a field name.
 * Higher = better match.
 */
function scoreMatch(fieldName, node) {
  const normalizedField = normalize(fieldName);
  const fieldWords = normalizedField.split(/\s+/);
  let score = 0;

  const normalizedName = normalize(node.name);
  const normalizedRole = normalize(node.role);
  const normalizedText = normalize(node.inlineText);

  // Exact name match
  if (normalizedName === normalizedField) {
    score += 100;
  }
  // Name contains field
  else if (normalizedName && normalizedName.includes(normalizedField)) {
    score += 60;
  }
  // Field contains name
  else if (normalizedName && normalizedField.includes(normalizedName)) {
    score += 50;
  }

  // Word-level matching against name
  for (const word of fieldWords) {
    if (word.length < 2) continue;
    if (normalizedName && normalizedName.includes(word)) score += 25;
    if (normalizedRole && normalizedRole.includes(word)) score += 15;
    if (normalizedText && normalizedText.includes(word)) score += 10;
  }

  // Role match (e.g., field "submit_button" matches role "button")
  if (normalizedRole === normalizedField) {
    score += 30;
  }

  // Text content match
  if (normalizedText === normalizedField) {
    score += 40;
  } else if (normalizedText && normalizedText.includes(normalizedField)) {
    score += 20;
  }

  return score;
}

/**
 * Resolve a scalar field against a flat list of nodes.
 * Returns the best matching node's value, or null.
 */
function resolveScalar(fieldName, allNodes) {
  let bestScore = 0;
  let bestNode = null;

  for (const node of allNodes) {
    const score = scoreMatch(fieldName, node);
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  if (bestScore < 20) return null; // Too low confidence

  return {
    value: bestNode.name || bestNode.inlineText || bestNode.role,
    ref: bestNode.ref,
    role: bestNode.role,
    score: bestScore,
  };
}

/**
 * Find repeating groups in the tree for array resolution.
 * Looks for listitem, row, or repeated sibling patterns.
 */
function findRepeatingGroups(nodes) {
  // Look for list items
  const listItems = [];
  function findListItems(nodeList) {
    for (const node of nodeList) {
      if (node.role === 'listitem' || node.role === 'row') {
        listItems.push(node);
      }
      if (node.children) findListItems(node.children);
    }
  }
  findListItems(nodes);

  if (listItems.length >= 2) {
    return listItems;
  }

  // Fall back to looking for repeated sibling patterns
  for (const node of nodes) {
    if (node.children && node.children.length >= 2) {
      const roles = node.children.map(c => c.role);
      const firstRole = roles[0];
      if (firstRole && roles.every(r => r === firstRole)) {
        return node.children;
      }
    }
  }

  return [];
}

/**
 * Resolve an array field against nodes.
 */
function resolveArray(field, allNodes, treeNodes) {
  const groups = findRepeatingGroups(treeNodes);
  if (groups.length === 0) return null;

  if (field.children) {
    return groups.map(group => {
      const groupNodes = flattenNodes([group]);
      return resolveObject(field.children, groupNodes);
    }).filter(item => item !== null);
  }

  return groups.map(group => ({
    value: group.name || group.inlineText || null,
    ref: group.ref,
    role: group.role,
  }));
}

/**
 * Resolve an object query against nodes.
 */
function resolveObject(query, allNodes) {
  const result = {};
  let matched = 0;

  for (const field of query.fields) {
    if (field.isArray) {
      const arrayResult = resolveArray(field, allNodes, allNodes);
      if (arrayResult && arrayResult.length > 0) {
        result[field.name] = arrayResult;
        matched++;
      } else {
        result[field.name] = [];
      }
    } else if (field.children) {
      // Nested object — try to scope to a matching region
      const regionNode = findRegion(field.name, allNodes);
      const scopedNodes = regionNode
        ? flattenNodes(regionNode.children || [])
        : allNodes;
      const nested = resolveObject(field.children, scopedNodes);
      if (nested) {
        result[field.name] = nested;
        matched++;
      }
    } else {
      const scalar = resolveScalar(field.name, allNodes);
      if (scalar) {
        result[field.name] = scalar;
        matched++;
      } else {
        result[field.name] = null;
      }
    }
  }

  // If less than half the fields matched, consider it a failure
  if (matched < query.fields.length / 2) return null;

  return result;
}

/**
 * Find a region node matching the given name (for scoping nested queries).
 */
function findRegion(name, nodes) {
  const normalizedName = normalize(name);
  let best = null;
  let bestScore = 0;

  function search(nodeList) {
    for (const node of nodeList) {
      const score = scoreMatch(name, node);
      if (score > bestScore && node.children && node.children.length > 0) {
        bestScore = score;
        best = node;
      }
      if (node.children) search(node.children);
    }
  }

  search(nodes);
  return bestScore >= 20 ? best : null;
}

/**
 * Main entry point: resolve a query string against snapshot YAML.
 * Returns { data, level } or { fallback: 'smart_snapshot', level }.
 */
function resolveQuery(queryStr, snapshotYaml) {
  const query = parseQuery(queryStr);
  if (query.fields.length === 0) {
    return { data: null, level: 'error', error: 'Empty or invalid query' };
  }

  const treeNodes = parseSnapshot(snapshotYaml);
  const allNodes = flattenNodes(treeNodes);

  const result = resolveObject(query, allNodes);
  if (result) {
    return { data: result, level: 1 };
  }

  // Resolution failed — return null so caller can fall back
  return { data: null, level: 3, fallback: 'smart_snapshot' };
}

module.exports = {
  tokenize,
  parseQuery,
  resolveQuery,
  scoreMatch,
  flattenNodes,
};
