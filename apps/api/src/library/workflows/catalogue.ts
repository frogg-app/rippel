/** The official library is versioned data. Cache independently per backend and
 * installed package version; never substitute a newer upstream workflow. */
import { z } from 'zod';

const ioNode = z.object({ nodeId: z.union([z.string(), z.number()]), nodeType: z.string(), file: z.string().optional(), mediaType: z.string().optional() });
const entrySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/), title: z.string(), description: z.string().default(''),
  tags: z.array(z.string()).default([]), models: z.array(z.string()).default([]),
  date: z.string(), openSource: z.boolean().optional(), size: z.number().nonnegative().optional(),
  thumbnail: z.array(z.string()).default([]), minComfyUIVersion: z.string().optional(),
  io: z.object({ inputs: z.array(ioNode).default([]), outputs: z.array(ioNode).default([]) }).optional(),
});
const indexSchema = z.array(z.object({ title: z.string(), type: z.string().optional(), templates: z.array(entrySchema) }));
export type LibraryEntry = Omit<z.infer<typeof entrySchema>, 'openSource'> & { category: string; openSource: boolean };
// This older official entry omits openSource, but its native graph is captured
// and verified in our converter fixtures. Do not treat every missing flag as local.
const VERIFIED_LOCAL_LEGACY = new Set(['video_wan2_2_5B_ti2v']);
export interface LibraryCatalogue { version: string; entries: LibraryEntry[] }

export function parseCatalogue(value: unknown, version: string): LibraryCatalogue {
  if (!/^\d+\.\d+\.\d+(?:[A-Za-z0-9.+-]*)$/.test(version)) throw new Error('Backend did not report a valid installed workflow-library version.');
  return { version, entries: indexSchema.parse(value).flatMap((group) => group.templates.map((entry) => ({ ...entry, openSource: entry.openSource ?? VERIFIED_LOCAL_LEGACY.has(entry.name), category: group.title }))) };
}
export function filterCatalogue(catalogue: LibraryCatalogue, filter: { category?: string; tag?: string; includeCloud?: boolean } = {}) {
  return catalogue.entries.filter((entry) =>
    (filter.includeCloud || entry.openSource) && (!filter.category || entry.category === filter.category) &&
    (!filter.tag || entry.tags.includes(filter.tag)));
}

export class WorkflowLibraryClient {
  private cache = new Map<string, { catalogue: LibraryCatalogue; workflows: Map<string, unknown> }>();
  constructor(private fetchImpl: typeof fetch = fetch) {}
  private async json(baseUrl: string, path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Workflow library ${path} returned HTTP ${response.status}.`);
    return response.json();
  }
  async catalogue(backendId: string, baseUrl: string): Promise<LibraryCatalogue> {
    const stats = await this.json(baseUrl, '/system_stats') as { system?: { installed_templates_version?: string } };
    const version = stats.system?.installed_templates_version;
    if (!version) throw new Error('Backend does not report its installed workflow-library version. Upgrade ComfyUI before importing.');
    const key = `${backendId}|${baseUrl}|${version}`;
    const cached = this.cache.get(key);
    if (cached) return cached.catalogue;
    const catalogue = parseCatalogue(await this.json(baseUrl, '/templates/index.json'), version);
    // Bound memory to the latest version of each of the most recently used backends.
    for (const old of this.cache.keys()) if (old.startsWith(`${backendId}|`)) this.cache.delete(old);
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { catalogue, workflows: new Map() });
    return catalogue;
  }
  async workflow(backendId: string, baseUrl: string, name: string, expectedVersion: string): Promise<unknown> {
    const catalogue = await this.catalogue(backendId, baseUrl);
    if (catalogue.version !== expectedVersion) throw new Error('The workflow library changed. Refresh the catalogue and explicitly import again.');
    if (!catalogue.entries.some((entry) => entry.name === name)) throw new Error('No such workflow in this library.');
    const cached = this.cache.get(`${backendId}|${baseUrl}|${catalogue.version}`)!;
    if (!cached.workflows.has(name)) cached.workflows.set(name, await this.json(baseUrl, `/templates/${encodeURIComponent(name)}.json`));
    return structuredClone(cached.workflows.get(name));
  }
}
export const workflowLibrary = new WorkflowLibraryClient();
