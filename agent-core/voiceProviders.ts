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
  signupUrl: string;
  /** Host part of `signupUrl`, for the "open in browser" confirmation. */
  signupHost: string;
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
    signupUrl: 'https://www.assemblyai.com/dashboard/signup',
    signupHost: 'assemblyai.com',
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
    signupUrl: 'https://console.deepgram.com/signup',
    signupHost: 'deepgram.com',
    listen: true,
    speak: true,
    mic: { tokenTtlMs: 60_000, singleUse: false },
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    signupUrl: 'https://elevenlabs.io/app/sign-up',
    signupHost: 'elevenlabs.io',
    listen: true,
    speak: true,
    // 15 minutes, and single-use — see MicSupport.singleUse.
    mic: { tokenTtlMs: 15 * 60_000, singleUse: true },
  },
];

/** The vendor used when nothing is stored. Listening only — see DEFAULT_SPEAK. */
export const DEFAULT_LISTEN = 'assemblyai';
/** No default. Speaking is opt-in: it costs money and nobody asked for it yet. */
export const DEFAULT_SPEAK = '';

export function voiceProvider(slug: string | undefined | null): VoiceProvider | undefined {
  return VOICE_PROVIDERS.find((p) => p.slug === slug);
}

export const listenProviders = (): VoiceProvider[] => VOICE_PROVIDERS.filter((p) => p.listen);
export const speakProviders = (): VoiceProvider[] => VOICE_PROVIDERS.filter((p) => p.speak);

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
  /** Listening. `provider` applies to the mic, voice notes, and the transcribe tool. */
  transcription?: {
    provider?: string;
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
    voiceKeys: settings?.voiceKeys ?? {},
  };
}

export function listenProviderOf(config: VoiceConfig | undefined | null): string {
  return config?.transcription?.provider || DEFAULT_LISTEN;
}

export function speakProviderOf(config: VoiceConfig | undefined | null): string {
  return config?.speech?.provider || DEFAULT_SPEAK;
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
