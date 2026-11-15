#!/usr/bin/env python3
"""Watch one Antigravity Conversation for context compaction. stdlib only, read-only.
Usage: compaction-watch.py [conversation-id-or-prefix]   (default: newest transcript)
Appends one line per new transcript step to docs/research/compaction-watch.log and stdout.
"""
import os, sys, glob, time, shutil, sqlite3, tempfile, json, re, urllib.request

HOME = os.path.expanduser('~/.gemini/antigravity')
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compaction-watch.log')
ALLOW = {'GetCascadeTrajectoryGeneratorMetadata'}  # hard allowlist (Get*/List* only)
KEYWORDS = re.compile(r'summar|checkpoint|compact|truncat', re.I)

# ---- protobuf decode (from gauge-figure-check.py) ----
def rv(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
def parse(b):
    out = {}; i = 0
    try:
        while i < len(b):
            k, i = rv(b, i); f, w = k >> 3, k & 7
            if w == 0: v, i = rv(b, i)
            elif w == 2:
                n, i = rv(b, i); v = b[i:i + n]; i += n
            elif w == 1: v = b[i:i + 8]; i += 8
            elif w == 5: v = b[i:i + 4]; i += 4
            else: return None
            out.setdefault(f, []).append(v)
    except Exception: return None
    return out
def get(b, path):
    for p in path[:-1]:
        m = parse(b)
        if not m or p not in m: return None
        b = m[p][0]
    m = parse(b)
    return m[path[-1]][0] if m and path[-1] in m else None

def gm_info(b):
    """-> dict total, groups{name:tokens}, billed"""
    d = {'total': get(b, [1, 9, 10, 1]), 'limit': get(b, [1, 9, 10, 4]),
         'billed': (get(b, [1, 4, 2]) or 0) + (get(b, [1, 4, 5]) or 0), 'groups': {}}
    t = get(b, [1, 9, 10, 3])
    if isinstance(t, bytes):
        m = parse(t) or {}
        for g in m.get(1, []):
            gm = parse(g) if isinstance(g, bytes) else None
            if gm and 1 in gm and 4 in gm:
                try: d['groups'][gm[1][0].decode('utf8', 'replace')] = gm[4][0]
                except Exception: pass
    return d

def st(p):
    try: s = os.stat(p); return (s.st_mtime_ns, s.st_size)
    except OSError: return None

def read_db(src, tmp):
    d = os.path.join(tmp, 'c.db')
    for ext in ('', '-wal', '-shm'):
        if os.path.exists(src + ext): shutil.copyfile(src + ext, d + ext)
        elif os.path.exists(d + ext): os.remove(d + ext)
    c = sqlite3.connect(f'file:{d}?mode=ro', uri=True)
    try:
        cols = [r[1] for r in c.execute('pragma table_info(gen_metadata)')]
        col = 'data' if 'data' in cols else cols[-1]
        return [bytes(r[0]) for r in c.execute(f'select {col} from gen_metadata order by idx')]
    finally: c.close()

# ---- RPC ----
def find_server(workspace_hint=None):
    """-> (port, token) or None. Token kept in memory only."""
    cands = []
    for p in glob.glob('/proc/[0-9]*/cmdline'):
        try: a = open(p, 'rb').read().split(b'\0')
        except OSError: continue
        a = [x.decode('utf8', 'replace') for x in a]
        tok = port = None; app = None
        for x in a:
            if x.startswith('--csrf_token='): tok = x.split('=', 1)[1]
            m = re.match(r'--(?:hub-port|extension_server_port)[=](\d+)$', x)
            if m: port = int(m.group(1))
            if x.startswith('--app_data_dir='): app = x.split('=', 1)[1]
        if tok and port and app in ('antigravity', 'antigravity-ide'): cands.append((port, tok))
    return cands

def rpc(port, tok, method, body):
    if method not in ALLOW or not re.match(r'^(Get|List)', method): raise ValueError('method not allowed')
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}',
        data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': tok})
    with urllib.request.urlopen(req, timeout=5) as r: return json.loads(r.read())

