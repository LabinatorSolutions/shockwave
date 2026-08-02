// Multi-strategy fuzzy find-and-replace — the engine behind the skill `patch`
// action.
//
// PORTED FROM hermes-agent `tools/fuzzy_match.py` (967 lines), which is itself
// inspired by OpenCode's chain. The port is deliberately literal: same strategy
// order, same thresholds, same error strings, same comments. The comments are
// the most valuable part of this file — nearly every one records a bug that was
// found in production, and rewording them loses the evidence for why the code
// is shaped this way.
//
// WHY IT EXISTS: an LLM asked to patch a file sends `old_string` from memory or
// from a paraphrase of what it read. The whitespace, indentation, quote style,
// and escaping drift. An exact-match-only patch tool fails on all of that and
// the model burns turns re-reading and retrying. The chain accepts the drift on
// the MATCH side while keeping the WRITE side honest — which is what the three
// guards (escape-drift, unescape, unicode-preservation) are for.
//
// The 9-strategy chain, tried in order:
//   1. exact                  — direct string comparison
//   2. line_trimmed           — strip leading/trailing whitespace per line
//   3. whitespace_normalized  — collapse runs of spaces/tabs to one space
//   4. indentation_flexible   — ignore indentation entirely
//   5. escape_normalized      — convert \n / \t / \r literals to real bytes
//   6. trimmed_boundary       — trim first/last line whitespace only
//   7. unicode_normalized     — smart quotes / dashes / space family → ASCII
//   8. block_anchor           — match first+last lines, similarity for middle
//   9. context_aware          — 50% line-similarity threshold
//
// Multi-occurrence matching is handled via the replaceAll flag.
//
// NOT taken from knack's `lib/files/fuzzy-match.ts`, which is a faithful port of
// an OLDER revision and is missing four fixes: the exact-match cursor advance
// (#56211, corrupts files under replaceAll), unicode preservation on replacement,
// the Unicode minus + Zs space family, and the gated trailing-space expansion
// (#52491). Each is pinned by a named test in `tests/fuzzyMatch.test.js`.

const UNICODE_MAP: Record<string, string> = {
  '\u201c': '"', '\u201d': '"',    // smart double quotes
  '\u2018': "'", '\u2019': "'",    // smart single quotes
  '\u2014': '--', '\u2013': '-',   // em/en dashes
  '\u2026': '...', '\u00a0': ' ',  // ellipsis and non-breaking space
  // Unicode minus sign — models type ASCII '-' for file content that uses
  // the typographic minus (math/scientific docs).
  '\u2212': '-',
  // Space-separator family (Zs) beyond NBSP. Files with typographic spacing
  // (en/em/thin spaces, narrow NBSP in French text, ideographic space in CJK
  // text) never match a model's ASCII-space old_string via the precise
  // strategies, falling through to the similarity-based context_aware fallback
  // — which can pick the wrong region and flattens the file's Unicode on
  // replacement.
  '\u2000': ' ', '\u2001': ' ',                  // en/em quad
  '\u2002': ' ', '\u2003': ' ',                  // en/em space
  '\u2004': ' ', '\u2005': ' ', '\u2006': ' ',   // three/four/six-per-em
  '\u2007': ' ', '\u2008': ' ',                  // figure/punctuation space
  '\u2009': ' ', '\u200a': ' ',                  // thin/hair space
  '\u202f': ' ',                                 // narrow no-break space
  '\u205f': ' ',                                 // medium mathematical space
  '\u3000': ' ',                                 // ideographic (CJK full-width) space
};

/** A matched span in the ORIGINAL content: [start, end). */
type Match = [start: number, end: number];

/** One difflib opcode: [tag, i1, i2, j1, j2]. */
type Opcode = [tag: string, i1: number, i2: number, j1: number, j2: number];

export interface FuzzyResult {
  content: string;
  count: number;
  strategy: string | null;
  error: string | null;
}

/** Normalize Unicode characters to their standard ASCII equivalents. */
function unicodeNormalize(text: string): string {
  let out = text;
  for (const [ch, repl] of Object.entries(UNICODE_MAP)) out = out.split(ch).join(repl);
  return out;
}

/**
 * Find and replace text using a chain of increasingly fuzzy matching strategies.
 *
 * Success → the modified content, the number of replacements, the strategy that
 * matched, and a null error. Failure → the ORIGINAL content, 0, null, and a
 * description.
 */
