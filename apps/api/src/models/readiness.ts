/**
 * "Can this backend actually run this workflow, and if not, what would fix it?"
 *
 * `preflight.ts` answers a narrower question — is this *compiled graph* about to
 * fail — and answers it with one sentence, at dispatch, when the user has
 * already committed. This answers the question a person asks *before* they
 * commit, and answers it with a list they can act on: every file the workflow
 * needs, which of them the backend has, and for each gap the catalogue entries
 * that would close it.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES, NOT TWO — and the third is the whole reason this file exists.
 *
 * The obvious design has "installed" and "not installed". The reference machine
 * proves that is wrong, and it is wrong in the direction that wastes a user's
 * evening. Verified against http://192.168.1.10:8188 on 2026-09-06:
 *
 *   GET /api/models/checkpoints        -> ["SDXL\\sd_xl_base_1.0.safetensors",
 *                                          "hunyuan_video_720p_fp8_e4m3fn.safetensors"]
 *   GET /api/models/diffusion_models   -> ["ltx-video-2b-v0.9.1.safetensors"]
 *   GET /externalmodel/getlist?mode=cache
 *       -> {..., "save_path": "checkpoints/LTXV",
 *                "filename": "ltx-video-2b-v0.9.1.safetensors",
 *                "installed": "True"}
 *
 * ComfyUI-Manager says that checkpoint is installed. ComfyUI says it is only in
 * `diffusion_models/`. Both are telling the truth about different things:
 * Manager matched the *filename* somewhere on disk rather than at the
 * `save_path` its own entry specifies. So Manager's `installed` flag is not an
 * answer to "can this run", and — worse — because it believes the file is there
 * it will refuse to fetch it again. Re-installing is not a fix. Clicking harder
 * is not a fix.
 *
 * We cannot fix it either: ComfyUI exposes no API that moves a file, and
 * Manager's installer is the only writer we have on the backend's disk. So this
 * module detects the state, reports it as `misfiled` rather than `missing`, and
 * says exactly which file to move where — plus which *other* build of the same
 * model could be installed instead, since that route we can automate. A clear
 * instruction is a legitimate answer. A silent failure is not.
 * ---------------------------------------------------------------------------
 *
 * Everything expensive here is borrowed rather than rebuilt: `/object_info` and
 * its cache come from `orchestrator/preflight.ts`, the catalogue from the
 * backend's own `ModelTransport`, the template from `workflows/registry.ts`,
 * and the companion-model resolution from `workflows/requirements.ts`.
 */

import type {
  BackendReadiness,
  MisfiledModel,
  ModelCatalogEntry,
  ModelRequirementReport,
  ModelType,
  Uuid,
} from '@comfy/shared';

import { comboOptions, type ObjectInfo } from '../lib/comfy.js';
import { objectInfoFor } from '../orchestrator/preflight.js';
import {
  modelBasename,
  requirementSite,
  resolveRequirements,
  sameModelFile,
} from '../workflows/requirements.js';
import type { ModelRequirement, WorkflowTemplate } from '../workflows/types.js';
import { listBackendFolder, listBackendFolders } from './installs.js';
import type { ModelTransport } from './transport.js';

/**
 * Which ComfyUI folder each loader class reads from.
 *
 * This is the crux of the misfiled case: `CheckpointLoaderSimple` and
 * `UNETLoader` both load a diffusion model, and they read *different folders*.
 * A file in the wrong one is invisible to exactly one of them.
 *
 * `installs.ts` has a type -> folder map for a different purpose (deciding
 * where a download should have landed). This one is keyed by node class because
 * that is what a graph names, and a type is not enough to distinguish these two.
 */
const FOLDER_FOR_LOADER: Record<string, string> = {
  CheckpointLoaderSimple: 'checkpoints',
  CheckpointLoader: 'checkpoints',
  UNETLoader: 'diffusion_models',
  CLIPLoader: 'text_encoders',
  DualCLIPLoader: 'text_encoders',
  TripleCLIPLoader: 'text_encoders',
  VAELoader: 'vae',
  LoraLoader: 'loras',
  LoraLoaderModelOnly: 'loras',
  ControlNetLoader: 'controlnet',
  UpscaleModelLoader: 'upscale_models',
};

