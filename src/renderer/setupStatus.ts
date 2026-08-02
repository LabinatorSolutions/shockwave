// Which required settings still have nothing in them.
//
// Pure and dependency-free so `node --test` loads it directly and the
// renderer's TS imports it without ceremony — same as `linkResolver.ts`.
//
// ONE definition, three readers: the gear badge, the settings nav badge, and the
// page itself. They cannot disagree about whether something needs attention,
// which is the whole reason this isn't computed at each of those three places.
//
// The rule is deliberately only "is it filled in".
//
// Whether a saved key still WORKS is a different question: answering it needs
// the network, the answer goes stale, and keeping one dot honest would mean
// polling GitHub, the model provider and the companion on a timer. So a key that
// gets refused surfaces as a toast where it is refused, and sync — the one
// failure that persists for days rather than seconds — holds its state in the
// status-bar icon instead.
//
// Reachability is likewise NOT a badge. The companion goes away with the wifi
// and comes back; a dot that blinks on and off teaches people to ignore dots.
// That case is the amber cloud in the sidebar footer.

/** The one provider that authenticates by URL rather than an API key. */
export const COMPATIBLE_PROVIDER = 'openai-compatible';

/**
 * @param {object} input
 * @param {string}  input.companionUrl      – stored server URL ('' if none)
 * @param {boolean} input.companionHasKey   – a key is stored (never its value)
 * @param {boolean} input.gitInstalled      – `git --version` answered
 * @param {boolean} input.hasPat            – a GitHub token is stored
 * @param {string}  input.provider          – chosen agent provider
 * @param {string}  input.model             – chosen agent model
 * @param {object}  input.hasProviderKey    – { [slug]: true } for stored keys
 * @returns {{companion: boolean, github: boolean, agent: boolean}} true = needs attention
 */
export function setupStatus(input) {
  const {
    companionUrl = '',
    companionHasKey = false,
    // Defaults to INSTALLED. This is answered by spawning a process, so there is
    // a moment at startup where we don't know yet — and "don't know" must not
    // paint a badge, or every launch opens with a red dot that clears itself.
    gitInstalled = true,
    hasPat = false,
    provider = '',
    model = '',
    hasProviderKey = {},
  } = input || {};

  return {
    companion: !String(companionUrl).trim() || !companionHasKey,
    // git isn't a field on that page, but it's the other thing without which
    // nothing on it works — same page, same dot.
    github: !gitInstalled || !hasPat,
    // Mirrors the runtime check in `agent-core/agent.ts` (provider, model, and a
    // key for everything except openai-compatible). Kept identical on purpose:
    // two definitions of "configured" is how a page shows green while the turn
    // it describes refuses to start.
    agent: !provider || !model
      || (provider !== COMPATIBLE_PROVIDER && !hasProviderKey?.[provider]),
  };
}

/** Does anything need attention? Drives the badge on the gear icon. */
export function anyIncomplete(status) {
  return !!status && (status.companion || status.github || status.agent);
}