export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): FuzzyResult {
  if (!oldString) {
    return { content, count: 0, strategy: null, error: 'old_string cannot be empty' };
  }
  if (oldString === newString) {
    return { content, count: 0, strategy: null, error: 'old_string and new_string are identical' };
  }

  const strategies: [string, (c: string, p: string) => Match[]][] = [
    ['exact', strategyExact],
    ['line_trimmed', strategyLineTrimmed],
    ['whitespace_normalized', strategyWhitespaceNormalized],
    ['indentation_flexible', strategyIndentationFlexible],
    ['escape_normalized', strategyEscapeNormalized],
    ['trimmed_boundary', strategyTrimmedBoundary],
    ['unicode_normalized', strategyUnicodeNormalized],
    ['block_anchor', strategyBlockAnchor],
    ['context_aware', strategyContextAware],
  ];

  for (const [name, fn] of strategies) {
    const matches = fn(content, oldString);
    if (!matches.length) continue;

    if (matches.length > 1 && !replaceAll) {
      return {
        content, count: 0, strategy: null,
        error: `Found ${matches.length} matches for old_string. `
          + 'Provide more context to make it unique, or use replace_all=true.',
      };
    }

    // Escape-drift guard: when the matched strategy is NOT `exact`, we matched
    // via some form of normalization. If new_string contains shell/JSON-style
    // escape sequences (\' or \") that would be written literally into the file
    // but the matched region of the file has no such sequences, this is almost
    // certainly tool-call serialization drift — the model typed an
    // apostrophe/quote and the transport added a stray backslash. Writing
    // new_string as-is would corrupt the file. Block with a helpful error so the
    // model re-reads and retries instead of the caller silently persisting
    // garbage (or not).
    if (name !== 'exact') {
      const driftErr = detectEscapeDrift(content, matches, oldString, newString);
      if (driftErr) return { content, count: 0, strategy: null, error: driftErr };
    }

    // Perform replacement. When the matched strategy is NOT `exact`, the file's
    // indentation may differ from what the LLM sent in old_string/new_string —
    // e.g. LLM used 2-space indent but the file is 4-space. Shift new_string by
    // the indentation delta so the replacement matches the file's actual indent
    // pattern.
    //
    // LLMs frequently serialize tabs / carriage returns in JSON tool-call
    // arguments as the two-character sequences `\t` and `\r` (backslash +
    // letter) instead of the real control bytes. If we write new_string
    // verbatim, the file ends up with literal backslash sequences where the
    // surrounding code uses real tabs.
    let effectiveNew = maybeUnescapeNewString(newString, content, matches);

    // Unicode-preservation guard: when strategy 7 (unicode_normalized) matched,
    // the file has Unicode characters (em-dashes, smart quotes, ellipsis) but
    // old_string/new_string from the LLM are ASCII equivalents. Writing
    // new_string verbatim would silently corrupt the file's Unicode — em-dashes
    // become two hyphens, smart quotes become straight quotes. Align the
    // replacement with the file's actual Unicode so only the LLM's intended
    // changes are applied and unchanged portions keep their original characters.
    if (name === 'unicode_normalized') {
      effectiveNew = preserveUnicodeInReplacement(content, matches, oldString, effectiveNew);
    }

    const newContent = applyReplacements(
      content, matches, effectiveNew, name !== 'exact' ? oldString : null,
    );
    return { content: newContent, count: matches.length, strategy: name, error: null };
  }

  return { content, count: 0, strategy: null, error: 'Could not find a match for old_string in the file' };
}

/**
 * Detect tool-call escape-drift artifacts in new_string.
 *
 * Looks for `\'` or `\"` sequences present in BOTH old_string and new_string
 * (i.e. the model copy-pasted them as "context" it intended to preserve) but
 * absent from the matched region of the file. That pattern indicates the
 * transport layer inserted spurious shell-style escapes around apostrophes or
 * quotes — writing new_string verbatim would literally insert `\'` into the file.
 */