/**
 * Folders worth searching when a file the loader wants is not where it should
 * be, by model type. Bounded deliberately: a backend reports two dozen model
 * folders and scanning all of them is two dozen HTTP round trips for a screen
 * that should feel instant. These are the confusions that actually happen —
 * a diffusion model under `diffusion_models` instead of `checkpoints` (the LTX
 * case), a text encoder under the legacy `clip` folder instead of
 * `text_encoders` (ComfyUI renamed it, and older Manager entries still use the
 * old name).
 */
const SEARCH_FOLDERS: Record<ModelType, readonly string[]> = {
  checkpoint: ['checkpoints', 'diffusion_models', 'unet', 'diffusers'],
  clip: ['text_encoders', 'clip'],
  vae: ['vae', 'vae_approx'],
  lora: ['loras'],
  controlnet: ['controlnet'],
  upscaler: ['upscale_models', 'latent_upscale_models'],
  video: ['checkpoints', 'diffusion_models'],
};

/** Everything the analysis needs, so it can be tested without HTTP or a database. */
export interface ReadinessInput {
  readonly backend: { id: Uuid; name: string; base_url: string };
  readonly template: WorkflowTemplate;
  /**
   * The checkpoint filename this backend knows the user's model by, or null
   * when readiness was asked about a template rather than a specific model — in
   * which case the graph's own literal is used, which is exactly what a dispatch
   * would name anyway.
   */
  readonly checkpointFilename: string | null;
  readonly modelId: Uuid | null;
  readonly modelLabel: string | null;
  readonly info: ObjectInfo;
  /** Empty when we could not read one; `catalogueError` then says why. */
  readonly catalogue: readonly ModelCatalogEntry[];
  readonly catalogueError: string | null;
  /**
   * Folder -> the files ComfyUI lists in it. Only the folders relevant to this
   * template's gaps are ever fetched; see {@link scanFolders}.
   */
  readonly folders: ReadonlyMap<string, readonly string[]>;
}

// ------------------------------------------------------------------ helpers

/** The manifest input that carries the user's chosen checkpoint, if any. */
function checkpointPath(template: WorkflowTemplate): string | null {
  return template.manifest.inputs.find((i) => i.source === 'checkpointFilename')?.path ?? null;
}

/**
 * The user's checkpoint, expressed as a requirement.
 *
 * It is not one — the user picks it, so it has no `requires` entry — but every
 * question this module asks about a companion model is the same question we
 * must ask about the checkpoint, and on the reference box the checkpoint is the
 * one that is misfiled. Synthesising it here means one code path answers both
 * rather than the interesting case getting a lesser version of the analysis.
 */
function checkpointRequirement(template: WorkflowTemplate): ModelRequirement | null {
  const path = checkpointPath(template);
  if (!path) return null;
  return {
    id: 'checkpoint',
    path,
    modelType: 'checkpoint',
    label: 'Model checkpoint',
    why: 'The weights this workflow generates with — the model you picked.',
    match: {},
  };
}

/** Files the backend offers for the loader input a requirement fills. */
function offeredAt(
  info: ObjectInfo,
  nodeClass: string,
  inputName: string,
): string[] | null {
  const spec = info[nodeClass];
  const declared = spec?.input?.required?.[inputName] ?? spec?.input?.optional?.[inputName];
  return comboOptions(declared);
}

/**
 * Catalogue entries that would satisfy a requirement, best first.
 *
 * Ordered by how specifically they were matched: a `preferred` filename beats a
 * `catalogueFilename` pattern match, which beats a bare type + base match.
 * Entries the catalogue already calls installed are pushed to the back rather
 * than dropped — for a misfiled file, the entry claiming to have installed it is
 * exactly the row a person needs to see.
 */
export function offersFor(
  requirement: ModelRequirement,
  catalogue: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const { match } = requirement;
  const bases = (match.catalogueBase ?? []).map((b) => b.toLowerCase());
  const preferred = (requirement.preferred ?? []).map((p) => modelBasename(p).toLowerCase());

  const scored: { entry: ModelCatalogEntry; score: number }[] = [];
  for (const entry of catalogue) {
    if (entry.type !== requirement.modelType) continue;

    const byBase = bases.length > 0 && bases.includes(entry.base.toLowerCase());
    const byFilename = match.catalogueFilename?.test(entry.filename) ?? false;
    // With neither half of the match specified there is nothing to go on but
    // the type, and "every checkpoint in the catalogue" is not an offer — it is
    // 200 rows of noise. The synthetic checkpoint requirement is the case that
    // hits this, and it gets its offers from `checkpointOffers` instead.
    if (!byBase && !byFilename) continue;

    const isPreferred = preferred.includes(modelBasename(entry.filename).toLowerCase());
    const score =
      (isPreferred ? 0 : byFilename && byBase ? 1 : byFilename ? 2 : 3) + (entry.installed ? 10 : 0);
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.entry.filename.localeCompare(b.entry.filename))
    .map((s) => s.entry)
    .slice(0, MAX_OFFERS);
}

