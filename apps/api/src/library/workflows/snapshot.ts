/** Refreshable node specifications, retaining input order and widget metadata.
 * Discard display labels, categories and documentation; conversion needs the
 * complete input specification, including dynamic input options. */
import type { ConversionSpecs, NodeSpec } from './convert.js';

export function trimObjectInfo(raw: unknown): ConversionSpecs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a node specification object.');
  const trimmed: ConversionSpecs = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'input')) continue;
    const node = value as NodeSpec;
    trimmed[name] = {
      input: structuredClone(node.input),
      ...(node.input_order ? { input_order: structuredClone(node.input_order) } : {}),
      ...(node.output ? { output: [...node.output] } : {}),
      ...(node.output_node !== undefined ? { output_node: node.output_node } : {}),
    };
  }
  if (Object.keys(trimmed).length === 0) throw new Error('Backend returned no node specifications.');
  return trimmed;
}

export async function fetchSnapshot(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Backend URL must use HTTP or HTTPS.');
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Node snapshot returned HTTP ${response.status}.`);
  return trimObjectInfo(await response.json());
}