function detectEscapeDrift(
  content: string, matches: Match[], oldString: string, newString: string,
): string | null {
  // Cheap pre-check: bail out unless new_string actually contains a suspect
  // escape sequence. This keeps the guard free for all the common, correct cases.
  if (!newString.includes("\\'") && !newString.includes('\\"')) return null;

  // Aggregate matched regions of the file — that's what new_string will replace.
  // If the suspect escapes are present there already, the model is genuinely
  // preserving them (valid for some languages / escaped strings); accept the patch.
  const matchedRegions = matches.map(([s, e]) => content.slice(s, e)).join('');

  for (const suspect of ["\\'", '\\"']) {
    if (newString.includes(suspect) && oldString.includes(suspect) && !matchedRegions.includes(suspect)) {
      const plain = suspect[1]; // "'" or '"'
      return `Escape-drift detected: old_string and new_string contain the literal `
        + `sequence ${JSON.stringify(suspect)} but the matched region of the file `
        + `does not. This is almost always a tool-call serialization artifact where `
        + `an apostrophe or quote got prefixed with a spurious backslash. Re-read `
        + `the file and pass old_string/new_string without backslash-escaping `
        + `${JSON.stringify(plain)} characters.`;
    }
  }
  return null;
}

/** The leading whitespace prefix of a line (spaces/tabs). */
function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(0, i);
}

/** The first line of `text` with any non-whitespace content, else null. */
function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split('\n')) if (line.trim()) return line;
  return null;
}

/**
 * Adjust `newString` so its indentation matches `fileRegion`.
 *
 * Used after a non-exact fuzzy match: the LLM may have sent old_string and
 * new_string with a different indent than the file actually has (e.g. 2-space
 * indent in tool args vs 4-space indent on disk). The fuzzy strategy
 * successfully matched anyway, but writing `newString` verbatim would corrupt
 * the file's indentation.
 *
 * For each non-blank line of new_string, compute its indent relative to the
 * shallowest non-blank line of old_string (the LLM's base indent), then anchor
 * that relative indent onto the file's actual base indent. Blank lines and lines
 * less-indented than the LLM's base are anchored directly to the file's base.
 *
 * No-op when fileRegion or oldString has no meaningful line, when the two base
 * indents are equal, or when newString is empty.
 */
function reindentReplacement(fileRegion: string, oldString: string, newString: string): string {
  if (!newString) return newString;

  const oldFirst = firstMeaningfulLine(oldString);
  const fileFirst = firstMeaningfulLine(fileRegion);
  if (oldFirst === null || fileFirst === null) return newString;

  const oldIndent = leadingWhitespace(oldFirst);
  const fileIndent = leadingWhitespace(fileFirst);
  if (oldIndent === fileIndent) return newString;

  // Replace the LLM's base indent prefix with the file's base indent prefix,
  // preserving any additional indent the LLM added on top. Same approach Roo
  // Code uses (multi-search-replace.ts:466-500). It preserves the LLM's
  // intended *relative* nesting between lines while anchoring to the file's
  // actual indent style.
  const out: string[] = [];
  for (const line of newString.split('\n')) {
    if (!line.trim()) {
      // Blank lines: leave whitespace untouched.
      out.push(line);
      continue;
    }
    const lineIndent = leadingWhitespace(line);
    if (lineIndent.startsWith(oldIndent)) {
      // Common case: line has the LLM's base indent (possibly plus extra).
      // Swap base prefix for the file's base prefix.
      out.push(fileIndent + line.slice(oldIndent.length));
    } else {
      // Line is less-indented than the LLM's base — e.g. a dedent at the start
      // of new_string. Anchor to the file's base.
      out.push(fileIndent + line.replace(/^[ \t]+/, ''));
    }
  }
  return out.join('\n');
}

/**
 * Conditionally unescape `\t` / `\r` in new_string.
 *
 * LLMs frequently send the two-character sequences `\t` and `\r` inside JSON
 * tool-call arguments where they meant a real tab or carriage-return byte.
 * Writing the string verbatim corrupts tab-indented files with literal
 * backslash-letter pairs.
 *
 * The unescape is only applied per-sequence when the *matched region of the
 * file* actually contains the corresponding control character. Files that
 * legitimately contain the literal two-character string `"\t"` (e.g. a source
 * line that defines `sep = "\t"`) get a backslash+t in the matched region
 * instead of a tab, so we leave new_string alone.
 *
 * `\n` is intentionally excluded: newlines serialize correctly through JSON and
 * rewriting backslash-n would corrupt escape sequences in string literals far
 * more often than it would help.
 */
