/**
 * One WebSocket to one ComfyUI backend, translated into our own progress shape.
 *
 * ComfyUI's socket is a firehose about the *server*, not about your job: it
 * reports whatever the server is currently executing, for everyone. We attach
 * with our own `clientId` and ComfyUI echoes it back on the frames caused by
 * our prompts, which is what makes filtering possible at all.
 *
 * The frames we care about, verified against ComfyUI 0.34.0 at
 * 192.168.1.10:8188 on 2026-09-06 by submitting a real SDXL prompt and logging
 * everything it sent back (the ordering is written out in phases.ts):
 *
 *   {type:'status',    data:{status:{exec_info:{queue_remaining:N}}}}
 *   {type:'execution_start',  data:{prompt_id, timestamp}}
 *   {type:'executing', data:{node, display_node, prompt_id}}   node null = done
 *   {type:'progress',  data:{value, max, prompt_id, node}}
 *   {type:'progress_state', data:{prompt_id, nodes:{
 *      "<id>":{value,max,state:'running'|'finished',node_id,display_node_id,
 *              parent_node_id,real_node_id}}}}
 *   {type:'executed',  data:{node, output, prompt_id}}
 *   {type:'execution_success', data:{prompt_id, timestamp}}
 *   {type:'execution_error', data:{prompt_id, exception_message, node_type,...}}
 *   {type:'execution_cached', data:{nodes, prompt_id}}
 *
 * `progress_state` is the newer vocabulary and reports *every* node's state on
 * every change; the flat `progress` frame is still sent alongside it on 0.34,
 * and this class deliberately reads both. Recent ComfyUI has been moving
 * towards progress_state as the only one, and a build that stops sending the
 * flat frame must not silently stop our progress bar — so both are normalised
 * onto the same callbacks here and deduplicated, and each frame type alone is
 * sufficient.
 *
 * Binary frames are live preview images (a small header then JPEG/PNG bytes).
 *
 * This class deliberately knows nothing about jobs or the database. It turns
 * socket traffic into callbacks keyed by ComfyUI's prompt id, and the caller
 * maps those onto our rows — which keeps the reconnection logic testable and
 * stops backend chatter reaching into the job pipeline.
 */

import WebSocket from 'ws';

export interface ComfyProgress {
  /** Current step within the node that is reporting, e.g. sampler steps. */
  value: number;
  max: number;
  node: string | null;
}

export interface ComfySocketHandlers {
  onProgress?: (promptId: string, progress: ComfyProgress) => void;
  onExecuting?: (promptId: string, node: string | null) => void;
  onPreview?: (promptId: string, image: Buffer, mimeType: string) => void;
  onError?: (promptId: string, message: string) => void;
  onDone?: (promptId: string) => void;
  /** Connection state, for surfacing "the backend went away" honestly. */
  onOpen?: () => void;
  onClose?: () => void;
}

