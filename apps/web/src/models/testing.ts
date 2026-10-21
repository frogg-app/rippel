/**
 * Fixtures and a scriptable `ModelsApi` for the Models tests.
 *
 * Shaped from real responses off the live box on 2026-09-06 — including the
 * things that are easy to invent wrongly: the catalogue's own family spelling
 * ("SDXL", not "sdxl"), a `size` that is a human string, a `ref` of
 * `save_path/filename`, and an installed filename carrying a Windows subfolder.
 *
 * No install is ever performed for real. A checkpoint is ~7 GB and the only
 * working image model on the test box is one a running job would be competing
 * with, so the install flow is exercised entirely against this stub.
 */
import type {
  Backend,
  Model,
  ModelCatalogEntry,
  ModelInstall,
  ModelInstallStatus,
  ModelRemoval,
  ModelRunnability,
  ModelWorkflowOption,
  LibraryWorkflowReport,
  ModelWorkflows,
  WorkflowTemplateSummary,
} from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import type { InstalledModels, ModelsApi } from '../lib/api-models';

export const BACKEND_ID = '5018d9f4-c67f-4452-b6b8-892fdd928c43';
export const OTHER_BACKEND_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'e766567c-482c-4a79-b892-9f2c7acc2d29';

export function makeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    id: BACKEND_ID,
    name: 'desktop-6900xt',
    baseUrl: 'http://192.168.1.10:8188',
    enabled: true,
    status: 'online',
    deviceName: 'cuda:0 AMD Radeon RX 6900 XT : native',
    vramFree: 9_886_926_848,
    vramTotal: 17_163_091_968,
    ramFree: 35_752_206_336,
    ramTotal: 63_763_238_912,
    vramLimitMb: null,
    lastSeenAt: '2026-09-06T10:00:31.750Z',
    queueDepth: 0,
    ...overrides,
  };
}

export function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: '1daee9a8-9422-47ef-9958-e63576fb6a68',
    type: 'checkpoint',
    // A real filename from the box: a Windows subfolder, on purpose.
    filename: 'SDXL\\sd_xl_base_1.0.safetensors',
    displayName: 'Sd Xl Base 1.0',
    baseModel: 'sdxl',
    previewUrl: null,
    sizeBytes: null,
    source: 'local',
    sourceRef: null,
    backendIds: [BACKEND_ID],
    ...overrides,
  };
}

/** A verdict in the shape the API produces, with its own words. */
export function makeRunnability(overrides: Partial<ModelRunnability> = {}): ModelRunnability {
  return {
    status: 'support',
    family: null,
    capabilities: [],
    summary: 'Support file',
    detail: 'An upscaling model, used by an upscale workflow rather than a generation one.',
    missing: [],
    backendId: BACKEND_ID,
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    ref: 'default/RealESRGAN_x2.pth',
    name: 'RealESRGAN x2',
    filename: 'RealESRGAN_x2.pth',
    type: 'upscaler',
    base: 'upscale',
    description: 'RealESRGAN x2 upscaler model',
    size: '67.1MB',
    url: 'https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x2.pth',
    reference: 'https://huggingface.co/ai-forever/Real-ESRGAN',
    savePath: 'default',
    installed: false,
    info: null,
    runnability: makeRunnability(),
    ...overrides,
  };
}

export function makeInstall(overrides: Partial<ModelInstall> = {}): ModelInstall {
  return {
    id: 'e6b56eac-a95b-4b5c-bc96-aed1a07020d4',
    backendId: BACKEND_ID,
    requestedBy: USER_ID,
    filename: 'sd_xl_base_1.0.safetensors',
    displayName: 'SDXL Base 1.0',
    type: 'checkpoint',
    base: 'SDXL',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    status: 'queued',
    detail: null,
    error: null,
    createdAt: '2026-09-06T08:28:03.859Z',
    startedAt: null,
    finishedAt: null,
    // Null by default: a fixture must default to the *unmeasured* case, which
    // is the one where no percentage may be shown. A default of 0 would let a
    // test pass while rendering a 0% bar for a download nobody measured.
    bytesReceived: null,
    bytesTotal: null,
    ...overrides,
  };
}

