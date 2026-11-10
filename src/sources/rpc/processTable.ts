import * as fs from 'node:fs';

/** One process as seen in /proc. Only cmdline + stat are ever read (never environ). */
export interface ProcInfo {
  pid: number;
  ppid: number;
  args: string[];
}

export interface ProcessTable {
  list(): ProcInfo[];
}

export interface ProcFs {
  readdir(dir: string): string[];
  readFile(file: string): string;
}

const realProcFs: ProcFs = {
  readdir: (d) => fs.readdirSync(d),
  readFile: (f) => fs.readFileSync(f, 'latin1'),
};

/** `/proc/<pid>/cmdline` is NUL-separated. */
export function parseCmdline(raw: string): string[] {
  return raw.split('\0').filter((a) => a !== '');
}

/** ppid from `/proc/<pid>/stat`: "pid (comm) S ppid ..." (comm may contain spaces/parens). */
export function parsePpid(stat: string): number | null {
  const i = stat.lastIndexOf(')');
  if (i < 0) return null;
  const n = Number(stat.slice(i + 2).split(' ')[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Reads /proc. Prefilters to processes whose cmdline mentions `csrf_token`, so stat is only read
 * for language-server candidates. Unreadable entries (races, permissions) are skipped.
 */
export function readProcTable(procFs: ProcFs = realProcFs, root = '/proc'): ProcessTable {
  return {
    list() {
      const out: ProcInfo[] = [];
      let names: string[];
      try { names = procFs.readdir(root); } catch { return out; }
      for (const n of names) {
        if (!/^\d+$/.test(n)) continue;
        try {
          const raw = procFs.readFile(`${root}/${n}/cmdline`);
          if (!raw.includes('csrf_token')) continue;
          const ppid = parsePpid(procFs.readFile(`${root}/${n}/stat`));
          if (ppid === null) continue;
          out.push({ pid: Number(n), ppid, args: parseCmdline(raw) });
        } catch { /* process vanished or unreadable */ }
      }
      return out;
    },
  };
}

/** A located language server. Never serialises its token (toJSON/inspect/toString omit it). */
export class ServerHandle {
  readonly pid: number;
  readonly port: number;
  private readonly secret: string;
  constructor(pid: number, port: number, token: string) {
    this.pid = pid;
    this.port = port;
    this.secret = token;
  }
  token(): string { return this.secret; }
  sameAs(o: ServerHandle | null): boolean { return !!o && o.pid === this.pid && o.port === this.port; }
  toJSON(): { pid: number; port: number } { return { pid: this.pid, port: this.port }; }
  toString(): string { return `server(pid=${this.pid}, port=${this.port})`; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return this.toString(); }
}

/** All values of `--name=v` or `--name v` (separate arg). */
export function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) out.push(next);
    } else if (a.startsWith(name + '=')) out.push(a.slice(name.length + 1));
  }
  return out;
}

export function flagValue(args: string[], name: string): string | undefined {
  return flagValues(args, name)[0];
}

const APP_DATA_DIRS = new Set(['antigravity', 'antigravity-ide']);

interface Candidate { proc: ProcInfo; port: number; token: string }

function candidateOf(p: ProcInfo): Candidate | null {
  const bin = (p.args[0] ?? '').split('/').pop();
  if (bin !== 'agy') return null;
  const token = flagValue(p.args, '--csrf_token');
  const portStr = flagValue(p.args, '--hub-port') ?? flagValue(p.args, '--extension_server_port');
  const appDir = flagValue(p.args, '--app_data_dir');
  if (!token || !portStr || !appDir || !APP_DATA_DIRS.has(appDir)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { proc: p, port, token };
}

export interface SelectInput {
  hostPid: number;
  hostPpid: number;
  /** Workspace folder fs paths of this window. */
  workspaceFolders: string[];
}

const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s);

/**
 * This window's server: parent PID = extension host (or its parent); fallback `--add-dir` equals a
 * workspace folder. Orphans (ppid 1) are always skipped. Several matches => newest (highest pid).
 */
export function selectServer(procs: ProcInfo[], inp: SelectInput): ServerHandle | null {
  const cands = procs.map(candidateOf).filter((c): c is Candidate => c !== null).filter((c) => c.proc.ppid !== 1);
  const newest = (xs: Candidate[]) => xs.sort((a, b) => b.proc.pid - a.proc.pid)[0];
  let pick = newest(cands.filter((c) => c.proc.ppid === inp.hostPid || c.proc.ppid === inp.hostPpid));
  if (!pick) {
    const folders = new Set(inp.workspaceFolders.map(trimSlash));
    pick = newest(cands.filter((c) => flagValues(c.proc.args, '--add-dir').some((d) => folders.has(trimSlash(d)))));
  }
  return pick ? new ServerHandle(pick.proc.pid, pick.port, pick.token) : null;
}
