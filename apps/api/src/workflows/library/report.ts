/**
 * One library workflow, judged against one backend.
 *
 * The admin question MODELS_PLAN's status table is built around — "if I import
 * this, what stands in the way?" — broken into the parts that are knowable today
 * without an importer: which of its model files this machine has, which of its
 * node classes it lacks, which nodes it ships switched off, and whether it
 * converts. It deliberately stops short of a single verdict word. "Ready" there
 * means a test job passed, and nothing here runs one, so offering the word would
 * be claiming a check that did not happen.
 *
 * File presence is read off `/object_info` rather than the folder listing
 * routes, for the same reason `folders.ts` does it: the loader's own combo is
 * what the graph will be validated against, so a file that is on disk but not
 * visible to the loader is, for this purpose, missing. A folder no known loader
 * reads — a library workflow can name `audio_encoders/` or `model_patches/` —
 * is `unknown`, never `missing`: we cannot see into it, and saying "missing"
 * would send someone to download a file that may already be there.
 */

import type { LibraryModelFile, LibraryWorkflowReport, Uuid } from '@comfy/shared';
import { comboOptions, type ObjectInfo } from '../../lib/comfy.js';
import { FOLDER_READ_BY } from '../folders.js';
import { convertLibraryWorkflow, nodeSpecsFromObjectInfo } from './convert.js';
import { MODE_ACTIVE, libraryModelsOf, parseLibraryTemplate } from './litegraph.js';

/** Classes the converter handles itself and which never reach `/prompt`. */
const FRONTEND_ONLY = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);

function basename(name: string): string {
  return name.split(/[\\/]/).pop()!.toLowerCase();
}

/** Every filename the backend's loaders for `folder` can see, or null if none of them are there. */
function visibleIn(info: ObjectInfo, folder: string): Set<string> | null {
  let seen: Set<string> | null = null;
  for (const [nodeClass, reads] of Object.entries(FOLDER_READ_BY)) {
    if (reads !== folder) continue;
    const spec = info[nodeClass]?.input;
    if (!spec) continue;
    seen ??= new Set();
    for (const declared of Object.values({ ...(spec.required ?? {}), ...(spec.optional ?? {}) })) {
      for (const option of comboOptions(declared) ?? []) seen.add(basename(option));
    }
  }
  return seen;
}

export function libraryWorkflowReport(params: {
  name: string;
  raw: unknown;
  info: ObjectInfo;
  backend: { id: Uuid; name: string };
}): LibraryWorkflowReport {
  const template = parseLibraryTemplate(params.raw);
  const { info } = params;

  const models: LibraryModelFile[] = libraryModelsOf(template).map((need) => {
    const visible = visibleIn(info, need.folder);
    return {
      filename: need.filename,
      folder: need.folder,
      url: need.url,
      trustedSource: need.trustedSource,
      nodeIds: need.nodeIds,
      status: visible === null ? 'unknown' : visible.has(basename(need.filename)) ? 'present' : 'missing',
    };
  });

  const missingNodeClasses = [
    ...new Set(
      template.nodes
        .filter((node) => node.mode === MODE_ACTIVE && !FRONTEND_ONLY.has(node.type))
        .filter((node) => !template.subgraphIds.includes(node.type))
        .map((node) => node.type)
        .filter((nodeClass) => !info[nodeClass]),
    ),
  ].sort();

  const conversion = convertLibraryWorkflow(template, nodeSpecsFromObjectInfo(info));

  return {
    name: params.name,
    backendId: params.backend.id,
    backendName: params.backend.name,
    models,
    missingNodeClasses,
    inactiveNodes: conversion.inactive,
    converts: conversion.problems.length === 0,
    problems: conversion.problems,
  };
}