function maybeUnescapeNewString(newString: string, content: string, matches: Match[]): string {
  // Cheap pre-check — bail out unless new_string actually contains one of the
  // suspect sequences. Keeps the common case free.
  if (!newString.includes('\\t') && !newString.includes('\\r')) return newString;

  const matchedRegions = matches.map(([s, e]) => content.slice(s, e)).join('');
  let out = newString;
  if (out.includes('\\t') && matchedRegions.includes('\t')) out = out.split('\\t').join('\t');
  if (out.includes('\\r') && matchedRegions.includes('\r')) out = out.split('\\r').join('\r');
  return out;
}

/**
 * Preserve Unicode characters from the file in the replacement string.
 *
 * When strategy 7 (unicode_normalized) matched, the file has Unicode characters
 * (em-dashes, smart quotes, ellipsis, non-breaking spaces) but
 * old_string/new_string from the LLM are ASCII equivalents. Writing new_string
 * verbatim would silently corrupt the file's Unicode.
 *
 * This aligns the replacement with the file's actual Unicode by diffing
 * old_string→new_string and applying only the actual edits to the file's
 * original text, preserving Unicode for unchanged portions.
 */
function preserveUnicodeInReplacement(
  content: string, matches: Match[], oldString: string, newString: string,
): string {
  // Aggregate the matched file regions.
  const fileRegion = matches.map(([s, e]) => content.slice(s, e)).join('');

  // Normalize both for comparison.
  const normOld = unicodeNormalize(oldString);
  const normFile = unicodeNormalize(fileRegion);

  // If the normalized forms don't match, the strategy shouldn't have fired —
  // fall back to direct replacement.
  if (normOld !== normFile) return newString;

  // Build position maps from normalized space back to original space.
  // UNICODE_MAP replacements can expand characters (em-dash → '--'), so
  // normalized positions don't map 1:1 to original positions. Reuse
  // buildOrigToNormMap, then invert it (same inversion as
  // mapPositionsNormToOrig) to get norm→orig lookups.
  const fileOrigToNorm = buildOrigToNormMap(fileRegion);
  const fileNormToOrig = new Map<number, number>();
  for (let origPos = 0; origPos < fileOrigToNorm.length - 1; origPos++) {
    const np = fileOrigToNorm[origPos];
    if (!fileNormToOrig.has(np)) fileNormToOrig.set(np, origPos);
  }

  // Diff normOld → newString to find the actual edits.
  const opcodes = getOpcodes(normOld, newString);

  // Apply edits to fileRegion, preserving Unicode for unchanged spans.
  const parts: string[] = [];
  for (const [tag, i1, i2, j1, j2] of opcodes) {
    if (tag === 'equal') {
      // Keep the original fileRegion text for this span.
      const origStart = fileNormToOrig.has(i1) ? (fileNormToOrig.get(i1) as number) : 0;
      let origEnd = origStart;
      while (origEnd < fileRegion.length && fileOrigToNorm[origEnd] < i2) origEnd++;
      parts.push(fileRegion.slice(origStart, origEnd));
    } else if (tag === 'replace') {
      parts.push(newString.slice(j1, j2));
    } else if (tag === 'delete') {
      // skip deleted portion
    } else if (tag === 'insert') {
      parts.push(newString.slice(j1, j2));
    }
  }
  return parts.join('');
}

/**
 * Apply replacements at the given positions.
 *
 * `oldString` non-null signals that the match came from a non-exact fuzzy
 * strategy; `newString` is re-indented to match the file's actual indentation
 * before substitution.
 */
function applyReplacements(
  content: string, matches: Match[], newString: string, oldString: string | null = null,
): string {
  // Sort matches by position (descending) to replace from end to start. This
  // preserves the positions of earlier matches.
  const sorted = [...matches].sort((a, b) => b[0] - a[0]);

  let result = content;
  for (const [start, end] of sorted) {
    const adjusted = oldString !== null
      ? reindentReplacement(content.slice(start, end), oldString, newString)
      : newString;
    result = result.slice(0, start) + adjusted + result.slice(end);
  }
  return result;
}

// =============================================================================
// Matching Strategies
// =============================================================================

