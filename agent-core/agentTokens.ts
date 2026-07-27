// The agent-tokens tools (`list_agent_secrets` / `get_agent_secret`), built as a
// factory so the secret getters are CLOSED OVER, not module-global. That's what
// lets the same tool code run in two hosts (desktop + companion) without one
// clobbering the other's getters. Passed to pi via `customTools`.
//
// getSecrets — full decrypted secrets array (metadata only; values never surfaced).
// getToken(name) — a USABLE credential: the static token, or a freshly-minted
//   OAuth access token. Throws (user-facing) when the name is unknown or an OAuth
//   connection needs reconnecting. Both hosts route getToken to the companion —
//   the desktop over HTTP, the server in-process — so refresh lives in one place.

export function makeAgentTokenTools(
  getSecrets: () => Promise<any[]>,
  getToken: (name: string) => Promise<string>,
): any[] {
  async function readMeta() {
    try {
      const secrets = (await getSecrets()) || [];
      return secrets.map((s) => ({
        name: s.name,
        description: s.description || '',
        kind: s.oauth ? 'oauth' : 'static',
        provider: s.oauth ? s.oauth.provider : undefined,
        scopes: s.oauth ? (s.oauth.scopes || []) : undefined,
        status: s.oauth ? s.oauth.status : undefined,
      }));
    } catch {
      return [];
    }
  }

  const listAgentSecrets: any = {
    name: 'list_agent_secrets',
    label: 'List Agent Secrets',
    description: "Lists credentials available to you. For each: its name, a short description, its kind ('static' API token or 'oauth' connection), and for OAuth connections the provider, granted scopes, and connection status. Never returns the value — call get_agent_secret for a usable credential. Use this to check whether a credential you need is already on file before asking the user for one.",
    promptSnippet: 'List available credentials by name, kind, and purpose.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const items = await readMeta();
      if (items.length === 0) {
        return { content: [{ type: 'text', text: 'No credentials are currently stored.' }], details: { count: 0, names: [] } };
      }
      const text = items.map((s) => {
        let line = '- ' + s.name + ' [' + s.kind + ']';
        if (s.description) line += ': ' + s.description;
        if (s.kind === 'oauth') {
          line += ' (provider: ' + s.provider + ', status: ' + s.status;
          if (s.scopes && s.scopes.length) line += ', scopes: ' + s.scopes.join(' ');
          line += ')';
        }
        return line;
      }).join('\n');
      return { content: [{ type: 'text', text }], details: { count: items.length, names: items.map((s) => s.name) } };
    },
  };

  const getAgentSecret: any = {
    name: 'get_agent_secret',
    label: 'Get Agent Secret',
    description: 'Returns a usable credential for one secret by name. For a static secret this is the stored API token; for an OAuth connection this is a fresh access token (refreshed automatically if expired). Use the exact name from list_agent_secrets. Errors if no secret by that name exists, or if an OAuth connection needs to be reconnected by the user.',
    promptSnippet: 'Get a usable credential (API token or fresh OAuth access token) by name.',
    promptGuidelines: [
      'Do not echo a credential returned by get_agent_secret in your reply, into a file, or into a shell command that prints it. Prefer passing it via env vars to the subprocess that needs it.',
      'If get_agent_secret reports an OAuth connection is expired or disconnected, tell the user to reconnect it in Settings — you cannot re-authorize it yourself.',
    ],
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact name of the secret (from list_agent_secrets).' } },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        const value = await getToken(params.name);
        return { content: [{ type: 'text', text: value }], details: { name: params.name } };
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: e?.message || ('No secret named "' + params.name + '". Call list_agent_secrets to see available names.') }],
          isError: true,
        };
      }
    },
  };

  return [listAgentSecrets, getAgentSecret];
}
