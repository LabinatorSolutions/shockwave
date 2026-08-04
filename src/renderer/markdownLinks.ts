// Renders [text](url) as a clickable link showing just `text`.
// Click opens the URL externally. When the cursor (or any selection range)
// touches the link, the raw `[text](url)` syntax is revealed so the user can
// edit it — same convention as hideMarkdownMarkers.

// The label stays REAL DOCUMENT TEXT: we hide `[` and `](url)` and mark the
// span between them — the same shape the image-link branch below already uses.
// Replacing the whole link with a widget is the obvious alternative and quietly
// drops every other decoration covering that text: a widget renders as a direct
// child of the line, outside the mark spans syntax highlighting emits, so
// `### [Title](url)` came out at body size and `[**bold**](url)` showed its
// asterisks. Headings, bold, italic and inline code can all reach a mark; none
// of them can reach a widget.

import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

function extractParts(state, linkNode) {
  // Walk children of a Link node: LinkMark "[", inline content, LinkMark "]",
  // LinkMark "(", URL, LinkMark ")". Returns either:
  //   { kind: 'text', text, textFrom, textTo, url }
  //                                       — normal link; caller hides the
  //                                         brackets + url, marks the label
  //   { kind: 'image', imageFrom, imageTo, url }
  //                                       — link wrapping an image; caller
  //                                         hides the wrapper, leaves image
  let openBracketEnd = -1;
  let closeBracketStart = -1;
  let urlText = '';
  let imageRange: any = null;
  if (!linkNode.firstChild) return null;
  let cursor = linkNode.cursor();
  if (!cursor.firstChild()) return null;
  do {
    if (cursor.name === 'Image' && !imageRange) {
      imageRange = { from: cursor.from, to: cursor.to };
    } else if (cursor.name === 'LinkMark') {
      const tok = state.doc.sliceString(cursor.from, cursor.to);
      if (tok === '[' && openBracketEnd === -1) openBracketEnd = cursor.to;
      else if (tok === ']' && closeBracketStart === -1) closeBracketStart = cursor.from;
    } else if (cursor.name === 'URL') {
      urlText = state.doc.sliceString(cursor.from, cursor.to);
    }
  } while (cursor.nextSibling());
  if (openBracketEnd === -1 || closeBracketStart === -1 || !urlText) return null;
  if (imageRange) {
    return { kind: 'image', imageFrom: imageRange.from, imageTo: imageRange.to, url: urlText };
  }
  const text = state.doc.sliceString(openBracketEnd, closeBracketStart);
  if (!text) return null;
  return {
    kind: 'text',
    text,
    textFrom: openBracketEnd,
    textTo: closeBracketStart,
    url: urlText,
  };
}

const hide = Decoration.replace({});

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const state = view.state;
  const ranges = state.selection.ranges;
  const touchesSelection = (from, to) => {
    for (const r of ranges) {
      if (r.from <= to && r.to >= from) return true;
    }
    return false;
  };

  // Collect first, then sort + emit — image-link wrappers emit two ranges
  // (prefix + suffix) and RangeSetBuilder requires strictly ordered input.
  const decos: any[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Link') return;
        if (touchesSelection(node.from, node.to)) return false;
        const parts = extractParts(state, node.node);
        if (!parts) return false;
        if (parts.kind === 'image') {
          // Hide [ before the image and ](url) after — image widget renders
          // in the gap.
          decos.push({
            from: node.from,
            to: parts.imageFrom,
            deco: hide,
          });
          decos.push({
            from: parts.imageTo,
            to: node.to,
            deco: hide,
          });
        } else {
          // Hide `[`, mark the label, hide `](url)`. The url rides on the mark
          // as an attribute so the click handler reads what is actually on
          // screen rather than re-deriving it from a position.
          decos.push({ from: node.from, to: parts.textFrom, deco: hide });
          decos.push({
            from: parts.textFrom,
            to: parts.textTo,
            deco: Decoration.mark({
              class: 'cm-md-link',
              attributes: { 'data-url': parts.url, title: parts.url },
            }),
          });
          decos.push({ from: parts.textTo, to: node.to, deco: hide });
        }
        return false;
      },
    });
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const d of decos) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

// Returns the enclosing [text](url) / [![alt](src)](url) link at `pos`, or null.
// Shape: { from, to, kind: 'text'|'image', text?, imageFrom?, imageTo?, url }.
// Used by the editor context menu to enable Edit / Remove link.
export function findLinkAtPos(state, pos) {
  const tree = syntaxTree(state);
  let node: any = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Link') node = node.parent;
  if (!node) return null;
  const parts = extractParts(state, node);
  if (!parts) return null;
  return { from: node.from, to: node.to, ...parts };
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// The label is ordinary text now, so opening the url is the editor's job rather
// than an <a>'s. Same two-step the widget used: swallow mousedown so CodeMirror
// doesn't place the cursor (which would reveal the raw syntax under the pointer
// mid-click), open on click. Both no-op unless the pointer is actually over a
// link label, so text selection, image links and wiki-links are untouched.
function linkElementAt(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return target.closest('.cm-md-link');
}

const linkClicks = EditorView.domEventHandlers({
  mousedown(event) {
    if (!linkElementAt(event)) return false;
    event.preventDefault();
    return true;
  },
  click(event) {
    const el = linkElementAt(event);
    const url = el?.getAttribute('data-url');
    if (!url) return false;
    event.preventDefault();
    window.api.openExternal(url);
    return true;
  },
});

export const markdownLinks = [linkPlugin, linkClicks];
