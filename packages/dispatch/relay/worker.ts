// The relay Worker: routes /install/<machine> and /callback/<machine> to that
// machine's Durable Object, which holds its Linear install and token.

import { DurableObject } from 'cloudflare:workers';
import { isAdmin, MachineAuth, readConfig, type InstallResult } from './auth.ts';

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

// Logs ids and outcomes only: never bodies, headers, tokens or state.
const log = (fields: Record<string, string>) => console.log(JSON.stringify(fields));
const text = (status: number, body: string, headers?: HeadersInit) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

export default {
  async fetch(request, env): Promise<Response> {
    const config = readConfig({ ...env });
    if (typeof config === 'string') {
      log({ event: 'config', outcome: config });
      return text(503, 'Relay is not configured');
    }

    const url = new URL(request.url);
    const [, route, machine, ...rest] = url.pathname.split('/');
    if (request.method !== 'GET' || rest.length || (route !== 'install' && route !== 'callback') ||
      !machine || !Object.hasOwn(config.machines, machine)) return text(404, 'Not found');

    const stub = env.MACHINE.get(env.MACHINE.idFromName(machine));
    const redirectUri = `${url.origin}/callback/${machine}`;

    if (route === 'install') {
      const location = await stub.startInstall(machine, redirectUri, isAdmin(request, config.adminSecret));
      if (!location) {
        log({ event: 'install', machine, outcome: 'reinstall' });
        return text(401, FAILURES.reinstall, { 'WWW-Authenticate': 'Basic realm="relay"' });
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

  /** Internal: for the token endpoint the daemon borrows from. */
  getAccessToken(machine: string) {
    return this.#for(machine).getAccessToken();
  }
}
