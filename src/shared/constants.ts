// Shared across main + renderer. Single source of truth.
// Keep `productName` in package.json in sync (electron-builder uses it for .app/.dmg names at build time).
export const APP_NAME = 'Shockwave';

export const FILE_ACTIONS = Object.freeze({
  NEW_TAB: 'newTab',
  DUPLICATE: 'duplicate',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
  TOGGLE_BOOKMARK: 'toggleBookmark',
  // Conflict view, per file: accept as-edited / keep ours / take remote.
  RESOLVE: 'resolve',
  KEEP: 'keep',
  RESET: 'reset',
} as const);
export type FileAction = (typeof FILE_ACTIONS)[keyof typeof FILE_ACTIONS];

export const FOLDER_ACTIONS = Object.freeze({
  NEW_FILE: 'newFile',
  NEW_FOLDER: 'newFolder',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
} as const);
export type FolderAction = (typeof FOLDER_ACTIONS)[keyof typeof FOLDER_ACTIONS];

export const EDITOR_ACTIONS = Object.freeze({
  ADD_LINK: 'addLink',
  ADD_EXTERNAL_LINK: 'addExternalLink',
  EDIT_EXTERNAL_LINK: 'editExternalLink',
  REMOVE_EXTERNAL_LINK: 'removeExternalLink',
  SEND_TO_AGENT: 'sendToAgent',
  REVEAL_IMAGE: 'revealImage',
} as const);
export type EditorAction = (typeof EDITOR_ACTIONS)[keyof typeof EDITOR_ACTIONS];

// Pi-ai providers that authenticate via a single bearer API key. Cloud/OAuth
// providers (bedrock, vertex, azure, cloudflare, github-copilot, openai-codex)
// are filtered out — our settings schema only carries a single API key.
export const SUPPORTED_PROVIDER_SLUGS = Object.freeze([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'cerebras',
  'deepseek',
  'xai',
  'mistral',
  'fireworks',
  'together',
  'huggingface',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'opencode',
  'opencode-go',
  'vercel-ai-gateway',
  'zai',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  // Generic OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, remote gateways).
  // Not in pi-ai's registry — main injects it into agent:listProviders.
  'openai-compatible',
] as const);

export const DEFAULT_PROVIDER_SLUG = 'anthropic';

// ── Is the desktop/companion pair unusable? ─────────────────────────────────
// ONE declaration, for the same reason `agent-core/credentials.ts` is one: the
// answer is read on both sides of the IPC boundary — main latches it to arm the
// write kill switch (`setStaleCompanion` in `api/client.ts`), the renderer reads
// it for the toast, the sidebar icon, the settings gate and the chat composer —
// and every reader must agree. It briefly existed as three inline comparisons,
// which is three chances to spell one of the two statuses wrong and get a UI
// that says everything is fine while every write is being refused.
//
// **Only a REAL mismatch counts.** 'dev' means either side is unversioned — a
// local companion reports `APP_VERSION='dev'` — so treating it as stale would
// block every write in every development session, on a machine that runs both a
// packaged and a dev install. 'match' and a null status (unreachable, or the
// first probe hasn't answered yet) are likewise fine: not knowing is not a
// reason to refuse, and an unreachable server fails at the transport anyway.
export function isCompanionStale(status) {
  return status === 'companion-older' || status === 'companion-newer';
}
