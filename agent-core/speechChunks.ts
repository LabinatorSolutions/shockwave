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
 * The first piece is never shorter than this, whatever break is available.
 *
 * Separate from `MIN_FILL` because it is answering a different question. That one
 * asks "is this break worth using for a piece of this size?"; this one says the
 * OPENER in particular may not be small, because it is the only piece whose length
 * sizes every piece after it — the ladder is built from how long it plays.
 *
 * Without it the floor for the opener is `MIN_PIECE_CHARS` against a budget of 50,
 * i.e. 25 characters — five above the shortest clip permitted anywhere. That is
 * small enough to starve the ladder: everything after the opener is sized from how
 * long it PLAYS, so a two-second opener gives the second piece a small budget, which
 * buffers barely more.
 *
 * **This is the knob for "fewer, longer voice notes", and the only honest one.**
 * The ladder above sizes every later piece from how long this one PLAYS, so raising
 * it lifts the whole curve; nothing downstream can be dialled directly, because
 * piece lengths land wherever a sentence ends.
 *
 * **It was 60 for a day, and 60 was wrong.** Raising it bought pieces on long
 * replies — a 1,093-character answer went from six voice notes to four — but it
 * buys them with the ONE WAIT NOTHING COVERS, and it does that by REJECTING a
 * perfectly good opening sentence. "yt-dlp is still the answer, and it's not close."
 * is 47 characters; at 60 it fails the floor, so the opener swallows the sentence
 * after it and runs to 169 characters — **eighteen seconds of audio before the reply
 * starts**, measured, against under three at 30. An extra bubble you can already
 * hear is not worth eighteen seconds of nothing.
 *
 * That is the trade this number makes, in the direction it actually gets felt: it
 * is not "fewer notes vs. slightly slower", it is "fewer notes vs. a wait long
 * enough to read as nothing having happened". Bubbles are cheap and the opening
 * silence is not, so this stays low. Dead air was zero at 30 and at 60 alike — the
 * whole trade is against the opening wait and never against a gap mid-answer.
 */
const FIRST_PIECE_MIN = 30;

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
 * How far past the budget a sentence end is worth AIMING for. It bounds which
 * sentence the piece tries to end on; it never severs one.
 */
const OVERSHOOT = 2;

/**
 * The longest run of text treated as one unbreakable sentence — about 24 seconds
 * of speech.
 *
 * Sentences are atomic, but "text with no terminal punctuation" is not the same
 * thing as "a sentence", and the difference has to be drawn somewhere or there is
 * no bound at all. A bulleted list, a stack trace or a git error can run hundreds
 * of characters without a full stop, which is how a "five second" piece once came
 * out over a minute long.
 *
 * 400 is chosen to sit clear above real prose rather than close to it: the longest
 * genuine sentence in the measured replies is 243 characters, and English rarely
 * goes past ~300. So this bounds the pathological case without ever being the
 * thing that decides where an ordinary reply breaks — which is the whole point,
 * since anything past it is broken at a clause and that is what we are avoiding.
 */
const LONGEST_SENTENCE = 400;

