/**
 * Where the facts about a catalogue entry actually come from.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REACHABLE FROM THIS BOX, measured rather than assumed (2026-09-06,
 * against the live ComfyUI-Manager catalogue on 192.168.1.10):
 *
 *   - Of the 372 entries the real backend offers, **368 reference a
 *     huggingface.co model page**, 2 reference Civitai and 2 reference GitHub.
 *     Those 368 collapse onto **132 distinct repos** — eleven GGUF quantisations
 *     of FLUX.1-dev share one page — which is why everything here is keyed by
 *     repo and not by entry.
 *   - `https://huggingface.co/api/models/<repo>?full=true` answers 200 with no
 *     credentials: downloads, likes, pipeline tag, `cardData.license`, and the
 *     full file list. 130 of the 132 repos answered; the two that did not are
 *     gated (`stabilityai/stable-diffusion-2-1`, 401) and stay that way.
 *   - **Civitai is not usable from here.** `GET /api/v1/models/<id>` and
 *     `/api/v1/model-versions/by-hash/<hash>` — the two endpoints that would
 *     give a picture — both answer **451 REGION_BLOCKED** from this machine.
 *     Only the search endpoint (`/api/v1/models?query=`) answers, and matching
 *     a filename against a search result is a guess: it would put a picture of
 *     somebody else's model on a card. For four entries out of 372 that trade
 *     is not worth making, so a Civitai reference is recorded as unsupported
 *     and the card keeps its family gradient.
 *
 * ---------------------------------------------------------------------------
 * WHERE A PICTURE COMES FROM. HuggingFace has no "preview image" field, so
 * there are only two honest places to look, both of them things the model's own
 * author put in their own repo:
 *
 *   1. The images embedded in the model card (README.md). This is the author's
 *      chosen hero shot, and it is first for that reason.
 *   2. Image files committed to the repo, ranked by name — anything called
 *      sample/example/demo/preview/teaser/result first, then shallow paths.
 *
 * Badges, shields and logos are excluded by name: a shields.io "license MIT"
 * pill rendered as a model preview is worse than no picture at all.
 *
 * 68 of the 130 readable repos have something. For a repo with nothing, one
 * more hop is allowed: if its card declares **exactly one** `base_model`, we
 * take that model's picture and record whose it is, so the card can say "sample
 * from black-forest-labs/FLUX.1-dev, which this is quantised from". That is
 * true of a quantisation or a distillation and it is honest as long as it is
 * labelled; it is *not* done when a repo lists fourteen base models, because
 * then which one the file came from is a guess. That hop adds 29 repos.
 */

/** A model page we know how to read. */
export type SourceRef =
  | { kind: 'huggingface'; repo: string }
  | { kind: 'civitai'; id: string };

/** Raised for a reference we deliberately will not follow. See Civitai above. */
export class UnsupportedSource extends Error {}

/**
 * Turn a catalogue `reference` into something addressable.
 *
 * Returns null for anything else — GitHub project pages, mostly, which have no
 * API worth the round trip and no picture of a model on them.
 */
export function parseReference(reference: string | null | undefined): SourceRef | null {
  if (!reference) return null;

  const hf = /^https?:\/\/huggingface\.co\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(reference);
  if (hf) {
    // Manager's list carries trailing slashes and, in a couple of rows, a
    // filename where the repo should be ("Afizi/ESRGAN_4x.pth"). The API
    // answers for that string too, so it is left alone rather than repaired.
    return { kind: 'huggingface', repo: `${hf[1]}/${hf[2]}`.replace(/\/+$/, '') };
  }

  const civitai = /^https?:\/\/civitai\.com\/models\/(\d+)/i.exec(reference);
  if (civitai) return { kind: 'civitai', id: civitai[1]! };

  return null;
}

/** The stable cache key. One row per model page, not per file. */
export function sourceKeyOf(ref: SourceRef): string {
  return ref.kind === 'huggingface' ? `hf:${ref.repo}` : `civitai:${ref.id}`;
}

export function sourceLabel(ref: SourceRef): string {
  return ref.kind === 'huggingface' ? `huggingface.co/${ref.repo}` : `civitai.com/models/${ref.id}`;
}

export function sourceUrl(ref: SourceRef): string {
  return ref.kind === 'huggingface'
    ? `https://huggingface.co/${ref.repo}`
    : `https://civitai.com/models/${ref.id}`;
}

/** What one model page told us. Every field is optional at the source. */
export interface SourceFacts {
  referenceUrl: string;
  license: string | null;
  downloads: number | null;
  likes: number | null;
  pipelineTag: string | null;
  /** Absolute image URLs, best first. Empty is the common case. */
  imageCandidates: string[];
  /**
   * The single model this one is declared to be built from, if exactly one is
   * declared. Used for the borrowed-picture hop, and for nothing else.
   */
  derivedFrom: SourceRef | null;
}

const USER_AGENT = 'comfy-studio/0.1 (self-hosted; model catalogue metadata)';

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function getText(url: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

interface HfModel {
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  cardData?: { license?: unknown; base_model?: unknown; thumbnail?: unknown };
  siblings?: { rfilename?: string }[];
}

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)(\?|$)/i;

