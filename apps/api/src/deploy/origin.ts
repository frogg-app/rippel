/**
 * Which address to bake into an install.
 *
 * The agent stores this URL and checks in against it forever, so getting it
 * wrong is not a cosmetic mistake — it is a machine that installs cleanly and
 * then never appears. It used to be one static setting (`AGENT_SERVER_URL`,
 * falling back to `PUBLIC_URL`), and one static setting cannot be right for
 * both a browser on the LAN and a GPU box on the internet: someone reaching
 * rippel at https://dev.rippel.app was handed a command pointing at
 * http://192.168.1.9:5173, which is not an address the rest of the world has.
 *
 * So the default is the origin the request actually arrived on — the same
 * address the operator is looking at, which is by construction one that
 * reaches this rippel from where they are. `AGENT_SERVER_URL` stays as an
 * explicit override for the operator whose agents genuinely must use a
 * different (internal) address, and `PUBLIC_URL` is the last fallback for a
 * request with no usable Host header at all.
 *
 * On trust: `trustProxy` is on, so `X-Forwarded-Host` and `X-Forwarded-Proto`
 * are already folded into `req.host` and `req.protocol`. Nothing here is a
 * security decision — a forged header changes only which URL a human is shown
 * and asked to paste, and what authorises the agent's check-in is the token,
 * not the origin. The host is still pattern-checked before it goes into a URL,
 * because a header is attacker-controlled text and a generated shell script is
 * the wrong place to find out.
 */

import { env } from '../env.js';

/** A hostname or IP, optionally with a port; or a bracketed IPv6 literal. */
const HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** Just enough of a Fastify request to build a URL from. */
export interface OriginRequest {
  protocol?: string;
  host?: string;
  headers?: Record<string, string | string[] | undefined>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  // A proxy chain sends "a, b"; the first entry is the client-facing one.
  return raw?.split(',')[0]?.trim() || undefined;
}

/** `https://dev.rippel.app`, or null when the request carries no usable host. */
export function requestOrigin(req: OriginRequest): string | null {
  const headers = req.headers ?? {};
  const host = req.host || firstValue(headers['x-forwarded-host']) || firstValue(headers.host);
  if (!host || !HOST.test(host)) return null;
  const proto = (req.protocol || firstValue(headers['x-forwarded-proto']) || 'http').toLowerCase();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * The address to write into an agent's config, for this request.
 *
 * Order: the explicit override, then the origin the operator is using, then
 * PUBLIC_URL.
 */
export function agentServerUrl(req: OriginRequest): string {
  const configured = env.deploy.serverUrlOverride.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return (requestOrigin(req) ?? env.publicUrl).replace(/\/+$/, '');
}

/**
 * Is this an address whose plaintext is worth warning about?
 *
 * The install command carries the agent token in its query string. Over a LAN,
 * or to a loopback address, http is how everybody runs this and a warning would
 * be noise. To a public host it means the token crosses the internet in clear
 * text, in a URL, which is worth saying out loud.
 */
export function isPlaintextToPublicHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  // A bare name with no dots is a LAN name, not a public one.
  if (!host.includes('.') && !host.includes(':')) return false;
  return true;
}