/** Strategy 1: Exact string match. */
function strategyExact(content: string, pattern: string): Match[] {
  const matches: Match[] = [];
  let start = 0;
  for (;;) {
    const pos = content.indexOf(pattern, start);
    if (pos === -1) break;
    matches.push([pos, pos + pattern.length]);
    // Advance past the whole match, not just one char, so self-overlapping
    // patterns (e.g. "aa" in "aaaa") produce non-overlapping spans matching
    // String.replaceAll() semantics. Advancing by 1 yielded overlapping matches
    // that corrupt the file under replaceAll=true (reverse-order apply on stale
    // offsets).
    start = pos + pattern.length;
  }
  return matches;
}

/** Strategy 2: Match with line-by-line whitespace trimming. */
function strategyLineTrimmed(content: string, pattern: string): Match[] {
  const patternNormalized = pattern.split('\n').map((l) => l.trim()).join('\n');
  const contentLines = content.split('\n');
  const contentNormalizedLines = contentLines.map((l) => l.trim());
  return findNormalizedMatches(content, contentLines, contentNormalizedLines, patternNormalized);
}

/** Strategy 3: Collapse runs of spaces/tabs to a single space (newlines kept). */
function strategyWhitespaceNormalized(content: string, pattern: string): Match[] {
  const normalize = (s: string) => s.replace(/[ \t]+/g, ' ');
  const patternNormalized = normalize(pattern);
  const contentNormalized = normalize(content);

  const matchesInNormalized = strategyExact(contentNormalized, patternNormalized);
  if (!matchesInNormalized.length) return [];

  return mapNormalizedPositions(content, contentNormalized, matchesInNormalized);
}

/** Strategy 4: Ignore indentation differences entirely. */
function strategyIndentationFlexible(content: string, pattern: string): Match[] {
  const contentLines = content.split('\n');
  const contentStrippedLines = contentLines.map((l) => l.replace(/^\s+/, ''));
  const patternNormalized = pattern.split('\n').map((l) => l.replace(/^\s+/, '')).join('\n');
  return findNormalizedMatches(content, contentLines, contentStrippedLines, patternNormalized);
}

/** Strategy 5: Convert escape sequences to actual characters. */
function strategyEscapeNormalized(content: string, pattern: string): Match[] {
  const unescape = (s: string) => s.split('\\n').join('\n').split('\\t').join('\t').split('\\r').join('\r');
  const patternUnescaped = unescape(pattern);
  // No escapes to convert, skip this strategy.
  if (patternUnescaped === pattern) return [];
  return strategyExact(content, patternUnescaped);
}

