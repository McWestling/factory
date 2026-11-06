// The relay Worker: routes /install/<machine> and /callback/<machine> to that
// machine's Durable Object, which holds its Linear install, token and job queue.
// /webhook and the daemon API are handled in routes.ts.

import { DurableObject } from 'cloudflare:workers';
import { isAdmin, MachineAuth, readConfig, type InstallResult } from './auth.ts';
import { MachineQueue, type AgentEvent, type Outcome } from './queue.ts';
import { BASE_PATH, handleDaemon, handleWebhook, log, text, underBasePath, type Machines } from './routes.ts';

interface Env {
  MACHINE: DurableObjectNamespace<Machine>;
  LINEAR_ORG_ID?: string;
  ADMIN_SECRET?: string;
  MACHINES?: string;
}

const FAILURES: Record<Extract<InstallResult, { ok: false }>['reason'], string> = {
  state: 'Install failed: the link is invalid, used or expired. Start again from /install.',
  reinstall: 'Install failed: this machine is already installed. Reinstall with the admin secret.',
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
      return text(503, 'Relay is not configured');
    }

    const url = new URL(request.url);
    const [, route, machine, ...rest] = url.pathname.split('/');
    const machines: Machines = (name) => {
      const stub = env.MACHINE.get(env.MACHINE.idFromName(name));
      return {
        webhook: (event) => stub.webhook(name, event),
        claim: () => stub.claim(name),
        finish: (id, outcome) => stub.finish(name, id, outcome),
      };
    };
    if (url.pathname === '/webhook' && request.method === 'POST') return handleWebhook(request, config, machines);
    if (route === 'jobs') return handleDaemon(request, config, machines);

    if (request.method !== 'GET' || rest.length || (route !== 'install' && route !== 'callback') ||
      !machine || !Object.hasOwn(config.machines, machine)) return text(404, 'Not found');

    const stub = env.MACHINE.get(env.MACHINE.idFromName(machine));
    const redirectUri = `${url.origin}${BASE_PATH}/callback/${machine}`;

    if (route === 'install') {
      const location = await stub.startInstall(machine, redirectUri, isAdmin(request, config.adminSecret));
      if (!location) {
        log({ event: 'install', machine, outcome: 'unauthorized' });
        return text(401, 'Installation requires the admin secret.', { 'WWW-Authenticate': 'Basic realm="relay"' });
      }
      return Response.redirect(location, 302);
    }

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) {
      log({ event: 'install', machine, outcome: 'denied' });
      return text(400, 'Install failed: Linear returned no code.');
    }
    const result = await stub.completeInstall(machine, state, code, redirectUri);
    log({ event: 'install', machine, outcome: result.ok ? 'installed' : result.reason });
    return result.ok ? text(200, `Installed ${machine}.`) : text(400, FAILURES[result.reason]);
  },
} satisfies ExportedHandler<Env>;

/** One per machine, addressed by the machine name. The only place its token is refreshed. */
export class Machine extends DurableObject<Env> {
  #auth?: MachineAuth;
  #queue?: MachineQueue;

  #for(machine: string): MachineAuth {
    const config = readConfig({ ...this.env });
    if (typeof config === 'string' || !Object.hasOwn(config.machines, machine)) {
      throw new Error('Relay is not configured');
    }
    return (this.#auth ??= new MachineAuth(this.ctx.storage, config.machines[machine]!, config.orgId));
  }

  startInstall(machine: string, redirectUri: string, admin: boolean) {
    return this.#for(machine).startInstall(redirectUri, admin);
  }

  completeInstall(machine: string, state: string, code: string, redirectUri: string) {
    return this.#for(machine).completeInstall(state, code, redirectUri);
  }

  #queueFor(machine: string): MachineQueue {
    // Remembered so the alarm, which gets no arguments, can rebuild the queue.
    if (!this.#queue) this.ctx.storage.kv.put('machine', machine);
    return (this.#queue ??= new MachineQueue(this.ctx.storage.sql, this.#for(machine), machine,
      (at) => void this.ctx.storage.setAlarm(at)));
  }

  /** Delivers the outbox. Fires right after a queue change and again for each retry. */
  async alarm() {
    const machine = this.ctx.storage.kv.get<string>('machine');
    if (machine) await this.#queueFor(machine).deliver();
  }

  webhook(machine: string, event: AgentEvent) {
    return this.#queueFor(machine).webhook(event);
  }

  claim(machine: string) {
    return this.#queueFor(machine).claim();
  }

  finish(machine: string, id: string, outcome: Outcome) {
    return this.#queueFor(machine).finish(id, outcome);
  }

}
