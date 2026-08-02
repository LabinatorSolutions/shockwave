import { useCallback, useEffect, useMemo, useState } from 'react';
import { setupStatus, anyIncomplete } from '../setupStatus.js';

// Feeds the "needs setup" badge on the gear and on the settings nav rows.
//
// Two of the three inputs aren't in the settings object, so this gathers them:
// the companion URL/key live in a local file (`api:read`, no network), and git
// is a process spawn. Both are cheap and neither is pushed at us, so `refresh`
// is exported and App calls it when the settings modal closes — that's the only
// place any of this can change.
//
// The third input (token, provider, model, provider keys) rides the settings
// object App already holds, so it updates on its own.

export function useSetupStatus({ sync, codingAgent }: { sync?: any; codingAgent?: any }) {
  const [probe, setProbe] = useState<any>({
    companionUrl: '',
    companionHasKey: false,
    // Unknown reads as installed — see the comment in setupStatus.ts. A badge
    // that appears for the first 200ms of every launch is noise, not a signal.
    gitInstalled: true,
  });

  const refresh = useCallback(async () => {
    const [conn, git] = await Promise.all([
      window.api.settings.apiRead().catch(() => null),
      window.api.sync.checkGit().catch(() => null),
    ]);
    setProbe((prev: any) => ({
      companionUrl: conn?.url ?? (conn ? '' : prev.companionUrl),
      companionHasKey: conn ? !!conn.hasApiKey : prev.companionHasKey,
      // A failed probe keeps the previous answer rather than claiming git
      // vanished — the badge should follow git, not follow our ability to ask.
      gitInstalled: git ? !!git.ok : prev.gitInstalled,
    }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const status = useMemo(() => setupStatus({
    ...probe,
    hasPat: !!sync?.hasPat,
    provider: codingAgent?.provider ?? '',
    model: codingAgent?.model ?? '',
    hasProviderKey: codingAgent?.hasProviderKey ?? {},
  }), [probe, sync, codingAgent]);

  return useMemo(() => ({ ...status, any: anyIncomplete(status), refresh }), [status, refresh]);
}

export default useSetupStatus;
