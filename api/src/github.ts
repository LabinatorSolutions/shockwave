// Read a workspace's cron.json over the GitHub Contents API, ETag-conditional so
// unchanged repos cost nothing against the rate limit (a 304 is free). This is
// how the scheduler discovers + refreshes schedules without cloning.

export interface CronFetch {
  jobs: any[];
  etag: string | null;
  changed: boolean;   // false = 304 Not Modified (keep existing registrations)
}

export async function fetchCronJson(
  owner: string, repo: string, branch: string, pat: string, etag?: string | null,
): Promise<CronFetch> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/cron.json?ref=${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'shockwave-cron',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(url, { headers });
  if (res.status === 304) return { jobs: [], etag: etag ?? null, changed: false };
  if (res.status === 404) return { jobs: [], etag: null, changed: true }; // no cron.json → clear its jobs
  if (!res.ok) throw new Error(`cron.json fetch failed (HTTP ${res.status})`);

  const newEtag = res.headers.get('etag');
  const text = await res.text();
  let jobs: any[];
  try { jobs = JSON.parse(text); } catch { jobs = []; }
  if (!Array.isArray(jobs)) jobs = [];
  return { jobs, etag: newEtag, changed: true };
}