/** Strategy 6: Trim whitespace from first and last lines only. */
function strategyTrimmedBoundary(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n');
  if (!patternLines.length) return [];

  patternLines[0] = patternLines[0].trim();
  if (patternLines.length > 1) patternLines[patternLines.length - 1] = patternLines[patternLines.length - 1].trim();
  const modifiedPattern = patternLines.join('\n');

  const contentLines = content.split('\n');
  const matches: Match[] = [];
  const count = patternLines.length;

  for (let i = 0; i <= contentLines.length - count; i++) {
    const checkLines = contentLines.slice(i, i + count);
    checkLines[0] = checkLines[0].trim();
    if (checkLines.length > 1) checkLines[checkLines.length - 1] = checkLines[checkLines.length - 1].trim();
    if (checkLines.join('\n') === modifiedPattern) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

/**
 * Map each original character index to its normalized index.
 *
 * Because UNICODE_MAP replacements may expand characters (em-dash → '--',
 * ellipsis → '...'), the normalized string can be longer than the original.
 * This map converts positions in the normalized string back to the original.
 *
 * Returns an array of length `original.length + 1`; the last entry is a
 * sentinel one past the last character.
 */
function buildOrigToNormMap(original: string): number[] {
  const result: number[] = [];
  let normPos = 0;
  for (const char of original) {
    result.push(normPos);
    const repl = UNICODE_MAP[char];
    normPos += repl !== undefined ? repl.length : 1;
  }
  result.push(normPos);
  return result;
}

/** Convert (start, end) positions in the normalized string to original positions. */
function mapPositionsNormToOrig(origToNorm: number[], normMatches: Match[]): Match[] {
  // Invert the map: normPos -> first original position with that normPos.
  const normToOrigStart = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
    const normPos = origToNorm[origPos];
    if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
  }

  const results: Match[] = [];
  const origLen = origToNorm.length - 1; // number of original characters

  for (const [normStart, normEnd] of normMatches) {
    if (!normToOrigStart.has(normStart)) continue;
    const origStart = normToOrigStart.get(normStart) as number;

    // Walk forward until origToNorm[origEnd] >= normEnd.
    let origEnd = origStart;
    while (origEnd < origLen && origToNorm[origEnd] < normEnd) origEnd++;

    results.push([origStart, origEnd]);
  }
  return results;
}

/**
 * Strategy 7: Unicode normalization.
 *
 * Normalizes smart quotes, em/en-dashes, ellipsis, and the space-separator
 * family to their ASCII equivalents in both content and pattern, then runs
 * exact and line_trimmed matching on the normalized copies.
 *
 * Positions are mapped back to the ORIGINAL string via buildOrigToNormMap —
 * necessary because some UNICODE_MAP replacements expand a single character
 * into multiple ASCII characters, making a naive position copy incorrect.
 */
function strategyUnicodeNormalized(content: string, pattern: string): Match[] {
  // Normalize both sides. Either the content or the pattern (or both) may carry
  // unicode variants — e.g. content has an em-dash that should match the LLM's
  // ASCII '--', or vice-versa. Skip only when neither changes.
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  if (normContent === content && normPattern === pattern) return [];

  let normMatches = strategyExact(normContent, normPattern);
  if (!normMatches.length) normMatches = strategyLineTrimmed(normContent, normPattern);
  if (!normMatches.length) return [];

  const origToNorm = buildOrigToNormMap(content);
  return mapPositionsNormToOrig(origToNorm, normMatches);
}

/**
 * Strategy 8: Match by anchoring on first and last lines.
 * Permissive thresholds plus unicode normalization.
 */
function strategyBlockAnchor(content: string, pattern: string): Match[] {
  // Normalize both strings for comparison while keeping original content for
  // offset calculation.
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);

  const patternLines = normPattern.split('\n');
  if (patternLines.length < 2) return [];

  const firstLine = patternLines[0].trim();
  const lastLine = patternLines[patternLines.length - 1].trim();

  // Use normalized lines for matching logic, BUT original lines for calculating
  // start/end positions to prevent index shift.
  const normContentLines = normContent.split('\n');
  const origContentLines = content.split('\n');
  const count = patternLines.length;

  const potential: number[] = [];
  for (let i = 0; i <= normContentLines.length - count; i++) {
    if (normContentLines[i].trim() === firstLine
      && normContentLines[i + count - 1].trim() === lastLine) {
      potential.push(i);
    }
  }

  const matches: Match[] = [];
  // Thresholding logic: 0.50 for unique matches, 0.70 for multiple candidates.
  // Previous values (0.10 / 0.30) were dangerously loose — a 10% middle-section
  // similarity could match completely unrelated blocks.
  const threshold = potential.length === 1 ? 0.50 : 0.70;

  for (const i of potential) {
    let similarity: number;
    if (count <= 2) {
      similarity = 1.0;
    } else {
      // Compare normalized middle sections.
      const contentMiddle = normContentLines.slice(i + 1, i + count - 1).join('\n');
      const patternMiddle = patternLines.slice(1, -1).join('\n');
      similarity = ratio(contentMiddle, patternMiddle);
    }
    if (similarity >= threshold) {
      // Calculate positions using ORIGINAL lines to ensure correct character
      // offsets in the file.
      matches.push(calculateLinePositions(origContentLines, i, i + count, content.length));
    }
  }
  return matches;
}

/**
 * Strategy 9: Line-by-line similarity with a 50% threshold.
 * Finds blocks where at least 50% of lines have high (≥0.80) similarity.
 */
