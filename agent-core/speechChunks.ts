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
 * How fast speech plays, in characters a second. MEASURED against the configured
 * voice rather than derived from words-per-minute: six clips from 27 to 427
 * characters fit a straight line at ~16.8, with no meaningful fixed cost.
 */
export const CHARS_PER_SECOND = 17;

/**
 * What it costs to MAKE a piece, measured the same way: a fixed handshake plus a
 * per-character rate. Six sizes from 21 to 288 characters fit
 * `650ms + 21.8ms × chars`, and a cold connection times the same as a warm one —
 * so there is nothing to pre-open and length is the only lever.
 */
const SYNTH_FIXED_MS = 650;
const SYNTH_PER_CHAR_MS = 21.8;

/** Uploading the finished clip to Telegram. */
const SEND_MS = 200;

/**
 * How much of the buffered audio may be spent making the NEXT piece. The rest is
 * headroom, and it is what stands between this and a silence: the numbers above
 * are measured against one vendor at one moment, and every other vendor, plan and
 * busy hour differs. 40% is deliberately generous — running out mid-answer is far
 * worse than an extra bubble, and a request that happens to run slow is the
 * normal case, not the exotic one.
 *
 * This is the knob for "more cushion", and the only honest one: piece lengths land
 * wherever a sentence ends, so they cannot be dialled by percent — on a real reply,
 * nudging the opener's target up 15% moved the actual clip from 27 characters to
 * 76, because that is where the next break was.
 */
const MARGIN = 0.6;

/**
 * The first piece, in characters. Nothing covers this wait, so it is the one
 * number that sets how long you stare at the dots — about 1.5 seconds here.
 *
 * Deliberately not tuned to the last tenth of a second. It buys the first sound
 * AND it is the buffer everything after it is made inside, so erring long costs a
 * moment at the start and erring short costs a silence in the middle.
 *
 * How small it can be is decided by how the pieces are DELIVERED. One at a time,
 * the second piece cannot start until the first has gone out, so its whole budget
 * is the first piece's playing time — shrink the opener and everything after it
 * shrinks too, and at 27 characters the ladder cannot grow at all (measured: a
 * stutter of minimum-length clips). With TWO in flight — the most both vendors
 * allow — the second is made alongside the first and is ready before it is
 * wanted, so the opener is free to be short again.
 */
const FIRST_PIECE_CHARS = 50;

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
 * How far below its budget a break may fall before reaching forward is better.
 * Applies to every piece INCLUDING the first — see the note in `splitOnce`, where
 * an opener that took the first comma it found starved everything after it.
 */
const MIN_FILL = 0.5;

/**
 * No piece below this, whatever the budget says — about two seconds of speech.
 * Any shorter and the clip is barely longer than the sound announcing it.
 *
 * It is 20 and not 30 because a clip carries roughly 0.9s of fixed overhead
 * (lead-in and tail), so two seconds of BUBBLE is only about a second of talking.
 * Measured at 30 it rejected "Here's your thirty seconds." — a whole sentence,
 * ready in 1.3s — and reached forward to something twice the length instead.
 */
const MIN_PIECE_CHARS = 20;

/**
 * How far past the budget a break may be reached for. Unbounded, this walks to
 * the first sentence end ANYWHERE — and a bulleted list or a git error can run
 * hundreds of characters without one, which is how a "five second" piece came out
 * over a minute long.
 */
const OVERSHOOT = 2;

