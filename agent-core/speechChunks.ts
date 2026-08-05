// Splitting a script into the pieces it gets spoken in.
//
// One long voice note makes you wait for the whole thing before you hear any of
// it — every byte is synthesised before a single one is sent, and that grows with
// the length of the answer. Split it and the first sound arrives in a second or
// two; by the time you have listened to that, the next piece is already made.
//
// The budgets ESCALATE — about 5 seconds, then 10, then 30 for the rest — for two
// reasons. The first piece is small because that wait is the only one nobody can
// cover; the later ones are large because you now have audio playing, and ten
// bubbles you have to tap through is worse than one you waited slightly longer
// for.
//
// Pure: no vendor, no network, no clock. What it cannot know is how long a piece
// will actually take to say, so seconds here are an ESTIMATE from the text — see
// CHARS_PER_SECOND.

/**
 * Speech runs at roughly 150 words a minute, and an English word averages a
 * little over five characters with its space — so about 15 characters a second.
 *
 * Being wrong by a bit costs nothing: it moves where a break falls, not whether
 * the text survives.
 */
export const CHARS_PER_SECOND = 15;

/** Seconds of speech per piece. The last value repeats for the rest of the text. */
const BUDGETS = [5, 10, 30];

/**
 * Below this, a script is spoken as ONE piece. A twelve-second answer split into
 * five and seven is two bubbles where one would do — the wait it saves is shorter
 * than the wait it costs to tap twice.
 */
const MIN_SPLIT_SECONDS = 20;

/**
 * A trailing piece shorter than this is folded into the one before it. A
 * two-second voice note on the end of an answer reads as something having gone
 * wrong.
 */
const MIN_TAIL_SECONDS = 5;

/**
 * How early a sentence break may fall before it is worth overshooting instead. A
 * budget of five seconds and a first sentence of "Hi." would otherwise ship a
 * one-word voice note; going PAST the budget to the next sentence end keeps whole
 * sentences, which is the thing worth protecting — a clip that stops mid-word is
 * worse than one that runs a little long.
 */
const MIN_FILL = 0.5;

/** A sentence end: terminal punctuation, any closing quote or bracket, then space. */
const SENTENCE_END = /[.!?…]["'’”)\]]*(?:\s|$)/g;

/**
 * Split `text` into the pieces it should be spoken in, in order.
 *
 * `maxChars` is the vendor's per-request input limit (`speakLimitFor`). It is a
 * HARD cap, not a preference: over it the request is rejected outright, and
 * cutting the script to fit is what used to lose the tail of a long answer
 * silently. Pass null when there is no limit to respect.
 *
 * Returns `[]` for a script with nothing in it.
 */
export function splitForSpeech(text: string, maxChars?: number | null): string[] {
  const script = text.trim();
  if (!script) return [];

  const cap = maxChars && maxChars > 0 ? maxChars : Infinity;
  // Short enough to say in one go, and short enough for the vendor to accept.
  if (script.length <= MIN_SPLIT_SECONDS * CHARS_PER_SECOND && script.length <= cap) return [script];

  const out: string[] = [];
  let rest = script;
  let i = 0;
  while (rest) {
    const seconds = BUDGETS[Math.min(i, BUDGETS.length - 1)];
    const budget = Math.min(seconds * CHARS_PER_SECOND, cap);
    const [piece, remainder] = splitOnce(rest, budget, cap);
    // Can't make progress (a budget of zero, or a cap that leaves nothing) — stop
    // rather than loop. The caller still gets everything taken so far.
    if (!piece) break;
    out.push(piece);
    rest = remainder;
    i++;
  }

  // Fold a runt tail back into the piece before it, unless that would push it
  // over the vendor's limit — in which case a short last piece is the lesser evil.
  if (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length < MIN_TAIL_SECONDS * CHARS_PER_SECOND && prev.length + 1 + last.length <= cap) {
      out.splice(out.length - 2, 2, `${prev} ${last}`);
    }
  }

  return out;
}

/**
 * Take one piece off the front of `text`, aiming for `budget` characters and
 * never exceeding `cap`.
 *
 * Preference order: a sentence end at or before the budget → a sentence end just
 * PAST it (when the one before falls too early to be worth using) → a line break
 * → a word boundary → a hard cut. The hard cut only happens for text with no
 * spaces in it at all, which is not prose.
 */
function splitOnce(text: string, budget: number, cap: number): [string, string] {
  if (text.length <= budget) return [text.trim(), ''];

  const window = text.slice(0, budget);
  const ends = [...window.matchAll(SENTENCE_END)];
  const before = ends.length ? ends[ends.length - 1].index + ends[ends.length - 1][0].length : 0;

  let cut = before;
  if (cut < budget * MIN_FILL) {
    // Everything up to the budget is one long sentence (or starts with a very
    // short one). Reach forward to the next sentence end instead of breaking a
    // sentence in half — but never past what the vendor will accept.
    const ahead = nextSentenceEnd(text, Math.max(before, 1));
    if (ahead > 0 && ahead <= cap) cut = ahead;
  }
  if (cut <= 0) {
    const nl = window.lastIndexOf('\n');
    if (nl > 0) cut = nl + 1;
  }
  if (cut <= 0) {
    const sp = window.lastIndexOf(' ');
    cut = sp > 0 ? sp + 1 : budget;
  }

  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

/** Index just past the first sentence end at or after `from`, or 0 if there is none. */
function nextSentenceEnd(text: string, from: number): number {
  const re = new RegExp(SENTENCE_END.source, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].length : 0;
}
