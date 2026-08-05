// THE list of speech vendors, and what each one can actually do.
//
// It lives here because `agent-core` is the only code bundled into BOTH builds,
// and both need it: the desktop mints microphone tokens and draws the settings
// page, the companion transcribes voice notes and speaks replies.
//
// WHY A TABLE. Vendor differences used to be spelled as `provider === 'deepgram'`
// in four places — the key lookup, the engine name, the token mint, and the
// failure message — which is fine for two vendors and wrong for three across two
// directions. The matrix is not square: AssemblyAI cannot speak at all, so a
// single "voice provider" choice would either hide it or quietly synthesize with
// somebody else's account. Listening and speaking are therefore chosen
// separately, and this table is what says which vendor may appear in which list.
//
// KEYS ARE PER VENDOR, NOT PER DIRECTION. Pick Deepgram for both and you enter
// one key, because it is one account. That's why `voiceKeys` is a map keyed by
// slug (the same shape `codingAgent.providerKeys` uses) rather than a field per
// job — five flat fields would also mean storing the same key twice.
//
// Dependency-free so `node --test` loads it directly and both TypeScript builds
// import it without ceremony, same as `credentials.ts` and `linkParser.ts`.

export interface MicSupport {
  /** How long a minted streaming credential is good for. */
  tokenTtlMs: number;
  /**
   * The token dies on first use, so it cannot be cached between clicks.
   *
   * True for ElevenLabs and false for the other two, and it is not a detail:
   * the renderer caches a token and reuses it until it expires, which is correct
   * for a 60-second reusable token and makes the SECOND microphone click fail
   * for a single-use one.
   */
  singleUse: boolean;
}

export interface VoiceProvider {
  slug: string;
  label: string;
  /**
   * Where the user actually gets a key — the vendor's API-KEYS page, not its
   * signup form. All three pointed at signup, which is a dead end for anyone
   * who already has an account: it asks them to create a second one rather
   * than showing them the key they came for. Vendors that sign you in first
   * redirect there themselves, so the keys page covers both cases and the
   * signup form covers only one.
   */
  keysUrl: string;
  /** Host part of `keysUrl`, for the "open in browser" confirmation. */
  keysHost: string;
  /** Turns speech into text — files, and Telegram voice notes. */
  listen: boolean;
  /** Turns text into speech. */
  speak: boolean;
  /** Live microphone streaming, or undefined when the vendor has none. */
  mic?: MicSupport;
}

export const VOICE_PROVIDERS: VoiceProvider[] = [
  {
    slug: 'assemblyai',
    label: 'AssemblyAI',
    keysUrl: 'https://www.assemblyai.com/dashboard/api-keys',
    keysHost: 'assemblyai.com',
    listen: true,
    // AssemblyAI ships no standalone speech synthesis — it exists only inside
    // their voice-agent product, which is a different thing than "read me this
    // sentence". So this vendor never appears in the speaking list.
    speak: false,
    mic: { tokenTtlMs: 60_000, singleUse: false },
  },
  {
    slug: 'deepgram',
    label: 'Deepgram',
    // Deepgram's keys live under a PROJECT (`/project/<id>/settings/api-keys`),
    // so there is no static URL that works for every account. `?jump=keys` is
    // the one stable deep link they publish — it lands a new user on keys after
    // signup, and bounces an existing one into the console.
    keysUrl: 'https://console.deepgram.com/signup?jump=keys',
    keysHost: 'deepgram.com',
    listen: true,
    speak: true,
    mic: { tokenTtlMs: 60_000, singleUse: false },
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keysHost: 'elevenlabs.io',
    listen: true,
    speak: true,
    // 15 minutes, and single-use — see MicSupport.singleUse.
    mic: { tokenTtlMs: 15 * 60_000, singleUse: true },
  },
];

/** No default. Speaking is opt-in: it costs money and nobody asked for it yet. */
export const DEFAULT_SPEAK = '';

