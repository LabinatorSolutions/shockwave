import { KeyBinding } from '@codemirror/view';

// Continue a bullet/ordered list item TIGHTLY on Enter — never the blank line
// CM's insertNewlineContinueMarkup inserts for "loose" lists (items separated by
// a blank line). Without this, once any blank line makes a list loose, every
// Enter perpetuates more blanks: `- a` + Enter → `- a\n\n- ` → `- a\n\n\n- ` …
// which is exactly what users see in note files that already have spacing.
//
// Scope (deliberately narrow — everything else falls through to the next Enter
// handler, returning false):
//   - Only NON-EMPTY items (group 6 requires a non-space char). Empty items
//     return false so markdownEnterKeymap collapses/outdents them (CM handles
//     nesting + the "remove marker" vs "outdent one level" decision well).
//   - Tasks are excluded via the `(?!\[[ xX]\])` lookahead — taskEnterKeymap
//     (bound earlier) already continues those tightly.
//   - Cursor must be at the end of the line, or inside the marker's own
//     trailing whitespace (see below). Mid-CONTENT Enter falls through.
//
// The second cursor position is there because CM gets it wrong. Its
// insertNewlineContinueMarkup eats whitespace to the LEFT of the split point
// before inserting, which is right for `- foo |bar` (the line left behind is
// `- foo`, not `- foo `) — but at the start of the content there is nothing
// between the cursor and the marker except the marker's own separating space,
// so it eats that and leaves a bare `-`. That is not a list item to
// bulletPoints.ts (which requires the space), so pressing Enter at the front of
// `- foo` produced an item that rendered as a literal dash until you went back
// and typed the space in by hand. We split at the content start instead and
// leave the whitespace alone, which is what taskEnterKeymap already does for
// `- [ ] |foo`.
//
// Ordered lists: the new marker is current-number + 1. Items BELOW the cursor
// are not renumbered (CM does that); the dominant case is appending at the end
// of a list, where there's nothing below to renumber.
//
// Bound AFTER taskEnterKeymap and BEFORE markdownEnterKeymap.
const LIST_CONTINUE_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(?!\[[ xX]\])(\S.*)$/;

export const listContinueKeymap: KeyBinding[] = [{
  key: 'Enter',
  run: (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    const m = line.text.match(LIST_CONTINUE_RE);
    if (!m) return false;
    const [, indent, marker, num, delim, space] = m;

    // Where the split goes. At end of line: at the cursor, appending an empty
    // item. Inside the marker's whitespace: at the content start, so the item
    // left behind keeps its space. `markerEnd` is CM's own lower bound — with
    // the cursor still inside the marker text it bails to a plain newline, and
    // splitting `12. foo` between the `2` and the `.` is not "new list item".
    const col = sel.head - line.from;
    const markerEnd = indent.length + marker.length;
    const contentStart = markerEnd + space.length;
    const at = col === line.text.length ? col
      : col >= markerEnd && col <= contentStart ? contentStart
      : -1;
    if (at < 0) return false;

    const nextMarker = num !== undefined ? `${parseInt(num, 10) + 1}${delim}` : marker;
    const insert = `\n${indent}${nextMarker}${space}`;
    view.dispatch(state.update({
      changes: { from: line.from + at, insert },
      selection: { anchor: line.from + at + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  },
}];
