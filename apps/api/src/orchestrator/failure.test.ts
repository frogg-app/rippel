/**
 * Real messages, mostly. Every string in the out-of-memory block below is the
 * shape one of the three vendors actually emits, because the value of this
 * module is entirely in whether it recognises the thing that really happens.
 */
import { describe, expect, it } from 'vitest';

import { classifyFailure, isOutOfMemory } from './failure.js';

describe('out of memory', () => {
  const REAL = [
    'KSampler failed: HIP out of memory. Tried to allocate 2.44 GiB. GPU 0 has a total capacity of 15.98 GiB of which 1.02 GiB is free.',
    'KSampler failed: CUDA out of memory. Tried to allocate 20.00 MiB (GPU 0; 15.99 GiB total capacity)',
    'VAEDecode failed: Allocation on device 0 would exceed allowed memory',
    'MPS backend out of memory (MPS allocated: 9.07 GB)',
    'RuntimeError: CUDA error: CUDA_ERROR_OUT_OF_MEMORY',
  ];

  it.each(REAL)('recognises %s', (message) => {
    const failure = classifyFailure(message);
    expect(failure.kind).toBe('out-of-memory');
    expect(failure.outOfMemory).toBe(true);
  });

  it('says something the person who wrote the prompt can act on', () => {
    const failure = classifyFailure(REAL[0]);
    // The allocator's own sentence is true and useless to them.
    expect(failure.summary).not.toContain('GiB');
    expect(failure.steps.join(' ')).toMatch(/shorter|resolution|system memory/i);
  });

  it('keeps the backend’s own words whole', () => {
    expect(classifyFailure(REAL[0]).detail).toBe(REAL[0]);
  });

  it('beats the other rules when the message matches several', () => {
    // An allocator report names the node that was running, and "does not
    // exist" shows up in some torch messages. Order is what protects this.
    const both = 'CUDA out of memory. Tried to allocate 2 GiB; buffer does not exist';
    expect(classifyFailure(both).kind).toBe('out-of-memory');
  });
});

describe('the other kinds', () => {
  it('spots a missing file', () => {
    const failure = classifyFailure(
      "UNETLoader failed: unet_name: 'wan2.2_ti2v_5B_fp16.safetensors' not in []",
    );
    expect(failure.kind).toBe('missing-model');
    expect(failure.outOfMemory).toBe(false);
  });

  it('spots a truncated safetensors file', () => {
    // The box really had one of these: a half-downloaded Hunyuan checkpoint.
    expect(classifyFailure('SafetensorError: header too large').kind).toBe('missing-model');
  });

  it('spots a missing custom node', () => {
    expect(classifyFailure('Node type UnetLoaderGGUF does not exist').kind).toBe('missing-node');
  });

  it('spots a lost backend', () => {
    expect(classifyFailure('fetch failed: ECONNREFUSED 192.168.1.10:8188').kind).toBe(
      'backend-unreachable',
    );
  });

  it('spots a cancellation', () => {
    expect(classifyFailure('Processing interrupted').kind).toBe('cancelled');
  });
});

describe('what it will not pretend to know', () => {
  it('answers unknown rather than guessing', () => {
    const failure = classifyFailure('Something entirely novel happened in a node we ship');
    expect(failure.kind).toBe('unknown');
    expect(failure.steps).toEqual([]);
  });

  it('still carries the message through, because it is all we have', () => {
    const message = 'Something entirely novel happened';
    expect(classifyFailure(message).detail).toBe(message);
  });

  it('handles no message at all without inventing one', () => {
    const failure = classifyFailure(null);
    expect(failure.kind).toBe('unknown');
    expect(failure.detail).toBe('');
    expect(failure.summary).toMatch(/gave no reason/);
  });

  it('does not call an ordinary sampler error an out-of-memory', () => {
    // The expensive false positive: it would teach the ledger a ceiling that
    // does not exist and start warning people off jobs that run fine.
    expect(isOutOfMemory('KSampler failed: expected scalar type Half but found Float')).toBe(
      false,
    );
  });
});