/**
 * Names that are decoration rather than a sample. Excluded everywhere: a
 * repository's logo or a "downloads 2M" badge is not a preview of a model.
 */
const NOT_A_SAMPLE =
  /shields\.io|badge|\blogos?\b|\bbrand\b|banner|\/icons?\/|button|\bfavicon\b|diagram|pipeline|architecture|\bchart\b|\bplot\b|\bgraph\b/i;

/** Names that promise an actual generated image. Ranked first. */
const LOOKS_LIKE_A_SAMPLE = /sample|example|demo|preview|teaser|hero|result|showcase|output/i;

/** Markdown `![](x)` and inline `<img src="x">`, in document order. */
function imagesInMarkdown(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) found.push(match[1]!);
  for (const match of markdown.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) found.push(match[1]!);
  return found;
}

/** `./media/x.gif` in a README of repo R -> the resolve URL for that blob. */
function absoluteInRepo(repo: string, path: string): string | null {
  if (/^https?:\/\//i.test(path)) return IMAGE_EXTENSION.test(path) ? path : null;
  if (path.startsWith('//') || path.startsWith('data:')) return null;
  const clean = path.replace(/^\.?\//, '');
  if (!IMAGE_EXTENSION.test(clean)) return null;
  const encoded = clean.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repo}/resolve/main/${encoded}`;
}

function firstDeclaredBaseModel(cardData: HfModel['cardData']): string | null {
  const declared = cardData?.base_model;
  if (typeof declared === 'string') return declared;
  // A list of one is a single declaration written as an array. A list of
  // fourteen — Comfy-Org's Wan repackage — is not a declaration about *this*
  // file at all, and following it would attribute a picture at random.
  if (Array.isArray(declared) && declared.length === 1 && typeof declared[0] === 'string') {
    return declared[0];
  }
  return null;
}

async function huggingFaceFacts(repo: string): Promise<SourceFacts> {
  const model = (await getJson(
    `https://huggingface.co/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?full=true`,
  )) as HfModel;

  const candidates: string[] = [];

  // 1. The card's own images, in the order the author wrote them.
  //    The README is a separate request and a repo may not have one; a missing
  //    card is not a failure, it just means fewer candidates.
  let card = '';
  try {
    card = await getText(`https://huggingface.co/${repo}/raw/main/README.md`);
  } catch {
    card = '';
  }
  const inCard = imagesInMarkdown(card)
    .filter((raw) => !NOT_A_SAMPLE.test(raw))
    // Within the card, a file that says it is a sample outranks one that does
    // not: the SD3 ControlNet cards open with `canny.jpg`, the *input* edge map,
    // and only then show `demo_0.jpg`, the picture it produced.
    .sort((a, b) => Number(!LOOKS_LIKE_A_SAMPLE.test(a)) - Number(!LOOKS_LIKE_A_SAMPLE.test(b)));
  for (const raw of inCard) {
    const absolute = absoluteInRepo(repo, raw);
    if (absolute) candidates.push(absolute);
  }

  // 2. Image files in the repo, sample-looking and shallow first.
  const files = (model.siblings ?? [])
    .map((sibling) => sibling.rfilename)
    .filter((name): name is string => typeof name === 'string' && IMAGE_EXTENSION.test(name))
    .filter((name) => !NOT_A_SAMPLE.test(name))
    .sort((a, b) => {
      const bySample = Number(!LOOKS_LIKE_A_SAMPLE.test(a)) - Number(!LOOKS_LIKE_A_SAMPLE.test(b));
      if (bySample !== 0) return bySample;
      const byDepth = a.split('/').length - b.split('/').length;
      return byDepth !== 0 ? byDepth : a.localeCompare(b);
    });
  for (const name of files) {
    const absolute = absoluteInRepo(repo, name);
    if (absolute) candidates.push(absolute);
  }

  const thumbnail = model.cardData?.thumbnail;
  if (typeof thumbnail === 'string') {
    const absolute = absoluteInRepo(repo, thumbnail);
    if (absolute) candidates.unshift(absolute);
  }

  const license = model.cardData?.license;
  const parent = firstDeclaredBaseModel(model.cardData);

  return {
    referenceUrl: `https://huggingface.co/${repo}`,
    license: typeof license === 'string' ? license : Array.isArray(license) ? String(license[0] ?? '') || null : null,
    downloads: typeof model.downloads === 'number' ? model.downloads : null,
    likes: typeof model.likes === 'number' ? model.likes : null,
    pipelineTag: typeof model.pipeline_tag === 'string' ? model.pipeline_tag : null,
    imageCandidates: [...new Set(candidates)],
    derivedFrom:
      parent && /^[^/\s]+\/[^/\s]+$/.test(parent) ? { kind: 'huggingface', repo: parent } : null,
  };
}

export async function fetchSourceFacts(ref: SourceRef): Promise<SourceFacts> {
  if (ref.kind === 'civitai') {
    // Not a failure to retry: this machine gets 451 REGION_BLOCKED from every
    // Civitai endpoint that carries images. Recorded so the sweep stops asking.
    throw new UnsupportedSource(
      'Civitai answers 451 (region blocked) to this server, so its model pages cannot be read from here.',
    );
  }
  return huggingFaceFacts(ref.repo);
}
