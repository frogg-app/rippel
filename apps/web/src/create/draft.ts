/**
 * The Create form, kept while you go elsewhere and come back.
 *
 * The report: a prompt typed, a starting image picked, a look at the Library,
 * and back on Create everything was blank. The form lived in `CreatePage`'s
 * state, which dies with the route.
 *
 * Two layers, the same split the Models and Library caches use:
 *
 *  - **In memory**, for in-app navigation. Written on every change, read when
 *    the page mounts. Nothing is lost between two routes.
 *  - **In localStorage, per user**, for reloads. Debounced, because the prompt
 *    field writes on every keystroke. Small by construction: a starting image
 *    is uploaded the moment it is picked (`ReferenceImage`), so the draft holds
 *    an asset or upload id and its thumbnail URL, never the bytes.
 *
 * A draft belongs to one user. Signing out or switching user clears it, so the
 * next person at the browser does not inherit someone else's prompt.
 *
 * What is restored is re-checked by the page against what exists now (see
 * `reviseDraft`): a model or style add-on that has gone is dropped with a note.
 */
import type { LoraSelection, Model } from '@comfy/shared';
import { initialFormState, type CreateFormState } from './form';

const PREFIX = 'rippel.create.draft.';
const SAVE_DELAY_MS = 400;

let memory: { userId: string; form: CreateFormState } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: { userId: string; form: CreateFormState } | null = null;

function key(userId: string): string {
  return `${PREFIX}${userId}`;
}

/**
 * A stored draft, made safe to use: anything missing or the wrong shape takes
 * the default, so a draft written by an older build never breaks the page.
 */
export function parseDraft(raw: string | null): CreateFormState | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<CreateFormState>;
  const base = initialFormState();
  const pick = <K extends keyof CreateFormState>(field: K, ok: (v: unknown) => boolean): CreateFormState[K] =>
    ok(stored[field]) ? (stored[field] as CreateFormState[K]) : base[field];
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isString = (v: unknown) => typeof v === 'string';

  return {
    kind: pick('kind', isString),
    prompt: pick('prompt', isString),
    negativePrompt: pick('negativePrompt', isString),
    negativeOpen: pick('negativeOpen', (v) => typeof v === 'boolean'),
    modelId: pick('modelId', (v) => v === null || isString(v)),
    quality: pick('quality', isString),
    aspect: pick('aspect', isString),
    batchSize: pick('batchSize', (v) => typeof v === 'number' && Number.isFinite(v)),
    video: isObject(stored.video) ? { ...base.video, ...stored.video } : base.video,
    loras: pick('loras', (v) =>
      Array.isArray(v) && v.every((s) => isObject(s) && isString((s as LoraSelection).modelId) && typeof (s as LoraSelection).weight === 'number'),
    ),
    advanced: isObject(stored.advanced) ? { ...base.advanced, ...stored.advanced } : base.advanced,
    initImage: pick('initImage', (v) => v === null || (isObject(v) && isObject((v as { source?: unknown }).source) && isString((v as { previewUrl?: unknown }).previewUrl))),
    visibility: pick('visibility', isString),
  };
}

/** The draft for this user: memory first, then what the last visit saved. */
export function loadDraft(userId: string | null): CreateFormState | null {
  if (!userId) return memory?.form ?? null;
  if (memory?.userId === userId) return memory.form;
  try {
    return parseDraft(localStorage.getItem(key(userId)));
  } catch {
    return null;
  }
}

/** Remember the form now, and write it to storage shortly. */
export function saveDraft(userId: string | null, form: CreateFormState): void {
  memory = { userId: userId ?? '', form };
  if (!userId) return;
  pending = { userId, form };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushDraft, SAVE_DELAY_MS);
}

/** Write a pending save straight away (page hide, tests). */
export function flushDraft(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  try {
    localStorage.setItem(key(pending.userId), JSON.stringify(pending.form));
  } catch {
    // Private mode or a full quota: the in-memory copy still covers navigation.
  }
  pending = null;
}

/**
 * Forget a user's draft, or every draft when no user is named (sign-out).
 */
export function clearDraft(userId?: string | null): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  if (!userId || memory?.userId === userId) memory = null;
  try {
    if (userId) {
      localStorage.removeItem(key(userId));
    } else {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const name = localStorage.key(i);
        if (name?.startsWith(PREFIX)) localStorage.removeItem(name);
      }
    }
  } catch {
    // Nothing stored to clear.
  }
}

/**
 * A restored draft checked against what exists now. A model or style that is
 * no longer installed is dropped, and the note says which. Whether a model
 * still *fits* the mode is the picker's existing repair (it drops a model it
 * does not list), and whether add-ons still fit is `invalidLoras`.
 */
export function reviseDraft(
  form: CreateFormState,
  available: { checkpoints: readonly Model[]; loras: readonly Model[] },
): { form: CreateFormState; dropped: string[] } {
  const dropped: string[] = [];
  let next = form;
  if (form.modelId && !available.checkpoints.some((model) => model.id === form.modelId)) {
    dropped.push('the model');
    next = { ...next, modelId: null };
  }
  const keep = form.loras.filter((selection) => available.loras.some((model) => model.id === selection.modelId));
  if (keep.length !== form.loras.length) {
    const gone = form.loras.length - keep.length;
    dropped.push(gone === 1 ? 'a style add-on' : `${gone} style add-ons`);
    next = { ...next, loras: keep };
  }
  return { form: next, dropped };
}

/** "Your draft's model and a style add-on are no longer installed, so they were removed." */
export function droppedSentence(dropped: string[], what = 'no longer installed'): string | null {
  if (dropped.length === 0) return null;
  const list = dropped.length === 1 ? dropped[0] : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
  return `From your saved draft, ${list} ${dropped.length === 1 && !/add-ons$/.test(dropped[0]!) ? 'is' : 'are'} ${what}, so ${dropped.length === 1 && !/add-ons$/.test(dropped[0]!) ? 'it was' : 'they were'} removed.`;
}

/** Test seam. */
export function resetDraftStore(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  memory = null;
}
