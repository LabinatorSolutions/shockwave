import { Decoration, ViewPlugin, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, Facet } from '@codemirror/state';
import { spaceWidth, tabStopPx, leadingWidthPx, nextPx, textWidthPx } from './indentMetrics.js';

// Hanging indent for wrapped lines.
//
// CodeMirror renders each line as ONE block with `white-space: pre-wrap`, and a
// line's indentation is CONTENT (leading tab characters), not layout — so a
// wrapped continuation returns to the text column and the indent is lost. The
// fix: give the line a padding-left equal to its own indent, and cancel it on
// the first line with a matching negative text-indent. The first line renders
// exactly where it always did; every wrapped line hangs at the indent.
//
// For LIST lines the hang additionally includes the marker (`- ` / `1. `), so a
// wrapped bullet continues under its own text — the convention in every
// markdown editor. That wider hang collides with CSS tab rendering: tab stops
// are measured from the content edge, which the padding moves, so any raw tab
// on the line snaps to a shifted grid unless the hang is a whole number of tab
// stops (whitespace-only hang always is; marker widths never are). Two guards
// make the wider hang safe:
//   • The line's LEADING tabs are each replaced with a fixed-width spacer
//     widget (`cm-tab-spacer`, width = that tab's own advance), so no raw tab
//     renders before the text. Visual layout, cursor positions, and editing are
//     unchanged — only the tab's width stops being grid-derived.
//   • A tab anywhere AFTER the leading whitespace (rare) disables the marker
//     extension for that line; it falls back to the whitespace-only hang.
// Task lines (`- [ ] …`) also fall back: their marker renders as a native
// checkbox whose width would need a layout read CodeMirror forbids here.
//
// `--hang` is consumed by the `.cm-line` rule in Editor.tsx's theme.

const LEADING_WS_RE = /^[ \t]*/;
// List marker with at least one following space and some content.
const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])( +)(?=\S)/;
const TASK_AFTER_RE = /^\[[ xX]\]/;

// bulletPoints.ts (live preview only) replaces a [-*+] marker char with a 1ch
// inline-block glyph + 6px margin-right (.cm-bullet in app.css — keep in sync).
// The livePreview bundle provides this facet so the hang matches what's
// actually rendered; raw mode measures the marker text itself.
export const listMarkerGlyphs = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});
const BULLET_GLYPH_GAP_PX = 6;

// One Decoration per distinct hang width — lines at the same depth share it.
const decoCache = new Map<string, Decoration>();
function hangDeco(px: number) {
  const key = px.toFixed(2);
  let d = decoCache.get(key);
  if (!d) {
    d = Decoration.line({ attributes: { style: `--hang: ${key}px` } });
    decoCache.set(key, d);
  }
  return d;
}

// Fixed-width stand-in for one leading tab character.
class TabSpacerWidget extends WidgetType {
  px: number;
  constructor(px: number) {
    super();
    this.px = px;
  }
  eq(other: TabSpacerWidget) {
    return other.px === this.px;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-tab-spacer';
    span.style.display = 'inline-block';
    span.style.width = `${this.px.toFixed(2)}px`;
    // Inline-blocks re-apply the line's inherited negative text-indent.
    span.style.textIndent = '0';
    return span;
  }
}

const spacerCache = new Map<string, Decoration>();
function spacerDeco(px: number) {
  const key = px.toFixed(2);
  let d = spacerCache.get(key);
  if (!d) {
    d = Decoration.replace({ widget: new TabSpacerWidget(px) });
    spacerCache.set(key, d);
  }
  return d;
}

// Rendered width of a list marker + its trailing spaces.
function markerPx(marker: string, spaces: number, sp: number, glyphs: boolean) {
  const glyph =
    glyphs && marker.length === 1 && '-*+'.includes(marker)
      ? textWidthPx('0') + BULLET_GLYPH_GAP_PX // .cm-bullet: 1ch wide + 6px gap
      : textWidthPx(marker);
  return glyph + spaces * sp;
}

function buildDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const sp = spaceWidth(view);
  if (!sp) return builder.finish();
  const tabPx = tabStopPx(view, sp);
  const glyphs = view.state.facet(listMarkerGlyphs);
  const doc = view.state.doc;
  let lastLine = 0; // a line can straddle two visible ranges — add it once

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number !== lastLine) {
        lastLine = line.number;
        const ws = LEADING_WS_RE.exec(line.text)![0];
        // Skip blank/whitespace-only lines — nothing there to wrap.
        if (ws.length < line.text.length) {
          let px = leadingWidthPx(ws, sp, tabPx);
          const m = LIST_RE.exec(line.text);
          const extend =
            m &&
            !TASK_AFTER_RE.test(line.text.slice(m[0].length)) &&
            line.text.indexOf('\t', ws.length) === -1;
          if (extend) px += markerPx(m![2], m![3].length, sp, glyphs);
          if (px > 0) builder.add(line.from, line.from, hangDeco(px));
          if (extend && ws.includes('\t')) {
            // Replace each leading tab with its own fixed-width spacer so the
            // non-tab-multiple hang can't shift the tab grid (see header).
            let x = 0;
            for (let i = 0; i < ws.length; i++) {
              const nx = nextPx(x, ws[i], sp, tabPx);
              if (ws[i] === '\t') {
                builder.add(line.from + i, line.from + i + 1, spacerDeco(nx - x));
              }
              x = nx;
            }
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.startState.facet(listMarkerGlyphs) !== update.state.facet(listMarkerGlyphs)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