/** A sentence end: terminal punctuation, any closing quote or bracket, then space. */
const SENTENCE_END = /[.!?…]["'’”)\]]*(?:\s|$)/g;

/**
 * A comma, semicolon, colon or dash — the least bad place to break a sentence
 * that has to be broken.
 *
 * **This is not a way to make a piece fit its budget.** It is reached in exactly
 * one situation: a single sentence longer than the vendor accepts in one request,
 * where the choice is a clumsy break or no audio at all. Every other piece ends
 * where a sentence ends. It used to be a general alternative — any small budget
 * could break at a comma — and the result was a quarter of all clips stopping
 * mid-thought.
 */
const CLAUSE_END = /(?:[.!?…,;:]["'’”)\]]*(?:\s|$))|(?:\s[—–-]\s)/g;

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
    const [piece, remainder] = splitOnce(rest, budget, cap, i === 0);
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
 * **A SENTENCE IS ATOMIC.** Every piece ends where a sentence ends, and the ONLY
 * thing that overrides that is a single sentence longer than the vendor will
 * accept in one request — a hard API limit, where the alternative is not a
 * clumsier break but no audio at all.
 *
 * The budget therefore sizes a piece by choosing how many sentences it holds, not
 * by choosing where to cut. That is the whole reason it is a target and not a
 * rule: a piece routinely runs past it, because the sentence it is in the middle
 * of has not finished.
 *
 * Two things this cost, both of them deliberate, both measured before being
 * accepted. The first sound is slower on a reply whose opening sentences are long
 * — there is no 50-character clip to be had in "Not quite." followed by 243
 * characters without a full stop, so that reply waits for the whole thing. And a
 * piece can be much larger than its budget for the same reason. Breaking mid
 * sentence buys back both, and it is not worth it: a clip that stops at "I'll
 * start by pulling the" is not a faster answer, it is a broken one.
 *
 * "Worth using" is the floor: a sentence end below `MIN_PIECE_CHARS`, or below
 * half the budget, is passed over so the piece takes the NEXT sentence too —
 * otherwise an opening "Hi." becomes a voice note of its own. The opener may not
 * fall below `FIRST_PIECE_MIN`; see the note there for why it is its own number.
 */
function splitOnce(text: string, budget: number, cap: number, isFirst: boolean): [string, string] {
  if (text.length <= budget) return [text.trim(), ''];

  // How far forward a sentence end is worth waiting for while still aiming at the
  // budget. Past this the piece simply takes whatever sentence it is inside of —
  // `reach` bounds the AIM, never the sentence.
  const reach = Math.min(Math.floor(budget * OVERSHOOT), cap, text.length);
  // A sentence end far below the budget is passed over in favour of taking another
  // sentence. That matters MOST on the first piece, not least: everything after it
  // is sized from how long it plays, so an opener of a few characters starves the
  // whole ladder. Measured, a 24-character opening sentence cost an extra bubble on
  // a third of replies.
  const floor = Math.max(isFirst ? FIRST_PIECE_MIN : 0, MIN_PIECE_CHARS, budget * MIN_FILL);

  // A line break ends a piece too — a list item or a heading carries no terminal
  // punctuation, and it is a boundary the writer put there on purpose.
  const stops = (limit: number) => {
    const head = text.slice(0, limit);
    return [...new Set([...marks(head, SENTENCE_END), ...marks(head, /\n+/g)])].sort((a, b) => a - b);
  };

  const near = stops(reach);
  let cut = 0;
  for (const p of near) if (p <= budget && p >= floor) cut = p;    // last usable one at/under budget
  if (!cut) cut = near.find((p) => p > budget && p >= floor) ?? 0; // else the first one past it
  // Nothing within reach — so this sentence runs long. Take the whole of it rather
  // than sever it. This is the line that makes a sentence atomic: the old code fell
  // to a word boundary here and cut mid-phrase.
  const limit = Math.min(cap, LONGEST_SENTENCE);
  if (!cut) cut = stops(limit).find((p) => p >= Math.min(floor, limit)) ?? 0;

  // Only reachable for a run with no sentence end inside `limit` — one sentence
  // over the vendor's cap (where the request would be rejected outright and the
  // audio lost) or a stretch of non-prose. Broken at a clause if there is one,
  // else a word boundary, else the limit.
  if (!cut) {
    const head = text.slice(0, limit);
    // The floor applies here too. Taking the LAST clause end unconditionally is how
    // "Done." became a five-character voice note in front of a 500-character one:
    // the only clause end in range was the full stop at 6, and using it starved the
    // ladder as surely as any other runt would.
    const usable = marks(head, CLAUSE_END).filter((p) => p >= Math.min(floor, limit));
    cut = usable.length ? usable[usable.length - 1] : 0;
    if (!cut) { const sp = head.lastIndexOf(' '); cut = sp > 0 ? sp + 1 : Math.min(limit, text.length); }
  }

  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

/** Every index just past a match of `re` in `text`, in order. */
function marks(text: string, re: RegExp): number[] {
  const r = new RegExp(re.source, 'g');
  const out: number[] = [];
  for (const m of text.matchAll(r)) out.push(m.index + m[0].length);
  return out;
}
