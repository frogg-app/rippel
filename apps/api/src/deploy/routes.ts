/**
 * Deployment routes.
 *
 * Three audiences, one file, and the split between them is the thing to keep
 * straight while reading:
 *
 *  - **An administrator**, session-authenticated, who registers a machine,
 *    issues it a pairing code, and turns the ComfyUI it ends up with into a
 *    backend.
 *  - **An agent**, authenticated by its deployment's token and nothing else,
 *    which checks in. These routes never touch `requireAdmin`, because the
 *    caller is a machine with no session — the token *is* the credential, which
 *    is why it is 32 random bytes and why the lookup is by token rather than by
 *    an id the request could claim.
 *  - **A machine being paired**, authenticated by nothing at all. It has no
 *    rippel login — that is the entire point — so a one-time code stands in for
 *    one. See `pairing.ts` for why that is safe and what bounds it.
 *
 * The binary download sits outside all three: it is the same file for every
 * machine, carries no credentials, and is served as a plain static asset.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AgentPlatform,
  AgentProbe,
  ComfyState,
  Deployment,
  SshInstallInput,
} from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { env } from '../env.js';
import { pollBackendNow } from '../lib/backend-poller.js';
import { AgentError, agentClient as defaultAgentClient, type AgentClient, type AgentTarget } from './agent-client.js';
import { agentServerUrl, type OriginRequest } from './origin.js';
import {
  AGENT_BINARIES,
  availableBinaries,
  binaryDownloadPath,
  binaryFor,
  findBinary,
  readBinary,
} from './binaries.js';
import {
  CODE_TTL_MS,
  generateCode,
  hashCode,
  hashesMatch,
  issueByDeployment,
  normaliseCode,
  redeemByDeployment,
  redeemByIp,
} from './pairing.js';
import { latestAgentRelease } from './releases.js';
import { installerFor, oneLiner } from './scripts.js';
import { helperFiles } from './sources.js';
import { getRun, startSshInstall, type SshExec } from './ssh.js';

export interface DeployDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

export interface DeployDeps {
  db?: DeployDb;
  agent?: AgentClient;
  /** Injectable so the release panel can be tested without GitHub. */
  fetchImpl?: typeof fetch;
  sshExec?: SshExec;
  pollNow?: (id: string) => Promise<void>;
}

interface DeploymentRow {
  id: string;
  name: string;
  host: string;
  agent_port: number;
  platform: AgentPlatform;
  status: 'pending' | 'online' | 'offline';
  token: string;
  agent_version: string | null;
  comfy: ComfyState | null;
  backend_id: string | null;
  backend_name: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

/** A pairing code row, as the redemption path reads it. */
interface PairingRow {
  deployment_id: string;
  code_hash: string;
  expires_at: Date;
  redeemed_at: Date | null;
}

const SELECT = `SELECT d.id, d.name, d.host, d.agent_port, d.platform, d.status, d.token,
                       d.agent_version, d.comfy, d.backend_id, b.name AS backend_name,
                       d.last_seen_at, d.created_at
                  FROM deployments d
                  LEFT JOIN backends b ON b.id = d.backend_id`;

/**
 * Whether a deployment counts as online *now*.
 *
 * The column records the last thing that happened, which is not the same
 * question: an agent whose machine was unplugged leaves `online` behind it and
 * no event to correct it with. Silence is the signal, so it is read at the
 * moment of asking rather than written by a background poller — one fewer
 * timer, and no window where the table and the truth disagree.
 */
function liveStatus(row: DeploymentRow): Deployment['status'] {
  if (row.status !== 'online') return row.status;
  if (!row.last_seen_at) return 'pending';
  const age = Date.now() - new Date(row.last_seen_at).getTime();
  return age > env.deploy.offlineAfterMs ? 'offline' : 'online';
}

function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    agentPort: row.agent_port,
    platform: row.platform,
    status: liveStatus(row),
    agentVersion: row.agent_version,
    comfy: row.comfy,
    backendId: row.backend_id,
    backendName: row.backend_name,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    token: row.token,
  };
}

function targetOf(row: DeploymentRow): AgentTarget {
  return { host: row.host, agentPort: row.agent_port, token: row.token };
}

