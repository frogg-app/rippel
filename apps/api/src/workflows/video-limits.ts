/** Public ranges intersect every binding of a control: conditioning and the
 * video container must both accept the value the form offers. */
import type { VideoControlRange, WorkflowVideoLimits } from '@comfy/shared';
import type { ParamSource, WorkflowManifest } from './types.js';

export function videoLimitsFor(manifest: WorkflowManifest): WorkflowVideoLimits | null {
  function range(source: ParamSource): VideoControlRange | null {
    const constraints = manifest.inputs.filter((input) => input.source === source)
      .map((input) => input.constraint)
      .filter((c) => c?.kind === 'int' || c?.kind === 'float');
    if (!constraints.length) return null;
    return {
      min: Math.max(...constraints.map((c) => c.min)),
      max: Math.min(...constraints.map((c) => c.max)),
      step: Math.max(...constraints.map((c) => c.kind === 'int' ? c.step ?? 1 : 0.01)),
    };
  }
  const frames = range('frameCount');
  const fps = range('fps');
  return frames && fps
    ? { frames, fps, frameQuantum: manifest.frameQuantum ?? 1, motion: range('motion') }
    : null;
}