/** A catalogue the size of the real one, for the filter and paging tests. */
export function makeCatalogue(): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [
    makeEntry(),
    makeEntry({
      ref: 'checkpoints/sd_xl_base_1.0.safetensors',
      name: 'SDXL Base 1.0',
      filename: 'sd_xl_base_1.0.safetensors',
      type: 'checkpoint',
      base: 'SDXL',
      size: '6.94GB',
      description: 'Stable Diffusion XL base checkpoint',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      reference: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
      savePath: 'checkpoints/SDXL',
      installed: true,
      info: {
        previewUrl: '/api/model-previews/2f2a1b0c9d8e7f6a5b4c',
        previewFullUrl: '/api/model-previews/2f2a1b0c9d8e7f6a5b4c?full=1',
        previewFrom: 'huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/01.png',
        previewBorrowedFrom: null,
        license: 'openrail++',
        downloads: 1_767_210,
        likes: 8113,
        pipelineTag: 'text-to-image',
        referenceUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
      },
      runnability: makeRunnability({
        status: 'ready',
        family: 'sdxl',
        capabilities: ['txt2img', 'img2img'],
        summary: 'Will run',
        detail: 'An SDXL model, with a workflow written for it.',
      }),
    }),
    makeEntry({
      ref: 'loras/flux-cinematic.safetensors',
      name: 'Cinematic Film Look',
      filename: 'flux-cinematic.safetensors',
      type: 'lora',
      base: 'FLUX.1',
      size: '148MB',
      description: 'Analog film grain and halation',
      url: 'https://example.invalid/flux-cinematic.safetensors',
      savePath: 'loras',
    }),
    makeEntry({
      ref: 'vae/ae.safetensors',
      name: 'FLUX VAE',
      filename: 'ae.safetensors',
      type: 'vae',
      base: 'FLUX.1',
      size: '335MB',
      description: null,
      url: 'https://example.invalid/ae.safetensors',
      savePath: 'vae/FLUX1',
    }),
  ];
  // Filler, so the grid is tested at something like its real size.
  for (let index = 0; index < 96; index += 1) {
    entries.push(
      makeEntry({
        ref: `loras/filler-${index}.safetensors`,
        name: `Filler LoRA ${index}`,
        filename: `filler-${index}.safetensors`,
        type: 'lora',
        base: index % 2 === 0 ? 'SD1.5' : 'SDXL',
        size: '96MB',
        description: null,
        url: `https://example.invalid/filler-${index}.safetensors`,
        savePath: 'loras',
      }),
    );
  }
  return entries;
}

export interface StubOptions {
  backends?: Backend[];
  installed?: InstalledModels;
  entries?: ModelCatalogEntry[];
  /** Model pages the API says it is still resolving; drives the fill-in poll. */
  cataloguePending?: number;
  /** Thrown by `catalogue`; how the 501 and 403 states are exercised. */
  catalogueError?: ApiRequestError;
  activeInstalls?: ModelInstall[];
  history?: ModelInstall[];
  /**
   * Statuses `installStatus` walks through, one per poll, the last repeating.
   * This is how "queued -> downloading -> complete" is driven deterministically
   * instead of by waiting on a real 7 GB download.
   */
  statusScript?: Partial<ModelInstall>[];
  /** Thrown by `install`, for the 409 path. */
  installError?: ApiRequestError;
  /** What `templates` returns. */
  templates?: WorkflowTemplateSummary[];
  /** What `modelWorkflows` returns, keyed by model id; a missing id throws 404. */
  workflows?: Record<string, ModelWorkflows>;
  /** Thrown by `assignWorkflow`. */
  assignError?: ApiRequestError;
  /** What `removeModel` returns. */
  removal?: ModelRemoval;
  /** Thrown by `removeModel`. */
  removeError?: ApiRequestError;
  /** What `libraryReport` returns; absent throws 404. */
  libraryReport?: LibraryWorkflowReport;
}

export interface StubApi extends ModelsApi {
  /** Every call, in order, so a test can assert what was polled. */
  calls: string[];
}