/**
 * How many alternatives are worth showing per gap.
 *
 * Not arbitrary. Verified against the live catalogue: `base: "t5"` alone
 * returns 17 entries — three T5-XXL safetensors builds and fourteen GGUF
 * quantisations — and "here are seventeen files, pick one" is not help. The
 * ranking above puts the ones a person should actually choose first, so the cut
 * is where a list stops being a menu and starts being a dump.
 */
const MAX_OFFERS = 8;

/**
 * Catalogue entries for *the checkpoint the user picked*.
 *
 * Different from `offersFor`: we are not looking for "any checkpoint", we are
 * looking for this exact file, and failing that other builds of the same family
 * — which is what makes "install ltx-video-2b-v0.9 instead" a real answer when
 * v0.9.1 is misfiled and Manager refuses to re-fetch it.
 */
export function checkpointOffers(
  filename: string,
  catalogue: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const target = modelBasename(filename).toLowerCase();
  const exact = catalogue.filter((e) => modelBasename(e.filename).toLowerCase() === target);
  const bases = new Set(exact.map((e) => e.base.toLowerCase()));
  const siblings = catalogue.filter(
    (e) =>
      bases.has(e.base.toLowerCase()) &&
      // Same *type* as well as the same family. Without this, "another build of
      // LTX-Video" pulls in the family's LoRAs and upscalers, which is how the
      // first live run of this offered a ControlNet as a replacement checkpoint.
      exact.some((x) => x.type === e.type) &&
      modelBasename(e.filename).toLowerCase() !== target &&
      !e.installed,
  );
  // Exact first (even when installed — that row is the evidence for a misfile),
  // then other builds of the same family that could be installed instead.
  return [...exact, ...siblings].slice(0, MAX_OFFERS);
}

/**
 * Is this file on the backend at all, and if so where?
 *
 * Returns the folders that list it. Comparison is on the basename, because
 * ComfyUI reports a file's subfolder as part of its name and the folder listing
 * does too — `SDXL\sd_xl_base_1.0.safetensors` inside `checkpoints`.
 */
export function foundIn(
  filename: string,
  folders: ReadonlyMap<string, readonly string[]>,
): string[] {
  const target = modelBasename(filename).toLowerCase();
  const hits: string[] = [];
  for (const [folder, files] of folders) {
    if (files.some((f) => modelBasename(f).toLowerCase() === target)) hits.push(folder);
  }
  return hits;
}

/** The sentence an operator can act on, and the only fix we have for a misfile. */
function misfileInstruction(params: {
  filename: string;
  foundInFolders: string[];
  requiredFolder: string;
  loaderClass: string;
  backendName: string;
  catalogueRef: string | null;
}): string {
  const from = params.foundInFolders.map((f) => `models/${f}/`).join(' or ');
  const base = modelBasename(params.filename);
  const managerNote = params.catalogueRef
    ? ' ComfyUI-Manager already reports it as installed, so it will not download it again — ' +
      'moving the file is the fix, or install one of the other builds listed below.'
    : '';
  return (
    `${params.backendName} has ${base} in ${from}, where ${params.loaderClass} cannot see it. ` +
    `Move it to models/${params.requiredFolder}/ on that machine and restart ComfyUI.${managerNote}`
  );
}

// ----------------------------------------------------------------- analysis

/**
 * The folders this template's gaps might hide a file in. Computed before any
 * HTTP happens so the caller fetches each folder exactly once.
 */
export function foldersToScan(template: WorkflowTemplate): string[] {
  const types = new Set<ModelType>(['checkpoint']);
  for (const requirement of template.manifest.requires ?? []) types.add(requirement.modelType);

  const folders = new Set<string>();
  for (const type of types) for (const folder of SEARCH_FOLDERS[type] ?? []) folders.add(folder);
  return [...folders];
}

