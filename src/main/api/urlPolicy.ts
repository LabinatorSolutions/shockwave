// PURE policy for what a companion URL is allowed to be. No electron, no fs, so
// `node --test` can exercise it directly — same split as `certPolicy.ts` (pure)
// vs `net.ts` (the Electron wiring around it).
//
// Every companion request carries the bearer API key, and `GET /settings` returns
// the whole DECRYPTED secret store. Over `https` the certificate check
// (certPolicy.ts) is what stands between that and a hostile network. Over plain
// `http` there is no certificate to check and nothing to pin: the key, every
// provider key, the GitHub PAT and every agent token cross the wire in the clear,
// and no amount of approving fingerprints later can help. So http is refused —
// except to loopback, where the bytes never leave the machine and there is no
// network for anyone to be hostile on.
//
// This is deliberately NOT "warn the user". A warning on a connection that has
// already sent the key is a notification about a leak, not a defence against one.

// The whole 127.0.0.0/8 block, not just 127.0.0.1 — every address in it is
// loopback (RFC 1122), and `127.0.0.2` is a normal way to run a second local
// service. The URL parser has already normalized the shorthand and obfuscated
// spellings into a dotted quad by the time this sees it (`127.1`, `0x7f000001`
// and `2130706433` all arrive as `127.0.0.1`) and rejects out-of-range octets
// outright, so matching the printed form is matching the address.
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Does this host name an address on this machine?
 *
 * The set is the one the web platform already settled on for exactly this
 * question — W3C secure-contexts' "potentially trustworthy origin", which is why
 * a browser gives `http://localhost` the same treatment as `https://` anywhere
 * else. Everything in it shares one property: the bytes cannot reach a remote
 * listener, so there is no wire for anyone to read the API key off.
 *
 * `hostname` comes from `new URL()`, so it is already lowercased, IPv6 is already
 * compressed and bracketed (`[0:0:0:0:0:0:0:1]` → `[::1]`), and anything
 * unparseable never got this far.
 *
 * What is deliberately NOT here: the private ranges (`10/8`, `172.16/12`,
 * `192.168/16`) and `*.local`. Those are a network — a real hop over real
 * hardware — and a LAN is precisely where somebody else is in a position to
 * listen. A companion on a home server doesn't need the exemption anyway: it
 * gets a self-signed certificate and the app pins it (see certPolicy.ts), which
 * is a working https deployment rather than a downgrade.
 */
function isLoopbackHost(hostname: string): boolean {
  // A single trailing dot is the fully-qualified spelling of the same name.
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  // RFC 6761 reserves `localhost` AND everything under it, which is what makes
  // `api.localhost:8080`-style dev routing safe to include.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;      // IPv6 loopback
  // The "unspecified" address. Not in the W3C list, but as a DESTINATION the
  // stack sends it to the local machine — it is loopback in every way that
  // matters here, and it is what people type after reading "listening on
  // 0.0.0.0:8080" off their own console.
  if (host === '0.0.0.0') return true;
  return LOOPBACK_V4.test(host);
}

/**
 * Why this URL can't be used for the companion — or null if it can.
 *
 * The string is shown to the user verbatim, so it names the fix rather than the
 * rule. An empty string is not a problem here: nothing can be sent to it, and
 * `client.ts` already reports an unconfigured connection in its own words.
 */
export function companionUrlProblem(url: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u: URL;
  try { u = new URL(url.trim()); }
  catch { return "That isn't a valid URL. Use https:// followed by your server's address."; }

  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') {
    if (isLoopbackHost(u.hostname)) return null;
    return 'http:// would send your API key and every stored secret in the clear. '
      + 'Use https:// — plain http only works for a companion on this machine '
      + '(localhost or 127.0.0.1).';
  }
  return 'Use https:// (or http:// for a companion running on this machine).';
}

/**
 * May a request go to this URL at all? The transport asks this on EVERY request,
 * so a URL stored before this rule existed — or written by some future path that
 * skips the check above — still can't carry the key off the machine in the clear.
 *
 * Fails closed: an empty or unparseable URL is not something to send credentials
 * to either.
 */
export function isCompanionUrlAllowed(url: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  return companionUrlProblem(url) === null;
}
