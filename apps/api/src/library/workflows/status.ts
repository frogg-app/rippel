/** Readiness is specific to a backend. Installed files alone never establish
 * Ready: a completed test with output is also required. Size is a lower bound,
 * so reject only when weights alone exceed the entire RAM plus VRAM budget. */
import type { ObjectInfo } from '../../lib/comfy.js';
import { checkGraph } from '../../orchestrator/preflight.js';
import type { ComfyApiGraph, WorkflowManifest } from '../../workflows/types.js';
import type { WorkflowFile } from './manifest.js';

export type LibraryStatus = 'ready' | 'needs-files' | 'too-big' | 'needs-custom-node' | 'cloud-only' | 'not-supported' | 'untested' | 'testing' | 'failed';
export interface WorkflowAssessment {
  status: LibraryStatus; reasons: string[]; missingFiles: WorkflowFile[];
  missingNodes: string[]; downloadBytes: number | null;
}
export function assessWorkflow(input: {
  openSource: boolean; graph: ComfyApiGraph; manifest: WorkflowManifest | null;
  files: WorkflowFile[]; omitted: string[]; info: ObjectInfo;
  memoryBytes?: number; weightBytes?: number;
  testStatus?: 'untested' | 'testing' | 'ready' | 'failed';
}): WorkflowAssessment {
  const checks = checkGraph(input.graph, input.info);
  const missingFiles = input.files.filter((file) => file.paths.some((path) => {
    const [nodeId, , name] = path.split('.');
    return checks.missingFiles.some((missing) => missing.nodeId === nodeId && missing.input === name);
  }));
  const downloadBytes = missingFiles.every((file) => file.sizeBytes !== undefined)
    ? missingFiles.reduce((total, file) => total + file.sizeBytes!, 0) : null;
  const result = (status: LibraryStatus, reasons: string[]): WorkflowAssessment =>
    ({ status, reasons, missingFiles, missingNodes: checks.missingNodeClasses, downloadBytes });
  if (!input.openSource) return result('cloud-only', ['This workflow calls a paid cloud service.']);
  if (checks.missingNodeClasses.length) return result('needs-custom-node', checks.missingNodeClasses.map((name) => `Missing node: ${name}`));
  if (!input.manifest) return result('not-supported', input.omitted.length ? input.omitted : ['Required controls could not be mapped.']);
  const bytes = input.weightBytes ?? (input.files.every((file) => file.sizeBytes !== undefined)
    ? input.files.reduce((total, file) => total + file.sizeBytes!, 0) : undefined);
  if (bytes !== undefined && input.memoryBytes !== undefined && bytes > input.memoryBytes) {
    return result('too-big', ['Model weights alone exceed this backend’s combined RAM and VRAM.']);
  }
  if (checks.missingFiles.length) return result('needs-files', checks.missingFiles.map((file) => `Missing ${file.filename} (${file.nodeClass}).`));
  return result(input.testStatus ?? 'untested', input.testStatus === 'ready' ? [] : ['Run a test and confirm an output before offering this workflow to users.']);
}
