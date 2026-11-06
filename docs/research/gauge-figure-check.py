import sqlite3,sys
def rv(b,i):
    r=s=0
    while True:
        x=b[i];i+=1;r|=(x&0x7f)<<s;s+=7
        if x<0x80:return r,i
def parse(b):
    out={};i=0
    try:
        while i<len(b):
            k,i=rv(b,i);f,w=k>>3,k&7
            if w==0:v,i=rv(b,i)
            elif w==2:
                n,i=rv(b,i);v=b[i:i+n];i+=n
            elif w==1:v=b[i:i+8];i+=8
            elif w==5:v=b[i:i+4];i+=4
            else:return None
            out.setdefault(f,[]).append(v)
    except Exception:return None
    return out
def get(b,path):
    for p in path[:-1]:
        m=parse(b)
        if not m or p not in m:return None
        b=m[p][0]
    m=parse(b)
    return m[path[-1]][0] if m and path[-1] in m else None
for db in sys.argv[1:]:
    c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
    cols=[r[1] for r in c.execute("pragma table_info(gen_metadata)")]
    col='data' if 'data' in cols else cols[-1]
    rows=[r[0] for r in c.execute(f"select {col} from gen_metadata order by rowid")]
    print(db.split('/')[-1][:8],len(rows),"rows; columns",cols)
    prev=None;res=[]
    for b in rows:
        est=get(b,[1,9,10,1]);i_=get(b,[1,4,2]) or 0;cr=get(b,[1,4,5]) or 0;o=get(b,[1,4,3]) or 0
        res.append((est,i_+cr,o))
    print(" n   est  billed  out  next_billed  est/billed  est/next")
    for n,(e,bl,o) in enumerate(res):
        nb=res[n+1][1] if n+1<len(res) else None
        if n<6 or n>len(res)-6 or n%10==0:
            print(f"{n:3} {e} {bl:7} {o:5} {nb}  {e/bl if e and bl else '-':.4}  {e/nb if e and nb else '-'}")
