// Split a string into <strong>/plain segments based on fuzzysort's matched
// character indexes (which are sorted ascending). Contiguous runs of matched
// chars collapse into a single <strong>.
//
// Shared by the two fuzzy pickers — quick search (files) and the tab strip's
// open-tab list — so a match reads the same in both.
export function segmentsFromIndexes(text, indexes) {
  if (!indexes || indexes.length === 0) return [{ match: false, value: text }];
  const segs: any[] = [];
  let cursor = 0;
  for (let i = 0; i < indexes.length;) {
    const start = indexes[i];
    if (start > cursor) segs.push({ match: false, value: text.slice(cursor, start) });
    let end = start;
    while (i < indexes.length && indexes[i] === end) { end++; i++; }
    segs.push({ match: true, value: text.slice(start, end) });
    cursor = end;
  }
  if (cursor < text.length) segs.push({ match: false, value: text.slice(cursor) });
  return segs;
}
