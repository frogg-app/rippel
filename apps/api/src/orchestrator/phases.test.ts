/**
 * The phase machine, replayed over the frames a real backend actually sent.
 *
 * The sequence in `FRAMES` is the abridged capture from ComfyUI 0.34.0 at
 * 192.168.1.10:8188 on 2026-09-06 (the full log is quoted in phases.ts). It is
 * pinned here because the thing that breaks is not the arithmetic, it is the
 * protocol: ComfyUI now sends `progress_state` beside the flat `progress`
 * frame, and a change of vocabulary must not silently leave the bar at zero.
 */

import { describe, expect, it } from 'vitest';

import { ComfySocket, type ComfyProgress } from './comfy-socket.js';
import { decodingLabel, isSamplerClass, preparingLabel, samplingLabel, savingLabel, classOf, type PhaseContext } from './phases.js';

const PROMPT = '1c07e03f-dee1-4813-ac2b-e339a11f8eb9';

const CTX: PhaseContext = {
  nodeClasses: {
    '4': 'CheckpointLoaderSimple',
    '5': 'EmptyLatentImage',
    '6': 'CLIPTextEncode',
    '7': 'CLIPTextEncode',
    '3': 'KSampler',
    '8': 'VAEDecode',
    '9': 'SaveImage',
  },
  modelLabel: 'SDXL 1.0',
  backendName: 'desktop-6900xt',
  isVideo: false,
  batchSize: 1,
  totalFrames: null,
};

const state = (nodes: Record<string, [number, number, 'running' | 'finished']>) => ({
  type: 'progress_state',
  data: {
    prompt_id: PROMPT,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, [value, max, s]]) => [
        id,
        { value, max, state: s, node_id: id, display_node_id: id, prompt_id: PROMPT },
      ]),
    ),
  },
});

const FRAMES: unknown[] = [
  { type: 'execution_start', data: { prompt_id: PROMPT } },
  { type: 'execution_cached', data: { nodes: ['4'], prompt_id: PROMPT } },
  state({ '5': [0, 1, 'running'] }),
  { type: 'executing', data: { node: '5', display_node: '5', prompt_id: PROMPT } },
  state({ '5': [1, 1, 'finished'], '7': [0, 1, 'running'] }),
  { type: 'executing', data: { node: '7', display_node: '7', prompt_id: PROMPT } },
  state({ '7': [1, 1, 'finished'], '6': [0, 1, 'running'] }),
  { type: 'executing', data: { node: '6', display_node: '6', prompt_id: PROMPT } },
  state({ '6': [1, 1, 'finished'], '3': [0, 1, 'running'] }),
  { type: 'executing', data: { node: '3', display_node: '3', prompt_id: PROMPT } },
  state({ '3': [1, 8, 'running'] }),
  { type: 'progress', data: { value: 1, max: 8, prompt_id: PROMPT, node: '3' } },
  state({ '3': [8, 8, 'running'] }),
  { type: 'progress', data: { value: 8, max: 8, prompt_id: PROMPT, node: '3' } },
  state({ '3': [8, 8, 'finished'] }),
  { type: 'executing', data: { node: '8', display_node: '8', prompt_id: PROMPT } },
  { type: 'executing', data: { node: '9', display_node: '9', prompt_id: PROMPT } },
  { type: 'executed', data: { node: '9', output: { images: [] }, prompt_id: PROMPT } },
  { type: 'execution_success', data: { prompt_id: PROMPT } },
  { type: 'executing', data: { node: null, prompt_id: PROMPT } },
];

/** Drive a socket's frame handling without opening one. */
function replay(frames: unknown[]) {
  const executing: (string | null)[] = [];
  const progress: ComfyProgress[] = [];
  let done = 0;

  const socket = new ComfySocket('http://backend:8188', 'client', {
    onExecuting: (_promptId, node) => executing.push(node),
    onProgress: (_promptId, p) => progress.push(p),
    onDone: () => (done += 1),
  });
  const handle = (socket as unknown as { handleText(raw: string): void }).handleText.bind(socket);
  for (const frame of frames) handle(JSON.stringify(frame));

  return { executing, progress, done };
}