export function makeStubApi(options: StubOptions = {}): StubApi {
  const calls: string[] = [];
  const entries = options.entries ?? makeCatalogue();
  const active = options.activeInstalls ?? [];
  const script = options.statusScript ?? [];
  let step = 0;
  let started: ModelInstall | null = null;

  return {
    calls,
    backends: async () => {
      calls.push('backends');
      return options.backends ?? [makeBackend()];
    },
    installed: async () => {
      calls.push('installed');
      return (
        options.installed ?? { models: [makeModel()], families: ['sdxl'], runnability: {} }
      );
    },
    catalogue: async () => {
      calls.push('catalogue');
      if (options.catalogueError) throw options.catalogueError;
      return { entries, pending: options.cataloguePending ?? 0 };
    },
    install: async (backendId, ref) => {
      calls.push(`install:${ref}`);
      if (options.installError) throw options.installError;
      const entry = entries.find((candidate) => candidate.ref === ref);
      started = makeInstall({
        id: `install-${ref}`,
        backendId,
        filename: entry?.filename ?? 'unknown.safetensors',
        displayName: entry?.name ?? 'Unknown',
        type: entry?.type ?? 'checkpoint',
        base: entry?.base ?? 'SDXL',
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
      return started;
    },
    installHistory: async () => {
      calls.push('history');
      return options.history ?? [];
    },
    installStatus: async (_backendId, installId) => {
      calls.push(`status:${installId}`);
      const base =
        started?.id === installId
          ? started
          : (active.find((candidate) => candidate.id === installId) ?? makeInstall({ id: installId }));
      const patch = script[Math.min(step, script.length - 1)] ?? {};
      step += 1;
      const next = { ...base, ...patch } as ModelInstall;
      if (started?.id === installId) started = next;
      return next;
    },
    activeInstalls: async () => {
      calls.push('active');
      return active;
    },
    templates: async () => {
      calls.push('templates');
      return options.templates ?? [makeTemplate()];
    },
    modelWorkflows: async (modelId, backendId) => {
      calls.push(`workflows:${modelId}:${backendId ?? '-'}`);
      const found = options.workflows?.[modelId];
      if (!found) throw new ApiRequestError(404, 'not_found', 'No such model.');
      return found;
    },
    assignWorkflow: async (modelId, capability, templateId) => {
      calls.push(`assign:${modelId}:${capability}:${templateId ?? 'auto'}`);
      if (options.assignError) throw options.assignError;
      const found = options.workflows?.[modelId];
      if (found) {
        if (templateId) found.assigned = { ...found.assigned, [capability]: templateId };
        else {
          const next = { ...found.assigned };
          delete next[capability];
          found.assigned = next;
        }
        found.options = found.options.map((o) => ({
          ...o,
          assigned: found.assigned[o.template.capability] === o.template.id,
        }));
        return found.assigned;
      }
      return templateId ? { [capability]: templateId } : {};
    },
    switchCapability: async (modelId, capability, enabled) => {
      calls.push(`switch:${modelId}:${capability}:${enabled ? 'on' : 'off'}`);
      const found = options.workflows?.[modelId];
      const current = found?.switchedOff ?? [];
      const next = enabled ? current.filter((c) => c !== capability) : [...new Set([...current, capability])];
      if (found) found.switchedOff = next;
      return next;
    },
    libraryReport: async (backendId, name) => {
      calls.push(`library:${backendId}:${name}`);
      if (!options.libraryReport) throw new ApiRequestError(404, 'not_found', 'No such workflow.');
      return options.libraryReport;
    },
    removeModel: async (modelId) => {
      calls.push(`remove:${modelId}`);
      if (options.removeError) throw options.removeError;
      return (
        options.removal ?? {
          removed: true,
          removedFromDisk: false,
          note: 'The record is gone, but the file is still on desktop-6900xt.',
        }
      );
    },
  };
}

/** A hand-authored template summary, the SDXL txt2img one unless overridden. */
export function makeTemplate(overrides: Partial<WorkflowTemplateSummary> = {}): WorkflowTemplateSummary {
  return {
    id: 'txt2img-sdxl',
    version: 1,
    label: 'Text to image (SDXL)',
    capability: 'txt2img',
    baseModels: ['sdxl', 'pony', 'illustrious'],
    isFallback: false,
    loaderFolder: 'checkpoints',
    loaderFolders: ['checkpoints'],
    requires: [],
    requiredNodeClasses: ['CheckpointLoaderSimple', 'KSampler'],
    description: 'Makes an image from a prompt on a graph written for sdxl, loading the model from checkpoints/.',
    ...overrides,
  };
}

/** One template option for a model's Workflows sheet. */
export function makeOption(
  template: Partial<WorkflowTemplateSummary>,
  verdict: Partial<ModelRunnability> = {},
  flags: { automatic?: boolean; assigned?: boolean } = {},
): ModelWorkflowOption {
  const t = makeTemplate(template);
  return {
    template: t,
    verdict: makeRunnability({ templateId: t.id, capabilities: [t.capability], ...verdict }),
    automatic: flags.automatic ?? false,
    assigned: flags.assigned ?? false,
  };
}

/** A `ModelInstall` in a given state, for the adoption test. */
export function installInState(status: ModelInstallStatus, detail: string | null): ModelInstall {
  return makeInstall({
    status,
    detail,
    startedAt: status === 'queued' ? null : '2026-09-06T08:28:07.594Z',
  });
}
