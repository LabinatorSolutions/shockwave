import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge drops the earlier of two classes it believes set the same
// property, and it decides which property from a table of Tailwind's OWN scale.
// `--text-micro` and `--text-md` are ours (see "Type scale" in the renderer
// CLAUDE.md), so it doesn't recognise them as font sizes — and an unrecognised
// `text-<name>` is assumed to be a text COLOR. Any `cn('text-micro … text-foo')`
// therefore looked like two colors to it and the size was deleted on the way to
// the DOM, silently: the class simply wasn't there, so the element inherited
// 16px from body and nothing anywhere reported a problem.
//
// That is not hypothetical. Every settings-nav group header, and the sidebar's
// own section labels, shipped at 16px instead of 10px from the day the type
// scale landed, wrapping "WORKSPACE · <name>" onto two lines in a 216px rail.
// It read as a design choice rather than a bug, and it survived a build
// comparison — the stylesheet has the rule, the JS has the class, and they
// still never meet.
//
// So the two names are declared here, once. Add a `--text-*` token to app.css
// and add it here in the same move, or the next one fails exactly this quietly.
// Merging is otherwise untouched: two sizes still collapse to the last, two
// colors still collapse to the last.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['micro', 'md'] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