/**
 * A host as rippel will dial it: a bare name or address, no scheme, no path.
 *
 * Rejecting a URL here rather than accepting and stripping one is deliberate.
 * Someone who pastes `http://box:8188` has given the ComfyUI address, not the
 * agent's, and silently keeping the host would produce a deployment that never
 * connects for a reason the form had already seen.
 */
export function normaliseHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 255) return null;
  if (/[/\\?#\s@]/.test(text) || text.includes('://')) return null;
  // A bracketed IPv6 literal, a dotted quad, or a hostname.
  if (/^\[[0-9a-fA-F:]+\]$/.test(text)) return text;
  if (!/^[a-zA-Z0-9._:-]+$/.test(text)) return null;
  return text.toLowerCase();
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  host: z.string(),
  agentPort: z.number().int().min(1).max(65535).optional(),
});

const sshSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    host: z.string(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().min(1).max(64),
    password: z.string().max(1024).optional(),
    privateKey: z.string().max(64 * 1024).optional(),
    passphrase: z.string().max(1024).optional(),
    useSudo: z.boolean().optional(),
    agentPort: z.number().int().min(1).max(65535).optional(),
    platform: z.enum(['linux', 'darwin', 'win32']).optional(),
    comfyPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((v) => Boolean(v.password) !== Boolean(v.privateKey), {
    message: 'Give either a password or a private key, not both.',
    path: ['password'],
  });

/** 32 bytes, base64url: long enough that guessing is not a threat model. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function makeDeploymentRoutes(deps: DeployDeps = {}) {
  const db: DeployDb = deps.db ?? { query: defaultQuery, queryOne: defaultQueryOne };
  const agent = deps.agent ?? defaultAgentClient;
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const pollNow = deps.pollNow ?? ((id: string) => pollBackendNow(id));

  /** Map an agent failure onto a status code that means the same thing. */
  function agentFailure(reply: FastifyReply, cause: unknown) {
    if (cause instanceof AgentError) {
      const status = cause.kind === 'unauthorized' ? 502 : cause.kind === 'busy' ? 409 : 502;
      return reply.code(status).send({ error: cause.kind, message: cause.message });
    }
    throw cause;
  }

  return async function deploymentRoutes(app: FastifyInstance) {
    async function load(id: string): Promise<DeploymentRow | null> {
      return db.queryOne<DeploymentRow>(`${SELECT} WHERE d.id = $1`, [id]);
    }

    async function loadOr404(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
      const row = await load(req.params.id);
      if (!row) {
        await reply.code(404).send({ error: 'not_found', message: 'No such deployment.' });
        return null;
      }
      return row;
    }

    // ------------------------------------------------------------ the download

    /**
     * The agent binary.
     *
     * One build per platform, the same bytes for everybody, no authentication.
     * It used to be a per-deployment artefact whose *filename* carried the
     * server address and the token — which meant it could not be cached, could
     * not be mirrored, and stopped working the moment anything renamed it. A
     * machine is paired by a code now, so the file itself is just a file.
     */
    app.get<{ Params: { target: string } }>('/deployments/agent/:target', async (req, reply) => {
      const binary = await findBinary(req.params.target);
      if (!binary) {
        const known = AGENT_BINARIES.map((b) => b.target).join(', ');
        return reply.code(404).send({
          error: 'not_found',
          message: binaryFor(req.params.target)
            ? `This rippel has no ${req.params.target} agent built. Run "npm run build:release -w @comfy/agent" where rippel is installed, or download the agent from its GitHub release instead.`
            : `There is no agent for "${req.params.target}". Known ones: ${known}.`,
        });
      }
      return reply
        .type('application/octet-stream')
        .header('content-length', binary.sizeBytes)
        .header('content-disposition', `attachment; filename="${binary.asset}"`)
        // Safe to cache: this file is identical for every deployment and carries
        // nothing secret. That is the whole benefit of retiring the per-machine
        // build, so it is stated in a header rather than left implied.
        .header('cache-control', 'public, max-age=300')
        .send(readBinary(binary));
    });

    // ------------------------------------------------------------ agent-facing

    /**
     * Whoever is calling, identified by their deployment token.
     *
     * Header only. The token used to be accepted from a query string too,
     * because `curl | bash` fetching a generated installer could not set a
     * header — there is no such script any more, so there is no longer a reason
     * for a long-lived credential to appear in a URL, a proxy log or a browser
     * history.
     */
    async function byToken(req: FastifyRequest): Promise<DeploymentRow | null> {
      const header = req.headers['x-rippel-agent-token'];
      const token = typeof header === 'string' ? header : '';
      if (!token) return null;
      return db.queryOne<DeploymentRow>(`${SELECT} WHERE d.token = $1`, [token]);
    }

    /**
     * The agent checking in.
     *
     * This is also how a deployment learns the address it is actually reachable
     * at. An operator types a hostname into the form; the machine may answer on
     * a different one, or on DHCP, or the form may have been skipped entirely.
     * What the agent says about itself, and the address the request came from,
     * are better evidence than what was typed — so the row is corrected here.
     */
    app.post('/deployments/checkin', async (req, reply) => {
      const row = await byToken(req);
      if (!row) {
        return reply.code(401).send({ error: 'unauthorized', message: 'That token is not a deployment.' });
      }
      const body = (req.body ?? {}) as {
        version?: string;
        platform?: AgentPlatform;
        agentPort?: number;
        comfy?: ComfyState;
      };

      // req.ip is the peer, and trustProxy is on, so behind a proxy this is the
      // forwarded address. A private address is worth adopting; a proxy's own
      // is not, so a host that already resolves is left alone.
      const seenHost = normaliseHost(req.ip) ?? row.host;
      const host = row.host === 'pending' ? seenHost : row.host;

      const updated = await db.queryOne<DeploymentRow>(
        `UPDATE deployments
            SET status = 'online',
                host = $2,
                platform = COALESCE($3, platform),
                agent_port = COALESCE($4, agent_port),
                agent_version = COALESCE($5, agent_version),
                comfy = COALESCE($6::jsonb, comfy),
                last_seen_at = now()
          WHERE id = $1
          RETURNING id`,
        [
          row.id,
          host,
          body.platform ?? null,
          Number.isInteger(body.agentPort) ? body.agentPort : null,
          body.version ?? null,
          body.comfy ? JSON.stringify(body.comfy) : null,
        ],
      );
      return { ok: true, deploymentId: updated?.id ?? row.id };
    });

    // ------------------------------------------------------------ pairing

    /**
     * Redeem a one-time code. No authentication, by necessity.
     *
     * The machine being set up has no rippel login, so the code stands in for
     * one — which makes it a credential, and everything here treats it as one.
     * The order of operations is the security of this route:
     *
     *  1. Rate-limit by address *before* touching the database, so guessing
     *     costs an attacker attempts rather than costing us queries.
     *  2. Reject anything that is not a well-formed code without a lookup.
     *  3. Spend the code with a single conditional UPDATE. That statement is
     *     what makes redemption single-use: `redeemed_at IS NULL` is evaluated
     *     and written in one atomic step, so two agents racing the same code
     *     produce exactly one winner and one loser, decided by Postgres rather
     *     than by a read-then-write this code could get wrong. There is no
     *     transaction here because there is nothing to wrap — atomicity comes
     *     from it being one statement.
     *  4. Only then explain a failure, and count it against the deployment.
     *
     * A code is spent whether or not the agent then succeeds in installing.
     * That is deliberate: the alternative is a code that can be replayed by
     * anyone who watched it fail.
     */
    app.post<{ Body: { code?: unknown } }>('/deployments/pair', async (req, reply) => {
      if (!redeemByIp.take(req.ip)) {
        return reply.code(429).send({
          error: 'rate_limited',
          message: 'Too many pairing attempts from this address. Wait a few minutes and try again.',
        });
      }

      const code = normaliseCode((req.body ?? {}).code);
      if (!code) {
        return reply.code(400).send({
          error: 'invalid_code',
          message:
            'That is not a pairing code. A code is 8 characters, and rippel shows it on the Deployment screen.',
        });
      }
      const codeHash = hashCode(code);

      // One statement, and the only one that may spend a code.
      const spent = await db.queryOne<{ deployment_id: string }>(
        `UPDATE deployment_pairing_codes
            SET redeemed_at = now()
          WHERE code_hash = $1
            AND redeemed_at IS NULL
            AND expires_at > now()
          RETURNING deployment_id`,
        [codeHash],
      );

      if (!spent) {
        // Say why, for whoever is standing at the machine. Telling the holder of
        // a code that it has expired is not a disclosure — they already had it —
        // and "that code is not valid" for every case sends people hunting for
        // typos that are not there. The rate limit above is what keeps this from
        // being an oracle.
        const existing = await db.queryOne<PairingRow>(
          `SELECT deployment_id, code_hash, expires_at, redeemed_at
             FROM deployment_pairing_codes
            WHERE code_hash = $1`,
          [codeHash],
        );
        if (existing && hashesMatch(existing.code_hash, codeHash)) {
          // A real code for a real deployment, so count the attempt against that
          // deployment too — the per-address limit alone does not bound what a
          // spread of addresses can do to one machine's enrolment.
          redeemByDeployment.take(existing.deployment_id);
          if (existing.redeemed_at) {
            return reply.code(409).send({
              error: 'code_used',
              message:
                'That pairing code has already been used. Codes work once — ask rippel for a new one on the Deployment screen.',
            });
          }
          return reply.code(410).send({
            error: 'code_expired',
            message:
              'That pairing code has expired. Codes last a few minutes — ask rippel for a new one on the Deployment screen.',
          });
        }
        return reply.code(404).send({
          error: 'code_unknown',
          message:
            'rippel does not recognise that pairing code. Check it against the Deployment screen, or ask for a new one.',
        });
      }

      const row = await load(spent.deployment_id);
      if (!row) {
        // The deployment was deleted between issuing and redeeming. The code is
        // spent either way, which is the right outcome.
        return reply.code(404).send({
          error: 'not_found',
          message: 'The machine that code was for no longer exists in rippel.',
        });
      }

      // A good pairing should not leave a limiter primed against the person who
      // just succeeded, or against the machine they set up.
      redeemByIp.clear(req.ip);
      redeemByDeployment.clear(row.id);

      // The id comes back from here and is never asked for. `serverUrl` is
      // derived from this very request, so the agent stores the address that
      // demonstrably reached this rippel rather than one an operator typed.
      return {
        deploymentId: row.id,
        token: row.token,
        serverUrl: agentServerUrl(req),
      };
    });

    /**
     * Issue a pairing code for a deployment.
     *
     * A POST because it changes something: the primary key on
     * `deployment_pairing_codes` means issuing replaces whatever code that
     * deployment had, so an outstanding code stops working the moment a new one
     * is asked for. That is the contract's "a code read aloud in a meeting
     * cannot be used tomorrow", enforced by the schema rather than by a delete
     * this route could forget.
     *
     * The plaintext exists only in this response. Only its hash is stored, so
     * nobody — including an administrator looking at the table — can recover a
     * code after the fact; they issue a new one instead.
     */
    app.post<{ Params: { id: string } }>(
      '/deployments/:id/pairing-code',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;

        if (!issueByDeployment.take(row.id)) {
          return reply.code(429).send({
            error: 'rate_limited',
            message: 'That machine has been issued a lot of codes just now. Wait a few minutes.',
          });
        }

        const code = generateCode();
        const expiresAt = new Date(Date.now() + CODE_TTL_MS);

        await db.query(
          `INSERT INTO deployment_pairing_codes (deployment_id, code_hash, expires_at, created_by)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (deployment_id) DO UPDATE
                   SET code_hash = EXCLUDED.code_hash,
                       expires_at = EXCLUDED.expires_at,
                       created_by = EXCLUDED.created_by,
                       redeemed_at = NULL,
                       created_at = now()`,
          [row.id, hashCode(code), expiresAt, req.user!.id],
        );

        const serverUrl = agentServerUrl(req);
        // The commands live with the code rather than on the install route,
        // because a command is only useful while a code is: a copyable line
        // with a dead code in it is worse than no line at all.
        return reply.code(201).send({
          code,
          expiresAt: expiresAt.toISOString(),
          serverUrl,
          commands: {
            linux: oneLiner('linux', { serverUrl, code }),
            darwin: oneLiner('darwin', { serverUrl, code }),
            win32: oneLiner('win32', { serverUrl, code }),
          },
        });
      },
    );

    // ------------------------------------------------------------ admin-facing

    app.get('/deployments', { onRequest: [app.requireAdmin] }, async () => {
      const rows = await db.query<DeploymentRow>(`${SELECT} ORDER BY d.name`);
      return { deployments: rows.map(toDeployment) };
    });

    app.get('/deployments/releases', { onRequest: [app.requireAdmin] }, async () => ({
      release: await latestAgentRelease(fetchImpl),
    }));

    app.post<{ Body: unknown }>('/deployments', { onRequest: [app.requireAdmin] }, async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.code(400).send({
          error: 'invalid_input',
          message: issue?.message ?? 'Check the form.',
          field: issue?.path[0],
        });
      }
      const host = normaliseHost(parsed.data.host);
      if (!host) {
        return reply.code(400).send({
          error: 'invalid_input',
          field: 'host',
          message: 'Enter just the machine’s name or IP address — no http:// and no port.',
        });
      }
      const taken = await db.queryOne<{ id: string }>(
        `SELECT id FROM deployments WHERE lower(name) = lower($1)`,
        [parsed.data.name],
      );
      if (taken) {
        return reply.code(409).send({
          error: 'conflict',
          field: 'name',
          message: `There is already a deployment called "${parsed.data.name}".`,
        });
      }

      const row = await db.queryOne<DeploymentRow>(
        `WITH inserted AS (
           INSERT INTO deployments (name, host, agent_port, token, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *
         )
         SELECT i.id, i.name, i.host, i.agent_port, i.platform, i.status, i.token,
                i.agent_version, i.comfy, i.backend_id, NULL::text AS backend_name,
                i.last_seen_at, i.created_at
           FROM inserted i`,
        [
          parsed.data.name,
          host,
          parsed.data.agentPort ?? env.deploy.agentPort,
          newToken(),
          req.user!.id,
        ],
      );
      return reply.code(201).send({ deployment: toDeployment(row!) });
    });

    app.delete<{ Params: { id: string } }>(
      '/deployments/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        // Any outstanding pairing code goes with it, by ON DELETE CASCADE.
        await db.query(`DELETE FROM deployments WHERE id = $1`, [row.id]);
        // The backend row, if there is one, is left alone on purpose: removing
        // rippel's management of a machine should not stop it generating.
        return reply.code(204).send();
      },
    );

    /**
     * What the Deployment screen needs to describe an install.
     *
     * Deliberately carries no pairing code: this is a GET, it is polled, and a
     * safe request must not mint credentials. Ask `POST /pairing-code` for a
     * code and the commands that go with it.
     */
    app.get<{ Params: { id: string } }>(
      '/deployments/:id/install',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        const serverUrl = agentServerUrl(req);
        const available = await availableBinaries();
        return {
          serverUrl,
          token: row.token,
          /**
           * The generic downloads this rippel can serve right now. One per
           * platform, no deployment in the URL, no token on it — the same file
           * for every machine.
           */
          binaries: available.map((binary) => ({
            target: binary.target,
            platform: binary.platform,
            arch: binary.arch,
            label: binary.label,
            sizeBytes: binary.sizeBytes,
            fileName: binary.asset,
            url: `${serverUrl}${binaryDownloadPath(binary.target)}`,
          })),
          release: await latestAgentRelease(fetchImpl),
        };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/deployments/:id/probe',
      { onRequest: [app.requireAdmin] },
      async (req, reply): Promise<AgentProbe | undefined> => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        const started = Date.now();
        try {
          const result = await agent.ping(targetOf(row));
          await db.query(
            `UPDATE deployments SET status = 'online', platform = $2, agent_version = $3, last_seen_at = now()
              WHERE id = $1`,
            [row.id, result.platform, result.version],
          );
          return {
            ok: true,
            latencyMs: Date.now() - started,
            version: result.version,
            platform: result.platform,
            hostname: result.hostname,
          };
        } catch (cause) {
          await db.query(`UPDATE deployments SET status = 'offline' WHERE id = $1`, [row.id]);
          return {
            ok: false,
            latencyMs: Date.now() - started,
            error: cause instanceof Error ? cause.message : 'The agent did not answer.',
          };
        }
      },
    );

    /** Ask the agent directly, and record what it said. */
    app.get<{ Params: { id: string } }>(
      '/deployments/:id/status',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        try {
          const status = await agent.status(targetOf(row));
          await db.query(
            `UPDATE deployments
                SET status = 'online', platform = $2, agent_version = $3, comfy = $4::jsonb,
                    last_seen_at = now()
              WHERE id = $1`,
            [row.id, status.platform, status.version, JSON.stringify(status.comfy)],
          );
          return { comfy: status.comfy, accelerator: status.accelerator, tasks: status.tasks };
        } catch (cause) {
          await db.query(`UPDATE deployments SET status = 'offline' WHERE id = $1`, [row.id]);
          return agentFailure(reply, cause);
        }
      },
    );

    app.get<{ Params: { id: string; taskId: string }; Querystring: { since?: string } }>(
      '/deployments/:id/tasks/:taskId',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        try {
          return await agent.task(targetOf(row), req.params.taskId, Number(req.query.since ?? 0) || 0);
        } catch (cause) {
          return agentFailure(reply, cause);
        }
      },
    );

    app.post<{ Params: { id: string }; Body: { accelerator?: string } }>(
      '/deployments/:id/comfyui/install',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        const accelerator = req.body?.accelerator ?? 'auto';
        if (!['auto', 'cuda', 'rocm', 'cpu'].includes(accelerator)) {
          return reply.code(400).send({
            error: 'invalid_input',
            field: 'accelerator',
            message: 'Choose auto, cuda, rocm or cpu.',
          });
        }
        try {
          return { task: await agent.installComfy(targetOf(row), accelerator) };
        } catch (cause) {
          return agentFailure(reply, cause);
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      '/deployments/:id/comfyui/update',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        try {
          return { task: await agent.updateComfy(targetOf(row)) };
        } catch (cause) {
          return agentFailure(reply, cause);
        }
      },
    );

    app.post<{ Params: { id: string; action: string } }>(
      '/deployments/:id/comfyui/:action',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        const action = req.params.action;
        if (action !== 'start' && action !== 'stop' && action !== 'restart') {
          return reply.code(404).send({ error: 'not_found', message: `No such action "${action}".` });
        }
        try {
          const result = await agent.power(targetOf(row), action);
          // The backend's status is now stale by definition, so make the poller
          // re-read it rather than leaving the pill wrong for a tick.
          if (row.backend_id) void pollNow(row.backend_id).catch(() => {});
          return { result };
        } catch (cause) {
          return agentFailure(reply, cause);
        }
      },
    );

    /**
     * Put the storage helper on the machine.
     *
     * The token comes from this server's configuration, not from the request:
     * rippel and the helper must share one, and the one rippel will actually
     * present is the one in `COMFY_STORAGE_TOKEN`. Letting a form choose a
     * different one would install a helper rippel cannot talk to.
     */
    app.post<{ Params: { id: string } }>(
      '/deployments/:id/helper/install',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        if (!env.comfyStorageToken) {
          return reply.code(409).send({
            error: 'not_configured',
            message:
              'Set COMFY_STORAGE_TOKEN in rippel’s environment and restart the API. The helper refuses every request without a token, so installing one now would install a helper rippel cannot use.',
          });
        }
        try {
          const files = await helperFiles();
          return { task: await agent.installHelper(targetOf(row), files, env.comfyStorageToken) };
        } catch (cause) {
          return agentFailure(reply, cause);
        }
      },
    );

    /**
     * Register this deployment's ComfyUI as a backend rippel generates on.
     *
     * The address is built from the deployment rather than typed, because the
     * agent has just told us both halves of it and a typo here produces a
     * backend that polls forever.
     */
    app.post<{ Params: { id: string }; Body: { name?: string } }>(
      '/deployments/:id/backend',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const row = await loadOr404(req, reply);
        if (!row) return;
        if (row.backend_id) {
          return reply.code(409).send({
            error: 'conflict',
            message: `${row.name} is already registered as the backend "${row.backend_name}".`,
          });
        }
        const port = row.comfy?.port ?? 8188;
        const baseUrl = `http://${row.host}:${port}`;
        const name = (req.body?.name ?? row.name).trim().slice(0, 60) || row.name;

        const clash = await db.queryOne<{ id: string }>(
          `SELECT id FROM backends WHERE lower(name) = lower($1) OR base_url = $2`,
          [name, baseUrl],
        );
        if (clash) {
          // Adopting rather than refusing: an operator who added the backend by
          // hand before installing the agent should end up with them linked,
          // not with a duplicate they have to reconcile.
          await db.query(`UPDATE deployments SET backend_id = $2 WHERE id = $1`, [row.id, clash.id]);
          void pollNow(clash.id).catch(() => {});
          const linked = await load(row.id);
          return { deployment: toDeployment(linked!), adopted: true };
        }

        const backend = await db.queryOne<{ id: string }>(
          `INSERT INTO backends (name, base_url, enabled) VALUES ($1, $2, true) RETURNING id`,
          [name, baseUrl],
        );
        await db.query(`UPDATE deployments SET backend_id = $2 WHERE id = $1`, [row.id, backend!.id]);
        void pollNow(backend!.id).catch(() => {});
        const linked = await load(row.id);
        return reply.code(201).send({ deployment: toDeployment(linked!), adopted: false });
      },
    );

    // ------------------------------------------------------------ managed SSH

    app.post<{ Body: unknown }>(
      '/deployments/ssh-install',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const parsed = sshSchema.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return reply.code(400).send({
            error: 'invalid_input',
            message: issue?.message ?? 'Check the form.',
            field: issue?.path[0],
          });
        }
        const host = normaliseHost(parsed.data.host);
        if (!host) {
          return reply.code(400).send({
            error: 'invalid_input',
            field: 'host',
            message: 'Enter just the machine’s name or IP address — no http:// and no port.',
          });
        }
        const taken = await db.queryOne<{ id: string }>(
          `SELECT id FROM deployments WHERE lower(name) = lower($1)`,
          [parsed.data.name],
        );
        if (taken) {
          return reply.code(409).send({
            error: 'conflict',
            field: 'name',
            message: `There is already a deployment called "${parsed.data.name}".`,
          });
        }

        // The row exists before the install runs, so a code can be issued for it
        // and so a failed install leaves something to retry against.
        const row = await db.queryOne<DeploymentRow>(
          `WITH inserted AS (
             INSERT INTO deployments (name, host, agent_port, platform, token, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *
           )
           SELECT i.id, i.name, i.host, i.agent_port, i.platform, i.status, i.token,
                  i.agent_version, i.comfy, i.backend_id, NULL::text AS backend_name,
                  i.last_seen_at, i.created_at
             FROM inserted i`,
          [
            parsed.data.name,
            host,
            parsed.data.agentPort ?? env.deploy.agentPort,
            parsed.data.platform ?? 'unknown',
            newToken(),
            req.user!.id,
          ],
        );

        // The managed install pairs exactly the way a person would, with a code
        // that expires — rather than piping a long-lived token over the wire and
        // leaving it in a script. One mechanism, one set of failure modes.
        const code = generateCode();
        await db.query(
          `INSERT INTO deployment_pairing_codes (deployment_id, code_hash, expires_at, created_by)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (deployment_id) DO UPDATE
                   SET code_hash = EXCLUDED.code_hash,
                       expires_at = EXCLUDED.expires_at,
                       created_by = EXCLUDED.created_by,
                       redeemed_at = NULL,
                       created_at = now()`,
          [row!.id, hashCode(code), new Date(Date.now() + CODE_TTL_MS), req.user!.id],
        );

        const platform = (parsed.data.platform ?? 'linux') as AgentPlatform;
        const { body: script } = installerFor(platform, {
          serverUrl: agentServerUrl(req),
          code,
          comfyPort: parsed.data.comfyPort,
        });
        const input: SshInstallInput = { ...parsed.data, host };
        const run = startSshInstall({
          input,
          deploymentId: row!.id,
          script,
          platform: platform === 'win32' ? 'win32' : 'posix',
          exec: deps.sshExec,
        });

        return reply.code(202).send({ run, deployment: toDeployment(row!) });
      },
    );

    app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
      '/deployments/runs/:id',
      { onRequest: [app.requireAdmin] },
      async (req, reply) => {
        const run = getRun(req.params.id);
        if (!run) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'That install is no longer being tracked. Installs are forgotten half an hour after they finish.',
          });
        }
        const since = Number(req.query.since ?? 0) || 0;
        return { run: { ...run, log: run.log.slice(since) }, logOffset: run.log.length };
      },
    );
  };
}

export default makeDeploymentRoutes();
