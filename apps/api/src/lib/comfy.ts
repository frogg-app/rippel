/**
 * A thin client for one ComfyUI server.
 *
 * ComfyUI has no authentication of its own, so these servers must stay on the
 * LAN and are only ever reached from this API process — never from the browser.
 */

export interface SystemStats {
  system?: {
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    os?: string;
    ram_total?: number;
    ram_free?: number;
  };
  devices?: {
    name: string;
    type: string;
    index?: number;
    /**
     * What the driver claims. Treat as a budget, not as physical VRAM: on ROCm
     * with DynamicVRAM and on unified-memory systems this pools host memory in,
     * so a 16 GB card can report 36 GB. Nothing in this API distinguishes the
     * two cases, which is why we never present it as the card's size.
     */
    vram_total?: number;
    vram_free?: number;
    /** Torch's own accounting. Zero until a model has been loaded. */
    torch_vram_total?: number;
    torch_vram_free?: number;
  }[];
}

/** The shape of /object_info we care about: which files each loader can see. */
export interface ObjectInfo {
  [nodeClass: string]: {
    input?: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  };
}

/**
 * One output file as ComfyUI names it in a /history entry. `type` is the
 * folder class: finished work is `output`, live previews are `temp`.
 */
export interface ComfyOutputRef {
  filename: string;
  subfolder?: string;
  type?: 'output' | 'temp' | 'input';
}

export interface ComfyImageBytes {
  bytes: Buffer;
  contentType: string;
}

export class ComfyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ComfyError';
  }
}

export class ComfyClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new ComfyError(`${path} returned ${res.status}`, res.status);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ComfyError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new ComfyError(`Could not reach ${this.baseUrl}${path}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  systemStats(): Promise<SystemStats> {
    return this.get<SystemStats>('/system_stats');
  }

  objectInfo(): Promise<ObjectInfo> {
    return this.get<ObjectInfo>('/object_info');
  }

  /**
   * Download one finished output's bytes from /view.
   *
   * This deliberately does not go through `get()`: that path parses JSON and
   * gives up after 8s, which is right for a status poll and wrong here. A
   * finished image is megabytes coming off a LAN box that may still be busy
   * with the next job, so image transfers get their own, much longer budget —
   * failing a download after 8s would throw away GPU time already spent.
   *
   * `subfolder` and `type` come straight from the history entry's output
   * record; ComfyUI needs all three to resolve the file.
   */
  async viewImage(ref: ComfyOutputRef, timeoutMs = 120_000): Promise<ComfyImageBytes> {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type ?? 'output',
    });
    const url = `${this.baseUrl}/view?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new ComfyError(`/view ${ref.filename} returned ${res.status}`, res.status);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      // A 200 with an empty body means the file vanished between /history and
      // this request — a purged temp output, say. Treat it as a failure here
      // rather than storing a zero-byte asset the library cannot render.
      if (bytes.byteLength === 0) {
        throw new ComfyError(`/view ${ref.filename} returned an empty body`);
      }
      return {
        bytes,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    } catch (err) {
      if (err instanceof ComfyError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new ComfyError(`Could not download ${ref.filename} from ${this.baseUrl}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pull the installed model filenames out of an /object_info payload.
 *
 * ComfyUI reports available files as the enum of a loader node's input, so the
 * list of checkpoints is literally the first option list of CheckpointLoader.
 * This maps the loader nodes we care about onto our own model types.
 */
const LOADERS: { node: string; input: string; type: ModelTypeName }[] = [
  { node: 'CheckpointLoaderSimple', input: 'ckpt_name', type: 'checkpoint' },
  { node: 'UNETLoader', input: 'unet_name', type: 'checkpoint' },
  { node: 'LoraLoader', input: 'lora_name', type: 'lora' },
  { node: 'VAELoader', input: 'vae_name', type: 'vae' },
  { node: 'ControlNetLoader', input: 'control_net_name', type: 'controlnet' },
  { node: 'UpscaleModelLoader', input: 'model_name', type: 'upscaler' },
  { node: 'CLIPLoader', input: 'clip_name', type: 'clip' },
  { node: 'DualCLIPLoader', input: 'clip_name1', type: 'clip' },
];

type ModelTypeName =
  | 'checkpoint'
  | 'lora'
  | 'vae'
  | 'controlnet'
  | 'upscaler'
  | 'clip'
  | 'video';

export interface DiscoveredModel {
  type: ModelTypeName;
  filename: string;
}

/** Extensions a real model file on disk actually has. */
export const MODEL_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

/**
 * Read the option list out of one node input spec.
 *
 * ComfyUI has two shapes in the wild and both appear in a single 0.34 install:
 *
 *   legacy: [["a.safetensors", "b.safetensors"], { tooltip: ... }]
 *   combo:  ["COMBO", { multiselect: false, options: ["a.safetensors"] }]
 *
 * Handling only the first silently discovers nothing for the loaders that use
 * the second, so both are read here.
 */
export function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null;

  const [head, config] = spec;

  // Legacy: the first element is the option list itself.
  if (Array.isArray(head)) {
    return head.filter((v): v is string => typeof v === 'string');
  }

  // Combo: the options live in the config object.
  if (head === 'COMBO' && config && typeof config === 'object') {
    const options = (config as { options?: unknown }).options;
    if (Array.isArray(options)) {
      return options.filter((v): v is string => typeof v === 'string');
    }
    return [];
  }

  return null;
}

/**
 * The same thing for callers that only want the list. An input that is not a
 * combo at all and a combo with nothing installed both read as empty here —
 * which is fine for discovery and emphatically not fine for preflight, hence
 * the nullable {@link comboOptions} underneath.
 */
function readOptions(spec: unknown): string[] {
  return comboOptions(spec) ?? [];
}

export function extractModels(info: ObjectInfo): DiscoveredModel[] {
  const found = new Map<string, DiscoveredModel>();

  for (const loader of LOADERS) {
    const node = info[loader.node];
    if (!node) continue;
    const spec = node.input?.required?.[loader.input] ?? node.input?.optional?.[loader.input];

    for (const filename of readOptions(spec)) {
      // Some loaders offer built-in pseudo-entries alongside real files —
      // VAELoader lists "pixel_space", which is not a file anyone installed.
      if (!MODEL_EXTENSIONS.test(filename)) continue;
      found.set(`${loader.type}:${filename}`, { type: loader.type, filename });
    }
  }

  return [...found.values()];
}

/** "flux1-dev-fp8.safetensors" -> "Flux1 Dev Fp8" */
export function prettyModelName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? filename;
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
