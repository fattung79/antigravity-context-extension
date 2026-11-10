import { setKnownToken } from '../../logger';
import { RpcClient, type Transport, httpTransport } from './client';
import type { Clock } from './clock';
import { realClock } from './clock';
import { selectServer, type ProcessTable, type ServerHandle } from './processTable';
import { Recovery } from './recovery';

export interface RpcManagerDeps {
  procs: ProcessTable;
  transport?: Transport;
  clock?: Clock;
  hostPid: number;
  hostPpid: number;
  workspaceFolders: () => string[];
  info: (msg: string) => void;
  debug: (msg: string) => void;
  /** Called when a lookup succeeds again after a failure. */
  onRecovered: () => void;
}

/** Owns the located server, the client and the recovery schedule. `up` = rpc mode, else file. */
export class RpcManager {
  private server: ServerHandle | null = null;
  private client: RpcClient | null = null;
  private recovery: Recovery;
  private clock: Clock;

  constructor(private d: RpcManagerDeps) {
    this.clock = d.clock ?? realClock;
    this.recovery = new Recovery(this.clock, () => this.lookup(), () => {
      this.d.info('rpc: server found again, switching to rpc');
      this.d.onRecovered();
    });
  }

  get up(): boolean { return this.client !== null; }

  /** Find this window's server. Never throws. */
  lookup(avoid?: ServerHandle | null): boolean {
    let found: ServerHandle | null = null;
    try {
      found = selectServer(this.d.procs.list(), {
        hostPid: this.d.hostPid, hostPpid: this.d.hostPpid, workspaceFolders: this.d.workspaceFolders(),
      });
    } catch { found = null; }
    if (found && avoid && found.sameAs(avoid)) found = null; // same stale server again
    if (!found) {
      this.server = null;
      this.client = null;
      return false;
    }
    setKnownToken(found.token()); // memory-only masking in logs
    this.server = found;
    this.client = new RpcClient(found, this.d.transport ?? httpTransport, this.clock, this.d.debug);
    return true;
  }

  /** Activation: look up once; start the retry schedule on failure. */
  start(): void {
    if (this.lookup()) this.d.info(`rpc: using ${this.server}`);
    else { this.d.info('rpc: no server found, using file source'); this.recovery.start(); }
  }

  /** Connection failure / 401 / 403 / stale server: everything falls back to file; retry lookup. */
  fail(reason: string): void {
    const old = this.server;
    this.d.info(`rpc: ${reason}; switching to file`);
    this.client = null;
    this.server = null;
    // Look up again at once; the server that just failed/went stale is not picked again (no tight loop).
    if (this.lookup(old)) {
      this.d.info(`rpc: using ${this.server}`);
      this.d.onRecovered();
      return;
    }
    this.recovery.start();
  }

  /** Manual Refresh: retry the lookup now. Returns whether rpc is up. */
  refreshLookup(): boolean {
    if (this.up) return this.lookup() || (this.recovery.start(), false);
    return this.recovery.retryNow();
  }

  call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const c = this.client;
    if (!c) return Promise.reject(new Error('rpc not available'));
    return c.call(method, body);
  }

  dispose(): void { this.recovery.stop(); }
}