/** Fetch those folders' listings, skipping any this backend does not have. */
export async function scanFolders(
  baseUrl: string,
  wanted: readonly string[],
): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  let existing: Set<string>;
  try {
    existing = new Set(await listBackendFolders(baseUrl));
  } catch {
    // No folder index means we cannot scan safely; a misfile then simply reads
    // as "missing", which is a worse answer but never a wrong one.
    return out;
  }

  await Promise.all(
    wanted
      .filter((folder) => existing.size === 0 || existing.has(folder))
      .map(async (folder) => {
        try {
          const files = await listBackendFolder(baseUrl, folder);
          if (files) out.set(folder, files);
        } catch {
          // One unreadable folder must not sink the whole report.
        }
      }),
  );
  return out;
}

/**
 * The analysis itself. Pure — every I/O result is an input — which is what lets
 * the LTX-Video case be pinned down in a unit test using the exact payloads the
 * live box returns.
 */
export function analyse(input: ReadinessInput): BackendReadiness {
  const { template, info, catalogue, folders } = input;
  const { manifest } = template;

  const reports: ModelRequirementReport[] = [];

  // ------------------------------------------------------------ checkpoint
  const checkpointReq = checkpointRequirement(template);
  if (checkpointReq) {
    const site = requirementSite(template.graph, checkpointReq);
    const filename = input.checkpointFilename ?? site?.literal ?? null;
    if (site && filename) {
      const available = offeredAt(info, site.nodeClass, site.inputName) ?? [];
      const satisfied = available.some((option) => sameModelFile(option, filename));
      reports.push(
        buildReport({
          requirement: checkpointReq,
          site,
          available,
          resolved: satisfied ? filename : null,
          wanted: filename,
          offers: checkpointOffers(filename, catalogue),
          folders,
          backendName: input.backend.name,
          catalogue,
        }),
      );
    }
  }

  // ------------------------------------------------------ companion models
  for (const resolved of resolveRequirements(template, info)) {
    const { requirement, site } = resolved;
    const offers = offersFor(requirement, catalogue);
    // Nothing on the backend matched. The file we would then look for on disk
    // is whatever the catalogue *claims* to have installed — that is the only
    // named candidate we have, and it is exactly the misfile signal.
    const claimed = offers.find((e) => e.installed);
    reports.push(
      buildReport({
        requirement,
        site,
        available: resolved.available ?? [],
        resolved: resolved.filename,
        wanted: resolved.filename ?? claimed?.filename ?? site.literal,
        offers,
        folders,
        backendName: input.backend.name,
        catalogue,
      }),
    );
  }

  // ----------------------------------------------------------- node classes
  const missingNodeClasses = manifest.requiredNodeClasses.filter((c) => !info[c]);

  // --------------------------------------------------------------- rollup
  const manualSteps: string[] = [];
  for (const report of reports) {
    if (report.misfiled) manualSteps.push(report.misfiled.instruction);
  }
  for (const nodeClass of missingNodeClasses) {
    manualSteps.push(
      `${input.backend.name} does not have the "${nodeClass}" node this workflow needs. ` +
        'It is a custom node, which has to be installed on that machine — no model download fixes it.',
    );
  }

  const installable = recommendedInstalls(reports);

  return {
    backendId: input.backend.id,
    backendName: input.backend.name,
    templateId: manifest.id,
    templateLabel: manifest.label,
    capability: manifest.capability,
    isFallback: manifest.isFallback === true,
    modelId: input.modelId,
    modelLabel: input.modelLabel,
    ready: reports.every((r) => r.status === 'satisfied') && missingNodeClasses.length === 0,
    requirements: reports,
    missingNodeClasses,
    installable,
    manualSteps,
    catalogueError: input.catalogueError,
  };
}

/**
 * One entry per gap: the *recommended* download, not every option.
 *
 * This is what a "fix this for me" button queues, so it has to be the answer a
 * careful operator would give, and two rules make it that:
 *
 *  1. **One per gap, the best-ranked one.** The first live run of this returned
 *     every offer for every gap — 32 catalogue entries, about 250 GB, for two
 *     missing files. A button that does that is not a fix, it is an outage. The
 *     alternatives are still on each requirement's `offers`, for an operator who
 *     wants the fp8 build instead; asking for one by ref is a deliberate act.
 *  2. **Nothing for a misfiled file.** The best repair there is moving the file
 *     the machine already has. Silently downloading a *different* build of the
 *     model the user picked would leave them generating with weights they did
 *     not choose, and would still leave the original sitting in the wrong
 *     folder. That gap belongs in `manualSteps`; its alternatives stay on the
 *     requirement for a human to pick from explicitly.
 */
