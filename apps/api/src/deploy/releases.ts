/**
 * Where to download the agent, for a machine that is not going to fetch it
 * from this rippel.
 *
 * GitHub's `/releases/latest/download/<asset>` redirects to whatever the newest
 * release calls that asset, so a correct link can always be built without
 * asking GitHub anything. The API call on top of that is only to put a version
 * and a date next to the link — useful, never load-bearing. A rate-limited or
 * offline lookup therefore degrades to the same links with a note, rather than
 * to an error: a self-hosted install on a network with no route to github.com
 * is a supported way to run this, and the download page should still be honest
 * about where the files would come from.
 */

import type { AgentPlatform, AgentRelease } from '@comfy/shared';
import { env } from '../env.js';

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string;
  html_url?: string;
  assets?: GithubAsset[];
}

/** Asset name per platform, and how to say it in the UI. */
const ASSETS: { platform: AgentPlatform; label: string; asset: string }[] = [
  { platform: 'win32', label: 'Windows', asset: 'rippel-agent-windows.zip' },
  { platform: 'darwin', label: 'macOS', asset: 'rippel-agent-macos.tar.gz' },
  { platform: 'linux', label: 'Linux', asset: 'rippel-agent-linux.tar.gz' },
];

const CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; value: AgentRelease } | null = null;

function fallback(repo: string, note: string | null): AgentRelease {
  const base = `https://github.com/${repo}/releases`;
  return {
    tag: null,
    name: null,
    publishedAt: null,
    url: `${base}/latest`,
    downloads: ASSETS.map(({ platform, label, asset }) => ({
      platform,
      label,
      // This URL is correct whether or not the lookup worked.
      url: `${base}/latest/download/${asset}`,
      sizeBytes: null,
    })),
    note,
  };
}

export async function latestAgentRelease(
  fetchImpl: typeof fetch = globalThis.fetch,
  repo = env.deploy.releaseRepo,
): Promise<AgentRelease> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let value: AgentRelease;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'rippel' },
      signal: controller.signal,
    });
    if (!res.ok) {
      value = fallback(
        repo,
        res.status === 404
          ? `No release has been published on ${repo} yet. These links will work once one is.`
          : `GitHub answered ${res.status}, so the version below is not shown. The links still point at the latest release.`,
      );
    } else {
      const release = (await res.json()) as GithubRelease;
      const assets = release.assets ?? [];
      value = {
        tag: release.tag_name ?? null,
        name: release.name ?? null,
        publishedAt: release.published_at ?? null,
        url: release.html_url ?? `https://github.com/${repo}/releases/latest`,
        downloads: ASSETS.map(({ platform, label, asset }) => {
          const match = assets.find((a) => a.name === asset);
          return {
            platform,
            label,
            url: match?.browser_download_url ?? `https://github.com/${repo}/releases/latest/download/${asset}`,
            sizeBytes: match?.size ?? null,
          };
        }),
        note: assets.length
          ? null
          : `Release ${release.tag_name ?? ''} carries no agent assets yet, so these links may 404.`.trim(),
      };
    }
  } catch (cause) {
    value = fallback(
      repo,
      controller.signal.aborted
        ? 'GitHub did not answer in time, so the version below is not shown. The links still point at the latest release.'
        : `Could not reach GitHub (${cause instanceof Error ? cause.message : String(cause)}). The links still point at the latest release.`,
    );
  } finally {
    clearTimeout(timer);
  }

  cached = { at: Date.now(), value };
  return value;
}

/** Test seam: forget what GitHub said. */
export function clearReleaseCache(): void {
  cached = null;
}