/** Reconnect backoff: quick at first, then back off, capped. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export class ComfySocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /**
   * The prompt currently executing on this backend, learned from
   * `execution_start`. ComfyUI's `progress` frames carry a prompt_id in recent
   * versions but have not always, and preview frames are binary with no id at
   * all — so we track it here and attribute untagged frames to it.
   */
  private currentPrompt: string | null = null;
  /**
   * The last thing we told the caller, so that the two frame vocabularies do
   * not each announce the same step. ComfyUI 0.34 sends `progress_state` and
   * `progress` for one sampler step, a millisecond apart.
   */
  private lastProgressKey: string | null = null;
  private lastExecutingKey: string | null = null;

  constructor(
    private readonly baseUrl: string,
    readonly clientId: string,
    private readonly handlers: ComfySocketHandlers,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  connect(): void {
    if (this.closed) return;

    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(this.clientId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.handlers.onOpen?.();
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      try {
        if (isBinary) this.handleBinary(data as Buffer);
        else this.handleText(String(data));
      } catch (err) {
        // A frame we cannot parse is not worth killing the socket over; the
        // job's real state is always recoverable from /history.
        this.log(`[comfy-ws] bad frame: ${String(err)}`);
      }
    });

    ws.on('error', (err) => this.log(`[comfy-ws] ${this.baseUrl}: ${err.message}`));

    ws.on('close', () => {
      this.handlers.onClose?.();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private handleText(raw: string): void {
    const frame = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
    const data = frame.data ?? {};
    const promptId = typeof data['prompt_id'] === 'string' ? data['prompt_id'] : this.currentPrompt;

    switch (frame.type) {
      case 'execution_start':
        if (typeof data['prompt_id'] === 'string') this.currentPrompt = data['prompt_id'];
        break;

      case 'executing': {
        const node = data['node'] === null ? null : String(data['node'] ?? '');
        if (promptId) this.emitExecuting(promptId, node);
        // `node: null` is ComfyUI's way of saying this prompt is finished.
        if (node === null && promptId) {
          this.handlers.onDone?.(promptId);
          if (this.currentPrompt === promptId) this.currentPrompt = null;
        }
        break;
      }

      case 'progress': {
        const value = Number(data['value'] ?? 0);
        const max = Number(data['max'] ?? 0);
        if (promptId && Number.isFinite(value) && Number.isFinite(max) && max > 0) {
          this.emitProgress(promptId, {
            value,
            max,
            node: data['node'] == null ? null : String(data['node']),
          });
        }
        break;
      }

      /**
       * The newer per-node vocabulary. It reports every node of the prompt on
       * every change, so the interesting part is the one that is `running`:
       * that is both "which node is executing" (which distinguishes loading
       * from sampling from decoding) and, when its `max` is greater than one,
       * the step counter itself.
       */
      case 'progress_state': {
        if (!promptId) break;
        const nodes = data['nodes'];
        if (!nodes || typeof nodes !== 'object') break;

        let running: { id: string; value: number; max: number } | null = null;
        for (const [id, raw] of Object.entries(nodes as Record<string, unknown>)) {
          if (!raw || typeof raw !== 'object') continue;
          const state = (raw as { state?: unknown }).state;
          if (state !== 'running') continue;
          const value = Number((raw as { value?: unknown }).value ?? 0);
          const max = Number((raw as { max?: unknown }).max ?? 0);
          // With more than one node running — a subgraph, or a node that fans
          // out — the one carrying a real step count is the one worth
          // reporting; ties fall to the last, which is the deepest.
          if (!running || max > 1 || running.max <= 1) running = { id, value, max };
        }

        if (!running) break;
        this.emitExecuting(promptId, running.id);
        // `max: 1` is a node that simply runs and finishes (a loader, a text
        // encode); only a real counter is progress.
        if (running.max > 1 && Number.isFinite(running.value)) {
          this.emitProgress(promptId, { value: running.value, max: running.max, node: running.id });
        }
        break;
      }

      case 'execution_error': {
        const message =
          typeof data['exception_message'] === 'string'
            ? `${data['node_type'] ?? 'A node'} failed: ${data['exception_message']}`
            : 'The backend reported an execution error.';
        if (promptId) this.handlers.onError?.(promptId, message);
        if (this.currentPrompt === promptId) this.currentPrompt = null;
        break;
      }

      default:
        // status, execution_cached, execution_success and anything ComfyUI adds
        // later. Ignoring unknown frames is deliberate: this socket is a
        // convenience and /history is the authority.
        break;
    }
  }

  /** Announce the executing node once, however many frame types said so. */
  private emitExecuting(promptId: string, node: string | null): void {
    const key = `${promptId}:${node ?? 'null'}`;
    if (this.lastExecutingKey === key) return;
    this.lastExecutingKey = key;
    // A new node means the previous node's counter is spent; forgetting it
    // keeps two nodes that both report "1 of 20" from cancelling each other.
    this.lastProgressKey = null;
    this.handlers.onExecuting?.(promptId, node);
  }

  /** Announce a step once, whether it arrived as `progress` or in a state. */
  private emitProgress(promptId: string, progress: ComfyProgress): void {
    const key = `${promptId}:${progress.node ?? ''}:${progress.value}/${progress.max}`;
    if (this.lastProgressKey === key) return;
    this.lastProgressKey = key;
    this.handlers.onProgress?.(promptId, progress);
  }

  /**
   * Binary frames are live previews. The payload is a 4-byte event type and a
   * 4-byte image format, then the image bytes — format 1 is JPEG, 2 is PNG.
   */
  private handleBinary(buffer: Buffer): void {
    if (buffer.length < 8 || !this.currentPrompt) return;

    const format = buffer.readUInt32BE(4);
    const mimeType = format === 2 ? 'image/png' : 'image/jpeg';
    this.handlers.onPreview?.(this.currentPrompt, buffer.subarray(8), mimeType);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
