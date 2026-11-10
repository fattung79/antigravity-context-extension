export type LogLevel = 'off' | 'error' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

// UUID-like value after csrf_token= / X-Codeium-Csrf-Token (header or flag form).
export const CSRF_SHAPE = /(csrf[_-]?token(?:["']?\s*[=:]\s*["']?))[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Account-like fields (name, email, plan, tier) as key=value / "key": "value" pairs.
const ACCOUNT_FIELD = /((?:user|account)[_-]?name|e-?mail|plan(?:[_-]?(?:name|type|tier))?|tier)("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

let knownToken: string | undefined;

/** Register this window's live CSRF token (memory only) so it is masked verbatim. */
export function setKnownToken(token: string | undefined): void {
  knownToken = token && token.length >= 8 ? token : undefined;
}

export function getKnownToken(): string | undefined {
  return knownToken;
}

export function redact(line: string, token: string | undefined = knownToken): string {
  let out = line;
  if (token) out = out.split(token).join('‹redacted›');
  out = out.replace(CSRF_SHAPE, '$1‹redacted›');
  out = out.replace(EMAIL, '‹redacted›');
  out = out.replace(ACCOUNT_FIELD, '$1$2‹redacted›');
  return out;
}

export interface LogSink {
  appendLine(line: string): void;
}

export class Logger {
  constructor(private sink: LogSink, private level: LogLevel = 'error', private now: () => Date = () => new Date()) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: Exclude<LogLevel, 'off'>, msg: string): void {
    if (RANK[level] > RANK[this.level]) return;
    this.sink.appendLine(redact(`${this.now().toISOString()} [${level}] ${msg}`));
  }

  error(msg: string): void { this.log('error', msg); }
  info(msg: string): void { this.log('info', msg); }
  debug(msg: string): void { this.log('debug', msg); }
}

export const nullLogger = new Logger({ appendLine: () => undefined }, 'off');