describe('ComfySocket against the frames a real ComfyUI 0.34 sends', () => {
  it('reports each executing node once, though two vocabularies announce it', () => {
    const { executing, done } = replay(FRAMES);
    expect(executing).toEqual(['5', '7', '6', '3', '8', '9', null]);
    expect(done).toBe(1);
  });

  it('reports each sampler step once, from whichever frame carried it', () => {
    const { progress } = replay(FRAMES);
    expect(progress.map((p) => `${p.value}/${p.max}`)).toEqual(['1/8', '8/8']);
    expect(progress.every((p) => p.node === '3')).toBe(true);
  });

  it('still works when the flat progress frame is gone', () => {
    // Recent ComfyUI has been consolidating on progress_state; a build that
    // drops the old frame must not silently stop the bar.
    const { executing, progress } = replay(FRAMES.filter((f) => (f as { type: string }).type !== 'progress'));
    expect(progress.map((p) => p.value)).toEqual([1, 8]);
    expect(executing).toEqual(['5', '7', '6', '3', '8', '9', null]);
  });

  it('still works when only the flat progress frame is sent', () => {
    const { executing, progress } = replay(
      FRAMES.filter((f) => (f as { type: string }).type !== 'progress_state'),
    );
    expect(progress.map((p) => p.value)).toEqual([1, 8]);
    expect(executing).toEqual(['5', '7', '6', '3', '8', '9', null]);
  });

  it('does not mistake a one-shot node for a step counter', () => {
    // Every loader and text encode reports value 0 of max 1 while running.
    const { progress } = replay([state({ '4': [0, 1, 'running'] })]);
    expect(progress).toEqual([]);
  });
});

describe('labels', () => {
  it('names what is loading, not the phase word', () => {
    expect(preparingLabel(CTX, '4')).toBe('Loading SDXL 1.0');
    expect(preparingLabel(CTX, '6')).toBe('Encoding the prompt');
    expect(preparingLabel({ ...CTX, nodeClasses: { '11': 'VAEEncode' } }, '11')).toBe(
      'Encoding the starting image',
    );
    expect(preparingLabel({ ...CTX, nodeClasses: { '10': 'LoadImage' } }, '10')).toBe(
      'Reading the starting image',
    );
    // Inside the sampler before step 1 is the weights reaching the device.
    expect(preparingLabel(CTX, '3')).toBe('Loading SDXL 1.0 into memory');
    // Nothing executing yet: on a shared box that is a queue, not a load.
    expect(preparingLabel(CTX, null)).toBe('Queued on desktop-6900xt');
  });

  it('names the slow decode, which is most of the wall clock on this hardware', () => {
    expect(decodingLabel(CTX, '8')).toBe('Decoding image');
    expect(decodingLabel({ ...CTX, isVideo: true, totalFrames: 97 }, '8')).toBe('Decoding 97 frames');
    expect(decodingLabel({ ...CTX, batchSize: 4 }, '8')).toBe('Decoding 4 images');
    expect(decodingLabel(CTX, '9')).toBe('Writing the image on desktop-6900xt');
  });

  it('says how much is being made', () => {
    expect(samplingLabel(CTX)).toBe('Rendering the image');
    expect(samplingLabel({ ...CTX, batchSize: 4 })).toBe('Rendering 4 images');
    expect(samplingLabel({ ...CTX, isVideo: true, totalFrames: 97 })).toBe('Rendering 97 frames');
  });

  it('counts our own storing pass from one', () => {
    expect(savingLabel(1, 1)).toBe('Storing the result');
    expect(savingLabel(1, 2)).toBe('Storing 1 of 2');
  });

  it('degrades without node classes rather than lying', () => {
    // A job re-adopted after a restart has no graph to read classes from.
    const bare: PhaseContext = { ...CTX, nodeClasses: {} };
    expect(classOf(bare, '8')).toBeNull();
    expect(preparingLabel(bare, '8')).toBe('Preparing on desktop-6900xt');
    expect(decodingLabel(bare, '8')).toBe('Finishing up');
  });

  it('knows a sampler from a decoder, which is what separates the phases', () => {
    expect(isSamplerClass('KSampler')).toBe(true);
    expect(isSamplerClass('SamplerCustom')).toBe(true);
    expect(isSamplerClass('VAEDecode')).toBe(false);
    expect(isSamplerClass(null)).toBe(false);
  });
});
