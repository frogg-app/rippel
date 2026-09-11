/**
 * `GET /api/workflows` — which model families can do what.
 *
 * ## Why this exists
 *
 * The Create screen has to answer "can I generate with this checkpoint?" before
 * the user presses anything. The server has always known: the registry indexes
 * every template by `(capability, baseModel)`. It just never said so, and the
 * client filled the gap with a hardcoded mirror of one manifest — SDXL does
 * txt2img — which was wrong about every other family on the box and could only
 * ever rot further. This is that mirror's replacement.
 *
 * ## The shape, and what is deliberately not in it
 *
 * A manifest carries JSON paths into a node graph, node class names, resolution
 * tables and constraint ranges. None of it is sent. PLAN.md's rule is that
 * adding a model family is a template plus a manifest on the server and *no
 * frontend change*, and that rule only holds while the frontend is incapable of
 * seeing a node. So the payload answers the question the client asks and
 * nothing more: per family, which capabilities have a workflow, which template
 * would run, and whether that template is hand-authored or the generic guess.
 *
 * Every answer is resolved through `capabilityOffersFor` -> `findTemplate`,
 * which is the same lookup a dispatch performs. This endpoint therefore cannot
 * drift from what would actually happen; it is a projection of the resolver,
 * not a second description of it.
 *
 * ## Families are listed per alias, already folded
 *
 * A manifest lists every spelling it accepts ("sdxl", "SDXL 1.0", "pony"), and
 * each appears here as its own entry under the registry's own normalisation.
 * The browser then folds `Model.baseModel` the same way and does a plain map
 * lookup — no spelling negotiation, no alias table, in the client.
 *
 * ## Auth and caching
 *
 * `requireAuth`, matching `GET /models`: any signed-in user picking a model
 * needs this, and there is nothing operator-only in it.
 *
 * The registry is built once at import and is immutable for the life of the
 * process, so the body is built once too, at module load, and served with a
 * strong ETag over it plus `private, max-age=300`. A client revalidating gets a
 * 304 with no body; a restart that changed the templates changes the hash and
 * the next revalidation gets the new list. `private` because the response is
 * behind a session and must not sit in a shared proxy cache.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WorkflowCapabilities, WorkflowCapabilityOffer } from '@comfy/shared';
import {
  TEMPLATES,
  capabilityOffersFor,
  findTemplateById,
  knownCapabilities,
  normalizeBaseModel,
} from './registry.js';

/** Attach the human label to what the registry already worked out. */
function describe(offers: ReturnType<typeof capabilityOffersFor>): WorkflowCapabilityOffer[] {
  return offers.map((offer) => ({
    capability: offer.capability,
    templateId: offer.templateId,
    templateLabel: findTemplateById(offer.templateId)?.manifest.label ?? offer.templateId,
    isFallback: offer.isFallback,
  }));
}

/**
 * Build the payload from the registry.
 *
 * Exported for the tests, which assert the properties that matter — that no
 * graph internals appear, and that the answer for a family matches what
 * `findTemplate` would pick — rather than pinning a literal blob.
 */
export function buildWorkflowCapabilities(): WorkflowCapabilities {
  // Every alias any manifest claims, folded, first readable spelling kept as
  // the label. The unknown-family manifests claim no families at all and
  // contribute nothing here; they are reported separately below.
  const labels = new Map<string, string>();
  for (const template of TEMPLATES) {
    for (const baseModel of template.manifest.baseModels) {
      const family = normalizeBaseModel(baseModel);
      if (!family) continue;
      if (!labels.has(family)) labels.set(family, baseModel);
    }
  }

  const families = [...labels.entries()]
    .map(([family, label]) => ({
      family,
      label,
      // Resolved from the alias, through the same lookup a dispatch uses.
      offers: describe(capabilityOffersFor(label)),
    }))
    // A family every template declined would be noise; there are none today,
    // but an alias that only appears on an excluded list would be one.
    .filter((entry) => entry.offers.length > 0)
    .sort((a, b) => a.family.localeCompare(b.family));

  return {
    capabilities: knownCapabilities(),
    families,
    // What a checkpoint with no inferred family gets. Emphatically not the same
    // as "nothing": the generic graph answers for it on purpose.
    unknownFamily: describe(capabilityOffersFor(null)),
  };
}

/** Built once: the registry cannot change without restarting the process. */
const PAYLOAD: WorkflowCapabilities = buildWorkflowCapabilities();
const BODY = JSON.stringify(PAYLOAD);
const ETAG = `"${createHash('sha256').update(BODY).digest('base64url').slice(0, 27)}"`;

export default async function workflowCapabilityRoutes(app: FastifyInstance) {
  app.get('/workflows', { onRequest: [app.requireAuth] }, async (req, reply) => {
    reply.header('cache-control', 'private, max-age=300, must-revalidate');
    reply.header('etag', ETAG);

    // A conditional request costs nothing to answer and the body never changes
    // while the process lives, so this is the common case after first load.
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((tag) => tag.trim() === ETAG)) {
      return reply.code(304).send();
    }

    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.send(BODY);
  });
}
