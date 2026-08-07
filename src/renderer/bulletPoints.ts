import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Match a list-item marker at line start. Skip task items — taskCheckboxes.js
// swallows the whole `bullet [ ]` range, so decorating the bullet here would
// collide with that decoration.
//
// The trailing `\s+` is REQUIRED — a bare `-` at end of line is not a bullet.
//
// It used to be `(\s+|$)`, which drew a bullet for a lone marker too, on the
// reasoning that CommonMark counts `-` alone as a valid empty list item and that
// the trailing space on a blank bullet is easily stripped. The cost was a lie
// told on every list you start: type `-` and a bullet appears, type the first
// letter and the line is `-h`, which is not a list — so the bullet vanishes.
// The editor promised a list and then took it back, one keystroke later.
//
// No other markdown editor draws a bullet for a lone `-` (Obsidian, Notion,
// Bear, Typora all wait for the space), and none of them auto-inserts the space
// either. Requiring it puts us with them, and means a bullet on screen is always
// a real list item.
//
// The stripped-whitespace case it was protecting against costs an EMPTY bullet
// rendering as `-` until you type in it — cosmetic, transient, and nothing in
// this app strips trailing whitespace (only an external editor would). Pressing
// Enter is unaffected: `listContinue` inserts the marker WITH its space, so the
// new line matches immediately.
const LIST_RE = /^(\s*)([-*+])(\s+)(?!\[[ xX]\])/;

class BulletWidget extends WidgetType {
  eq() { return true; }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '•';
    return span;
  }

  ignoreEvent() { return true; }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const match = line.text.match(LIST_RE);
      if (match) {
        const markerStart = line.from + match[1].length;
        builder.add(
          markerStart,
          markerStart + 1,
          Decoration.replace({ widget: new BulletWidget() }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const bulletPoints = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