export function voiceProvider(slug: string | undefined | null): VoiceProvider | undefined {
  return VOICE_PROVIDERS.find((p) => p.slug === slug);
}

/** The three jobs a vendor can be assigned to. `mic` is separate from `listen`
 *  because a vendor can be permitted one and not the other — see `micProviderOf`. */
export type VoiceJob = 'listen' | 'mic' | 'speak';

export const canDo = (p: VoiceProvider | undefined, job: VoiceJob): boolean => (
  job === 'mic' ? !!p?.mic : !!p?.[job]
);

export const providersFor = (job: VoiceJob): VoiceProvider[] => VOICE_PROVIDERS.filter((p) => canDo(p, job));

export const listenProviders = (): VoiceProvider[] => providersFor('listen');
export const speakProviders = (): VoiceProvider[] => providersFor('speak');
export const micProviders = (): VoiceProvider[] => providersFor('mic');

/** A vendor's display name, or the raw slug when it isn't one we know. */
export function voiceLabel(slug: string | undefined | null): string {
  return voiceProvider(slug)?.label ?? String(slug ?? 'that provider');
}

/**
 * The settings this module reads. Callers pass these three together rather than
 * a key, because which key applies is a function of which vendor is selected —
 * and that is exactly the reasoning that was duplicated four times.
 */
export interface VoiceConfig {
  /** Listening. `provider` covers Telegram voice notes and the `transcribe` tool. */
  transcription?: {
    provider?: string;
    /**
     * The MICROPHONE's own vendor, when it differs from the one above.
     *
     * A separate assignment because a vendor can be permitted to transcribe and
     * not to stream: Deepgram gates the streaming grant behind Member, and its
     * key-creation DEFAULT is `usage:write`, which transcribes perfectly and
     * cannot mint. That is the ordinary Deepgram key, not an exotic one — so
     * without this the common setup is a dead microphone with nowhere to go.
     *
     * Unset ⇒ whatever transcribes, when that vendor has a microphone at all.
     */
    micProvider?: string;
    echoTelegramTranscript?: boolean;
  };
  /** Speaking. Unset `provider` means speech is not configured. */
  speech?: {
    provider?: string;
    /** Deepgram: the Aura model (`aura-2-thalia-en`). ElevenLabs: the voice id. */
    voiceId?: string;
    /** ElevenLabs only — its model is chosen separately from its voice. */
    modelId?: string;
  };
  /** Vendor slug -> API key. Absent in the renderer, which gets flags instead. */
  voiceKeys?: Record<string, string>;
}

/**
 * The three voice slices of a full settings object, as one value.
 *
 * Every caller that has settings in hand and wants to listen or speak goes
 * through this, so nobody has to remember that the key lives in a sibling of the
 * provider that selects it. Safe on a partial or missing object — an unconfigured
 * setup reads as "no vendor, no key", which is exactly what the callers check.
 */
export function voiceConfigOf(settings: any): VoiceConfig {
  return {
    transcription: settings?.transcription ?? {},
    speech: settings?.speech ?? {},
    // The renderer never receives key VALUES — main strips them and substitutes
    // `hasVoiceKey`, a map of slug -> true. Resolution only ever asks whether a
    // key is there, so the flags are folded in here and the settings page
    // resolves through the same functions the consumers use. The alternative is
    // the page reimplementing "which vendor does this job", which is exactly the
    // drift that ends with Settings showing one answer and the agent using another.
    voiceKeys: settings?.voiceKeys ?? presenceKeys(settings?.hasVoiceKey),
  };
}

/** Presence flags -> a key map whose values exist and are never used for anything
 *  but that test. Nothing can be sent anywhere with these; `keyForProvider` only
 *  asks for a non-empty string. */
function presenceKeys(flags: unknown): Record<string, string> {
  if (!flags || typeof flags !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [slug, present] of Object.entries(flags as Record<string, unknown>)) {
    if (present) out[slug] = 'stored';
  }
  return out;
}