function strategyContextAware(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n');
  const contentLines = content.split('\n');
  if (!patternLines.length) return [];

  const matches: Match[] = [];
  const count = patternLines.length;

  for (let i = 0; i <= contentLines.length - count; i++) {
    const blockLines = contentLines.slice(i, i + count);

    // Calculate line-by-line similarity.
    let highSimilarityCount = 0;
    for (let k = 0; k < count; k++) {
      if (ratio(patternLines[k].trim(), blockLines[k].trim()) >= 0.80) highSimilarityCount++;
    }

    // Need at least 50% of lines to have high similarity.
    if (highSimilarityCount >= patternLines.length * 0.5) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

// =============================================================================
// Helper Functions
// =============================================================================

/** Calculate start/end character positions from line indices. */
function calculateLinePositions(
  contentLines: string[], startLine: number, endLine: number, contentLength: number,
): Match {
  let startPos = 0;
  for (let i = 0; i < startLine; i++) startPos += contentLines[i].length + 1;
  let endPos = 0;
  for (let i = 0; i < endLine; i++) endPos += contentLines[i].length + 1;
  endPos = Math.min(contentLength, endPos - 1);
  return [startPos, endPos];
}

/** Find matches in normalized content and map back to original positions. */
function findNormalizedMatches(
  content: string, contentLines: string[], contentNormalizedLines: string[], patternNormalized: string,
): Match[] {
  const patternNormLines = patternNormalized.split('\n');
  const numPatternLines = patternNormLines.length;
  const matches: Match[] = [];

  for (let i = 0; i <= contentNormalizedLines.length - numPatternLines; i++) {
    const block = contentNormalizedLines.slice(i, i + numPatternLines).join('\n');
    if (block === patternNormalized) {
      matches.push(calculateLinePositions(contentLines, i, i + numPatternLines, content.length));
    }
  }
  return matches;
}

/**
 * Map positions from a normalized string back to the original.
 * Best-effort mapping that works for whitespace normalization.
 */
function mapNormalizedPositions(
  original: string, normalized: string, normalizedMatches: Match[],
): Match[] {
  if (!normalizedMatches.length) return [];

  // Build character mapping from original to normalized.
  const origToNorm: number[] = [];
  let origIdx = 0;
  let normIdx = 0;

  while (origIdx < original.length && normIdx < normalized.length) {
    if (original[origIdx] === normalized[normIdx]) {
      origToNorm.push(normIdx);
      origIdx++;
      normIdx++;
    } else if ((original[origIdx] === ' ' || original[origIdx] === '\t') && normalized[normIdx] === ' ') {
      // Original has space/tab, normalized collapsed to space.
      origToNorm.push(normIdx);
      origIdx++;
      // Don't advance normIdx yet — wait until all whitespace is consumed.
      if (origIdx < original.length && original[origIdx] !== ' ' && original[origIdx] !== '\t') normIdx++;
    } else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
      // Extra whitespace in original.
      origToNorm.push(normIdx);
      origIdx++;
    } else {
      // Mismatch — shouldn't happen with our normalization.
      origToNorm.push(normIdx);
      origIdx++;
    }
  }

  // Fill remaining.
  while (origIdx < original.length) {
    origToNorm.push(normalized.length);
    origIdx++;
  }

  // Reverse mapping: for each normalized position, find the original range.
  const normToOrigStart = new Map<number, number>();
  const normToOrigEnd = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length; origPos++) {
    const normPos = origToNorm[origPos];
    if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
    normToOrigEnd.set(normPos, origPos);
  }

  const out: Match[] = [];
  for (const [normStart, normEnd] of normalizedMatches) {
    let origStart: number;
    if (normToOrigStart.has(normStart)) {
      origStart = normToOrigStart.get(normStart) as number;
    } else {
      // Find nearest.
      origStart = origToNorm.findIndex((n) => n >= normStart);
      if (origStart === -1) origStart = original.length;
    }

    let origEnd: number;
    if (normToOrigEnd.has(normEnd - 1)) {
      origEnd = (normToOrigEnd.get(normEnd - 1) as number) + 1;
    } else {
      origEnd = origStart + (normEnd - normStart);
    }

    // Expand to include trailing whitespace that was normalized, but ONLY when
    // the normalized match itself ended with whitespace. When the match ends
    // with a non-space character, the first whitespace in the original is a word
    // boundary and must not be consumed.
    if (normEnd < normalized.length && normalized[normEnd - 1] === ' ') {
      while (origEnd < original.length && (original[origEnd] === ' ' || original[origEnd] === '\t')) origEnd++;
    }

    out.push([origStart, Math.min(origEnd, original.length)]);
  }
  return out;
}

