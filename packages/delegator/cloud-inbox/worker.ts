// The Cloud Inbox Worker: routes /install, /callback, /status and /disconnect to the one
// Durable Object, which holds the Delegator app's Linear install, token and shared job
// queue. /webhook and the Runner API are handled in routes.ts.

import { DurableObject } from 'cloudflare:workers';
import type { LaunchEvidence } from '../job.ts';
import { AppAuth, isAdmin, readConfig, type InstallResult } from './auth.ts';
import { JobQueue, type AgentEvent, type Outcome, type UpdateType } from './queue.ts';
import { BASE_PATH, handleRunner, handleWebhook, log, text, underBasePath, type Inbox } from './routes.ts';

interface Env {
  MACHINE: DurableObjectNamespace<Machine>;
  LINEAR_ORG_ID?: string;
  ADMIN_SECRET?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  MACHINES?: string;
}

/**
 * The one Durable Object's name. Not a valid machine name, so it never reaches the
 * storage of a per-machine object from before the shared queue; that storage is unused.
 */
const INBOX = 'Delegator';

const FAILURES: Record<Extract<InstallResult, { ok: false }>['reason'], string> = {
  state: 'Install failed: the link is invalid, used or expired. Start again from /install.',
  reinstall: 'Install failed: Delegator is already installed. Reinstall with the admin secret.',
  superseded: 'Install failed: another install finished first. Start again from /install.',
  exchange: 'Install failed: Linear did not complete the token exchange.',
  org: 'Install failed: the app was installed in the wrong workspace.',
};

export default {
  async fetch(incoming, env): Promise<Response> {
    const request = underBasePath(incoming);
    if (!request) return text(404, 'Not found');
    const config = readConfig({ ...env });
    if (typeof config === 'string') {
      log({ event: 'config', outcome: config });
      return text(503, 'Cloud Inbox is not configured');
    }

    const url = new URL(request.url);
    const [, route, ...rest] = url.pathname.split('/');
    const stub = env.MACHINE.get(env.MACHINE.idFromName(INBOX));
    const inbox: Inbox = {
      webhook: (event) => stub.webhook(event),
      claim: (machine) => stub.claim(machine),
      finish: (machine, id, claimId, outcome, launch) => stub.finish(machine, id, claimId, outcome, launch),
      task: (machine, id, claimId) => stub.task(machine, id, claimId),
      update: (machine, id, claimId, type, body) => stub.update(machine, id, claimId, type, body),
      watch: (machine, id, claimId) => stub.watch(machine, id, claimId),
      watching: (machine) => stub.watching(machine),
      linkPullRequest: (machine, id, claimId) => stub.linkPullRequest(machine, id, claimId),
    };
    if (url.pathname === '/webhook' && request.method === 'POST') return handleWebhook(request, config, inbox);
    if (route === 'jobs') return handleRunner(request, config, inbox);

    if (!rest.length && ((route === 'status' && request.method === 'GET') || (route === 'disconnect' && request.method === 'POST'))) {
      if (!isAdmin(request, config.adminSecret)) return text(401, 'Owner authentication required.');
      try {
        if (route === 'status') return Response.json(await stub.status(), { headers: { 'Cache-Control': 'no-store' } });
        await stub.disconnect();
        return text(200, 'Disconnected; Linear access and refresh are revoked. Stored jobs are preserved.');
      } catch {
        return text(502, route === 'status'
          ? 'Linear access could not be verified. Check workspace and app access, then reconnect.'
          : 'Revocation could not be confirmed. Access is blocked locally; retry disconnect or revoke the app in Linear.');
      }
    }

    if (request.method !== 'GET' || rest.length || (route !== 'install' && route !== 'callback')) return text(404, 'Not found');

    const redirectUri = `${url.origin}${BASE_PATH}/callback`;

    if (route === 'install') {
      const location = await stub.startInstall(redirectUri, isAdmin(request, config.adminSecret));
      if (!location) {
        log({ event: 'install', outcome: 'unauthorized' });
        return text(401, 'Installation requires the admin secret.', { 'WWW-Authenticate': 'Basic realm="cloud-inbox"' });
      }
      return Response.redirect(location, 302);
    }

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) {
      log({ event: 'install', outcome: 'denied' });
      return text(400, 'Install failed: Linear returned no code.');
    }
    const result = await stub.completeInstall(state, code, redirectUri);
    log({ event: 'install', outcome: result.ok ? 'installed' : result.reason });
    return result.ok ? text(200, 'Installed Delegator. Cloud Inbox holds the Linear credentials.') : text(400, FAILURES[result.reason]);
  },
} satisfies ExportedHandler<Env>;

/**
 * The one Durable Object, holding the Delegator app's token and the shared queue. The
 * only place the token is refreshed. Its class keeps the name from per-machine days, so
 * no Wrangler migration is needed.
 */
export class Machine extends DurableObject<Env> {
  #auth?: AppAuth;
  #queue?: JobQueue;

  get #app(): AppAuth {
    const config = readConfig({ ...this.env });
    if (typeof config === 'string') throw new Error('Cloud Inbox is not configured');
    return (this.#auth ??= new AppAuth(this.ctx.storage, config.app, config.orgId));
  }

  get #jobs(): JobQueue {
    return (this.#queue ??= new JobQueue(this.ctx.storage.sql, this.#app, (at) => void this.ctx.storage.setAlarm(at)));
  }

  startInstall(redirectUri: string, admin: boolean) { return this.#app.startInstall(redirectUri, admin); }

  completeInstall(state: string, code: string, redirectUri: string) { return this.#app.completeInstall(state, code, redirectUri); }

  status() { return this.#app.status(); }

  disconnect() { return this.#app.disconnect(); }

  /** Delivers the outbox. Fires right after a queue change and again for each retry. */
  async alarm() { await this.#jobs.deliver(); }

  webhook(event: AgentEvent) { return this.#jobs.webhook(event); }

  claim(machine: string) { return this.#jobs.claim(machine); }

  finish(machine: string, id: string, claimId: string, outcome: Outcome, launch?: LaunchEvidence) {
    return this.#jobs.finish(machine, id, claimId, outcome, launch);
  }

  task(machine: string, id: string, claimId: string) { return this.#jobs.task(machine, id, claimId); }

  update(machine: string, id: string, claimId: string, type: UpdateType, body: string) {
    return this.#jobs.update(machine, id, claimId, type, body);
  }

  watch(machine: string, id: string, claimId: string) { return this.#jobs.watch(machine, id, claimId); }

  watching(machine: string) { return this.#jobs.watching(machine); }

  linkPullRequest(machine: string, id: string, claimId: string) { return this.#jobs.linkPullRequest(machine, id, claimId); }
}