function recommendedInstalls(reports: readonly ModelRequirementReport[]): ModelCatalogEntry[] {
  const chosen: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    if (report.status !== 'missing') continue;
    // An entry the catalogue already calls installed would be refused by the
    // transport, so offering it as a button would be a lie.
    const best = report.offers.find((e) => !e.installed);
    if (!best || seen.has(best.ref)) continue;
    seen.add(best.ref);
    chosen.push(best);
  }
  return chosen;
}

/** One requirement's row, including the misfiled/missing decision. */
function buildReport(params: {
  requirement: ModelRequirement;
  site: { nodeClass: string; inputName: string };
  available: readonly string[];
  /** The filename that satisfies it, when one does. */
  resolved: string | null;
  /** The filename we would look for on disk when nothing satisfies it. */
  wanted: string | null;
  offers: ModelCatalogEntry[];
  folders: ReadonlyMap<string, readonly string[]>;
  backendName: string;
  catalogue: readonly ModelCatalogEntry[];
}): ModelRequirementReport {
  const { requirement, site } = params;

  const common = {
    id: requirement.id,
    label: requirement.label,
    why: requirement.why,
    type: requirement.modelType,
    loaderClass: site.nodeClass,
    loaderInput: site.inputName,
    available: [...params.available],
    offers: params.offers,
  };

  if (params.resolved) {
    return { ...common, status: 'satisfied' as const, resolved: params.resolved, misfiled: null };
  }

  const requiredFolder = FOLDER_FOR_LOADER[site.nodeClass] ?? null;
  const elsewhere = params.wanted ? foundIn(params.wanted, params.folders) : [];
  const wrongFolders = requiredFolder
    ? elsewhere.filter((f) => f !== requiredFolder)
    : elsewhere;

  if (params.wanted && requiredFolder && wrongFolders.length > 0) {
    // The file is on the machine. Whether Manager also claims to have installed
    // it only changes the advice, not the diagnosis.
    const target = modelBasename(params.wanted).toLowerCase();
    const claim = params.catalogue.find(
      (e) => e.installed && modelBasename(e.filename).toLowerCase() === target,
    );
    const misfiled: MisfiledModel = {
      filename: params.wanted,
      foundInFolders: wrongFolders,
      requiredFolder,
      loaderClass: site.nodeClass,
      catalogueRef: claim?.ref ?? null,
      catalogueSavePath: claim ? claim.ref.slice(0, claim.ref.lastIndexOf('/')) : null,
      instruction: misfileInstruction({
        filename: params.wanted,
        foundInFolders: wrongFolders,
        requiredFolder,
        loaderClass: site.nodeClass,
        backendName: params.backendName,
        catalogueRef: claim?.ref ?? null,
      }),
    };
    return { ...common, status: 'misfiled' as const, resolved: null, misfiled };
  }

  return { ...common, status: 'missing' as const, resolved: null, misfiled: null };
}

// ------------------------------------------------------------------- facade

/**
 * The whole check for one backend, doing the I/O the analysis needs.
 *
 * `/object_info` is the one call that can refuse the report outright: without it
 * we know nothing about what the backend can load, and a readiness screen that
 * guesses is worse than one that says the backend is unreachable. The catalogue
 * failing is survivable — the gaps are still true, we just cannot offer a fix —
 * so that becomes `catalogueError` rather than an exception.
 */
export async function readinessFor(params: {
  backend: { id: Uuid; name: string; base_url: string };
  template: WorkflowTemplate;
  checkpointFilename: string | null;
  modelId: Uuid | null;
  modelLabel: string | null;
  /** Null when the caller may not see catalogue entries (installs are admin-only). */
  transport: ModelTransport | null;
  /** Why there is no transport, for `catalogueError`. */
  transportReason?: string | null;
}): Promise<BackendReadiness> {
  const info = await objectInfoFor(params.backend.base_url);

  let catalogue: ModelCatalogEntry[] = [];
  let catalogueError: string | null = params.transportReason ?? null;
  if (params.transport) {
    try {
      catalogue = await params.transport.catalogue();
      catalogueError = null;
    } catch (err) {
      catalogueError = err instanceof Error ? err.message : String(err);
    }
  }

  const folders = await scanFolders(
    params.backend.base_url,
    foldersToScan(params.template),
  );

  return analyse({
    backend: params.backend,
    template: params.template,
    checkpointFilename: params.checkpointFilename,
    modelId: params.modelId,
    modelLabel: params.modelLabel,
    info,
    catalogue,
    catalogueError,
    folders,
  });
}