class Rpc:
    def __init__(self, cid):
        self.cid = cid; self.cands = find_server(); self.ok = None; self.said = False
    def latest(self):
        """-> dict or None. Queries all candidates; keeps the one with most entries (some servers hold a stale 1-entry view)."""
        best = None
        for port, tok in list(self.cands):
            try:
                r = rpc(port, tok, 'GetCascadeTrajectoryGeneratorMetadata', {'cascadeId': self.cid})
            except Exception: continue
            g = r.get('generatorMetadata') or []
            if g and (best is None or len(g) > len(best)): best = g
        if not best: return None
        g = best
        cs = (g[-1].get('chatModel') or {}).get('chatStartMetadata') or {}
        cw = cs.get('contextWindowMetadata') or {}
        return {'est': cw.get('estimatedTokensUsed'), 'max': cw.get('maxContextTokens'),
                'trunc': cw.get('truncationReason') or '', 'ckpt': cs.get('checkpointIndex'), 'n': len(g)}

# ---- main ----
def find_transcript(arg):
    pat = HOME + '/brain/*/.system_generated/logs/transcript_full.jsonl'
    ps = glob.glob(pat)
    if arg: ps = [p for p in ps if p.split('/brain/')[1].startswith(arg)]
    if not ps: sys.exit('no transcript found')
    return max(ps, key=lambda p: os.stat(p).st_mtime)

def main():
    tp = find_transcript(sys.argv[1] if len(sys.argv) > 1 else None)
    cid = tp.split('/brain/')[1].split('/')[0]
    dbp = f'{HOME}/conversations/{cid}.db'
    rp = Rpc(cid)
    tmp = tempfile.mkdtemp(prefix='cwatch_')
    out = open(LOG, 'a')
    def emit(s):
        print(s, flush=True); out.write(s + '\n'); out.flush()
    emit(f'{time.strftime("%H:%M:%S")} START conv={cid[:8]} rpc={"found" if rp.cands else "none (files only)"} db={"yes" if os.path.exists(dbp) else "no"}')
    done = 0; llm_n = 0; prev_idx = None; prev_billed = None; gm = []; sig = None; rpc_cache = None
    try:
        while True:
            s = (st(tp), st(dbp), st(dbp + '-wal'))
            if s != sig:
                sig = s
                try: lines = open(tp, encoding='utf8', errors='replace').read().splitlines()
                except OSError: lines = []
                if len(lines) < done:  # transcript shrank
                    emit(f'{time.strftime("%H:%M:%S")} !! transcript shrank {done}->{len(lines)}'); done = 0; llm_n = 0
                try:
                    if os.path.exists(dbp): gm = read_db(dbp, tmp)
                except Exception as e:
                    emit(f'{time.strftime("%H:%M:%S")} db read err {type(e).__name__}')
                if rp.cands: rpc_cache = rp.latest() or rpc_cache
                new = lines[done:]
                for k, l in enumerate(new):
                    try: d = json.loads(l)
                    except Exception: continue
                    is_last = (done + k == len(lines) - 1)
                    si = d.get('step_index'); typ = d.get('type'); flags = []
                    billed = None; g = None
                    if 'input_tokens' in d:
                        billed = (d.get('input_tokens') or 0) + (d.get('cache_read_tokens') or 0)
                        if llm_n < len(gm): g = gm_info(gm[llm_n])
                        llm_n += 1
                        if prev_billed and billed < prev_billed * 0.95:
                            flags.append(f'billed drop {prev_billed}->{billed}')
                        prev_billed = billed
                    if si is not None and prev_idx is not None and si < prev_idx:
                        flags.append(f'step_index back {prev_idx}->{si}')
                    if si is not None: prev_idx = si
                    txt = str(typ) + ' ' + str(d.get('content') or '')
                    if KEYWORDS.search(txt): flags.append('keyword in step')
                    r = rpc_cache if (is_last and rpc_cache) else None
                    if r:
                        if r['trunc']: flags.append(f'truncationReason={r["trunc"]}')
                        if isinstance(r['ckpt'], int) and r['ckpt'] >= 0: flags.append(f'checkpointIndex={r["ckpt"]}')
                    f = lambda x: '-' if x is None else x
                    parts = [time.strftime('%H:%M:%S'), f'step={f(si)}', f'type={typ}']
                    if billed is not None: parts.append(f'billed={billed}')
                    if g:
                        gr = g['groups']
                        parts.append(f'gm_total={f(g["total"])} sys={f(gr.get("System Prompt"))} tools={f(gr.get("Tools"))} chat={f(gr.get("Chat Messages"))}')
                    if r:
                        parts.append(f'rpc est={f(r["est"])} max={f(r["max"])} trunc={r["trunc"] or "-"} ckpt={f(r["ckpt"])} calls={r["n"]}')
                    line = ' '.join(parts)
                    if flags: line += ' !! ' + '; '.join(flags)
                    emit(line)
                done = len(lines)
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    main()