/** A sentence end: terminal punctuation, any closing quote or bracket, then space. */
const SENTENCE_END = /[.!?…]["'’”)\]]*(?:\s|$)/g;

/**
 * Where an EARLY piece may break: the ends above, plus a comma, semicolon, colon
 * or dash.
 *
 * Once the budget is large this is off, because a whole sentence is worth waiting
 * for and there are plenty of them to choose from. While it is small, there
 * aren't — and the cost of missing is not a clumsy break, it is a silence.
 * Measured: a second piece wanted ~53 characters and the nearest sentence end was
 * at 69, which overran its window by 25ms. Prose offers a comma far more often
 * than a full stop, so this is the granularity that makes a small budget
 * reachable at all.
 */
const CLAUSE_END = /(?:[.!?…,;:]["'’”)\]]*(?:\s|$))|(?:\s[—–-]\s)/g;

/** Budgets at or below this may break at a clause; larger ones want a sentence.
 *  ~9 seconds of speech — by then the ladder has room to reach a full stop. */
const CLAUSE_UNDER = 150;

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
  // Audio sent but not yet listened to, in ms — the buffer every piece after the
  // first is made inside of. See `budgetFor`.
  let slackMs = 0;
  let prevChars = 0;
  while (rest) {
    // The head start: delivery keeps TWO pieces in flight, so this one began
    // being made while the previous one was still being made — not after it was
    // sent. That overlap is real time and it belongs in the window.
    const window = slackMs + makeMs(prevChars);
    const budget = Math.min(i === 0 ? FIRST_PIECE_CHARS : budgetFor(window), cap);
    // Clause breaks are allowed while the budget is SMALL — see CLAUSE_END.
    const [piece, remainder] = splitOnce(rest, budget, cap, budget <= CLAUSE_UNDER);
    // Can't make progress (a budget of zero, or a cap that leaves nothing) — stop
    // rather than loop. The caller still gets everything taken so far.
    if (!piece) break;
    out.push(piece);
    // Nothing is playing while the FIRST piece is made, so it starts the buffer
    // rather than drawing on one.
    slackMs = (i === 0 ? 0 : slackMs - makeMs(piece.length)) + playMs(piece.length);
    prevChars = piece.length;
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

/** How long a piece takes to say, and what it costs to make and deliver. */
const playMs = (chars: number) => (chars / CHARS_PER_SECOND) * 1000;
const makeMs = (chars: number) => SYNTH_FIXED_MS + SYNTH_PER_CHAR_MS * chars + SEND_MS;

/**
 * How large the next piece may be, given how much SENT-BUT-UNPLAYED audio is
 * standing between the listener and silence.
 *
 * The thing to understand is that this buffer accumulates. Delivery is sequential
 * — piece N+1 is only started once piece N has gone out — but the listener is
 * still working through everything sent so far, and speech plays ~2.7x slower
 * than it is generated. So every piece leaves more slack behind it than it spent,
 * and the pieces can get bigger fast:
 *
 *     make(next)  <=  slack * MARGIN
 *     slack'      =   slack - make(next) + play(next)
 *
 * Sized off the PREVIOUS PIECE ALONE instead, the ladder crawls — measured at
 * 65, 87, 131, 241 where the buffer allows 75, 122, 257, 575. Same safety, half
 * the bubbles, because the earlier pieces are still playing.
 *
 * There is no fixed list of budgets for the same reason there is no fixed list
 * anywhere else here: a list is this rule with the derivation thrown away, and it
 * goes quietly wrong the moment any of the measurements change.
 */
function budgetFor(slackMs: number): number {
  const usable = slackMs * MARGIN - SYNTH_FIXED_MS - SEND_MS;
  // Never below the opener. The rule shrinks when handed a short piece, and a
  // shrinking ladder compounds — each small piece licences a smaller one after it
  // until every clip is the minimum.
  return Math.max(FIRST_PIECE_CHARS, Math.floor(usable / SYNTH_PER_CHAR_MS));
}

/**
 * Take one piece off the front of `text`, aiming for `budget` characters and
 * never exceeding `cap`.
 *
 * Preference order: the last break at or before the budget that is worth using →
 * the first break just PAST it → a line break → a word boundary → a hard cut. The
 * hard cut only happens for text with no spaces in it at all, which is not prose.
 *
 * "Worth using" is the floor: a break below `MIN_PIECE_CHARS`, or below half the
 * budget, is skipped in favour of reaching forward — otherwise an opening "Hi."
 * becomes a voice note of its own.
 */
function splitOnce(text: string, budget: number, cap: number, first: boolean): [string, string] {
  if (text.length <= budget) return [text.trim(), ''];

  // Bounded on both sides: never past the vendor's limit, and never more than
  // OVERSHOOT budgets forward, so text with no punctuation for hundreds of
  // characters can't turn a three-second piece into a minute of audio.
  const reach = Math.min(Math.floor(budget * OVERSHOOT), cap, text.length);
  const points = breakPoints(text.slice(0, reach), first);
  // A break far below the budget is skipped in favour of reaching forward. That
  // matters MOST on the first piece, not least: everything after it is sized from
  // how long it plays, so an opener that grabs the first comma it sees starves the
  // whole ladder. Measured, a 27-character opening sentence drove every following
  // piece to the minimum — a stutter of tiny clips instead of a reply.
  const floor = Math.max(MIN_PIECE_CHARS, budget * MIN_FILL);

  let cut = 0;
  for (const p of points) if (p <= budget && p >= floor) cut = p;   // last usable one at/under budget
  if (!cut) cut = points.find((p) => p > budget && p >= floor) ?? 0; // else the first one past it

  const window = text.slice(0, budget);
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

/** Every place a piece may end, in order, within `text`. */
function breakPoints(text: string, allowClause: boolean): number[] {
  const re = new RegExp((allowClause ? CLAUSE_END : SENTENCE_END).source, 'g');
  const out: number[] = [];
  for (const m of text.matchAll(re)) out.push(m.index + m[0].length);
  // A line break ends a piece too — a list or a heading has no terminal
  // punctuation, and without this those break only on a word boundary.
  for (const m of text.matchAll(/\n+/g)) out.push(m.index + m[0].length);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Index just past the first sentence end at or after `from`, or 0 if there is none. */
function nextSentenceEnd(text: string, from: number): number {
  const re = new RegExp(SENTENCE_END.source, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].length : 0;
}