// -----------------------------------------------------------------------------
// difflib.SequenceMatcher equivalent (Ratcliff-Obershelp).
//
// Python's difflib is stdlib; JS has no equivalent, so the two pieces hermes
// uses — `.ratio()` and `.get_opcodes()` — are implemented here on one shared
// `findLongestMatch` primitive, following CPython's algorithm.
//
// The `autojunk` heuristic is deliberately omitted: it only activates for
// sequences longer than 200 and would never trigger on the short line/middle
// comparisons here, so including it would add a behavioral difference for no
// gain.
// -----------------------------------------------------------------------------

/** b2j: character → sorted list of its indices in b. */
function buildB2J(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }
  return b2j;
}

/** CPython's find_longest_match over a[alo:ahi] and b[blo:bhi]. */
function findLongestMatch(
  a: string, b2j: Map<string, number[]>, alo: number, ahi: number, blo: number, bhi: number,
): [number, number, number] {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const js = b2j.get(a[i]);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

/** CPython's get_matching_blocks: non-adjacent blocks + a terminating (la, lb, 0). */
function getMatchingBlocks(a: string, b: string): [number, number, number][] {
  const b2j = buildB2J(b);
  const la = a.length;
  const lb = b.length;

  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  const blocks: [number, number, number][] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const [i, j, k] = findLongestMatch(a, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  // Collapse adjacent equal blocks.
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: [number, number, number][] = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2; j1 = j2; k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

/** CPython's get_opcodes. */
function getOpcodes(a: string, b: string): Opcode[] {
  let i = 0;
  let j = 0;
  const answer: Opcode[] = [];
  for (const [ai, bj, size] of getMatchingBlocks(a, b)) {
    let tag = '';
    if (i < ai && j < bj) tag = 'replace';
    else if (i < ai) tag = 'delete';
    else if (j < bj) tag = 'insert';
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(['equal', ai, i, bj, j]);
  }
  return answer;
}

/** CPython's SequenceMatcher.ratio(). */
function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  let matches = 0;
  for (const [, , size] of getMatchingBlocks(a, b)) matches += size;
  return (2 * matches) / total;
}

/**
 * Find lines in `content` most similar to `oldString`, for "did you mean?"
 * feedback. Returns a formatted snippet, or '' if nothing useful is found.
 */
export function findClosestLines(
  oldString: string, content: string, contextLines = 2, maxResults = 3,
): string {
  if (!oldString || !content) return '';

  const oldLines = oldString.split(/\r?\n/);
  const contentLines = content.split(/\r?\n/);
  if (!oldLines.length || !contentLines.length) return '';

  // Use the first line of oldString as the anchor for the search.
  let anchor = oldLines[0].trim();
  if (!anchor) {
    // Try the next non-blank line if the first is blank.
    const candidates = oldLines.map((l) => l.trim()).filter(Boolean);
    if (!candidates.length) return '';
    anchor = candidates[0];
  }

  // Score each line in content by similarity to the anchor.
  const scored: [number, number][] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const stripped = contentLines[i].trim();
    if (!stripped) continue;
    const r = ratio(anchor, stripped);
    if (r > 0.3) scored.push([r, i]);
  }
  if (!scored.length) return '';

  // Take the top matches.
  scored.sort((x, y) => y[0] - x[0]);

  const parts: string[] = [];
  const seenRanges = new Set<string>();
  for (const [, lineIdx] of scored.slice(0, maxResults)) {
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
    const key = `${start},${end}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    const snippet: string[] = [];
    for (let j = 0; j < end - start; j++) {
      snippet.push(`${String(start + j + 1).padStart(4)}| ${contentLines[start + j]}`);
    }
    parts.push(snippet.join('\n'));
  }
  return parts.length ? parts.join('\n---\n') : '';
}

/**
 * Return a "\n\nDid you mean..." snippet for plain no-match errors.
 *
 * Gated so the hint only fires for actual "old_string not found" failures.
 * Ambiguous-match ("Found N matches"), escape-drift, and identical-strings
 * errors all have matchCount === 0 but a "did you mean?" snippet would be
 * misleading — those failed for unrelated reasons.
 */
export function formatNoMatchHint(
  error: string | null, matchCount: number, oldString: string, content: string,
): string {
  if (matchCount !== 0) return '';
  if (!error || !error.startsWith('Could not find')) return '';
  const hint = findClosestLines(oldString, content);
  if (!hint) return '';
  return '\n\nDid you mean one of these sections?\n' + hint;
}