/**
 * The vendor to use for `job` when nothing has been assigned to it: the one that
 * can do the job AND has a key, but only when exactly one qualifies.
 *
 * This is resolution from stored data, NOT a default — which is the difference
 * that matters. `DEFAULT_LISTEN = 'assemblyai'` used to sit here, and it named a
 * vendor whether or not a key for it existed: an install with one ElevenLabs key
 * and no chosen provider was told "No AssemblyAI key — add one", pointing at a
 * vendor nobody had picked while a perfectly good key sat unused. A vendor
 * cannot be resolved here unless its key is present, so that answer is
 * unreachable. Ambiguity (two keys, no choice) stays unset and says so.
 */
function soleKeyedProvider(config: VoiceConfig | undefined | null, job: VoiceJob): string {
  const able = providersFor(job).filter((p) => keyForProvider(config, p.slug));
  return able.length === 1 ? able[0].slug : '';
}

/** Whichever vendor transcribes: Telegram voice notes and the `transcribe` tool. */
export function listenProviderOf(config: VoiceConfig | undefined | null): string {
  const chosen = config?.transcription?.provider;
  if (chosen && canDo(voiceProvider(chosen), 'listen')) return chosen;
  return soleKeyedProvider(config, 'listen');
}

/**
 * Whichever vendor runs the live microphone.
 *
 * Falls back to the transcribing vendor, since one account doing both jobs is
 * the ordinary case and asking twice would be noise. It only falls back when
 * that vendor HAS a microphone — `mic` is optional on the table, so a
 * transcribe-only vendor added later can't silently become the mic.
 */
export function micProviderOf(config: VoiceConfig | undefined | null): string {
  const chosen = config?.transcription?.micProvider;
  if (chosen && canDo(voiceProvider(chosen), 'mic')) return chosen;
  const listen = listenProviderOf(config);
  if (listen && canDo(voiceProvider(listen), 'mic')) return listen;
  return soleKeyedProvider(config, 'mic');
}

/**
 * Whichever vendor speaks.
 *
 * **No sole-key resolution here, deliberately.** Speaking costs money per reply,
 * so it stays opt-in: pasting a key to transcribe with must never start
 * synthesizing audio nobody asked for. Unset means silent.
 */
export function speakProviderOf(config: VoiceConfig | undefined | null): string {
  const chosen = config?.speech?.provider;
  if (chosen && canDo(voiceProvider(chosen), 'speak')) return chosen;
  return DEFAULT_SPEAK;
}

/** The vendor assigned to one job, whichever way it was resolved. */
export function providerForJob(config: VoiceConfig | undefined | null, job: VoiceJob): string {
  return job === 'mic' ? micProviderOf(config)
    : job === 'speak' ? speakProviderOf(config)
      : listenProviderOf(config);
}

/** The stored key for one vendor, whichever job it was picked for. */
export function keyForProvider(
  config: VoiceConfig | undefined | null,
  slug: string | undefined | null,
): string | undefined {
  if (!slug) return undefined;
  const value = config?.voiceKeys?.[slug];
  return typeof value === 'string' && value ? value : undefined;
}

/** The key for whichever vendor is selected for listening. */
export const listenKey = (config: VoiceConfig | undefined | null): string | undefined =>
  keyForProvider(config, listenProviderOf(config));

/** The key for whichever vendor is selected for speaking. */
export const speakKey = (config: VoiceConfig | undefined | null): string | undefined =>
  keyForProvider(config, speakProviderOf(config));

/** The key for whichever vendor runs the microphone. */
export const micKey = (config: VoiceConfig | undefined | null): string | undefined =>
  keyForProvider(config, micProviderOf(config));

/**
 * Is speaking usable right now — a vendor chosen, and a key stored for it?
 *
 * Both hosts ask this before doing any work toward a spoken reply, so an
 * unconfigured setup costs nothing and falls back to text in silence.
 */
export function canSpeak(config: VoiceConfig | undefined | null): boolean {
  const slug = speakProviderOf(config);
  return !!(slug && voiceProvider(slug)?.speak && keyForProvider(config, slug));
}
