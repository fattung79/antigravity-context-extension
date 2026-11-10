import * as http from 'node:http';
import { realClock, type Clock } from './clock';
import type { ServerHandle } from './processTable';

/** Hard allowlist (spec 9.1): read-only Get* methods only. The token also authorises write methods. */
export const ALLOWED_METHODS: readonly string[] = Object.freeze([
  'GetCascadeTrajectoryGeneratorMetadata',
  'GetAllCascadeTrajectories',
  'GetTokenBase',
]);

export const SERVICE_PATH = '/exa.language_server_pb.LanguageServerService/';
const HOST = '127.0.0.1'; // loopback only (spec 9.6)

export type RpcErrorKind = 'auth' | 'connection' | 'http' | 'shape' | 'forbidden';

/** Messages never contain the token, headers, request or reply bodies. */
export class RpcError extends Error {
  constructor(readonly kind: RpcErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface HttpRequest {
  host: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export interface HttpResponse { status: number; text: string }
/** Injected transport; rejects on connection failure/timeout. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const httpTransport: Transport = (req) => new Promise((resolve, reject) => {
  const r = http.request(
    {
      host: req.host, port: req.port, path: req.path, method: 'POST', timeout: 20000,
      headers: { ...req.headers, 'Content-Length': Buffer.byteLength(req.body) },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => reject(e));
    },
  );
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', (e) => reject(e));
  r.end(req.body);
});

/** Single chokepoint: every RPC goes through `call`. */
export class RpcClient {
  constructor(
    private server: ServerHandle,
    private transport: Transport = httpTransport,
    private clock: Clock = realClock,
    private debug: (msg: string) => void = () => undefined,
  ) {}

  async call(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_METHODS.includes(method)) throw new RpcError('forbidden', `method not allowed: ${String(method).slice(0, 60)}`);
    const t0 = this.clock.now();
    let res: HttpResponse;
    try {
      res = await this.transport({
        host: HOST,
        port: this.server.port,
        path: SERVICE_PATH + method,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': this.server.token(),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new RpcError('connection', `connection failed: ${(e as { code?: string }).code ?? 'error'}`);
    }
    if (res.status === 401 || res.status === 403) throw new RpcError('auth', `HTTP ${res.status}`, res.status);
    if (res.status < 200 || res.status >= 300) throw new RpcError('http', `HTTP ${res.status} for ${method}`, res.status);
    this.debug(`rpc ${method}: ${res.text.length} bytes in ${this.clock.now() - t0} ms`);
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new RpcError('shape', `${method}: reply is not JSON`);
    }
  }
}
