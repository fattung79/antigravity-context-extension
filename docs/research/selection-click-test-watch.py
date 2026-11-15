import os,glob,time,shutil,sqlite3,re,json,sys
S=sys.argv[1]; H=os.path.expanduser('~/.gemini/antigravity'); END=time.time()+float(sys.argv[2])
WS=glob.glob('/mnt/c/Users/*/AppData/Roaming/Antigravity IDE/User/workspaceStorage/*/state.vscdb')
def log(*a): print(time.strftime('%H:%M:%S')+'.%03d'%(time.time()%1*1000),*a,flush=True)
def st(p):
    try: s=os.stat(p); return (s.st_mtime_ns,s.st_size)
    except FileNotFoundError: return None
def q(src,sql):
    d=os.path.join(S,'cp',os.path.basename(os.path.dirname(src))[:8]+'_'+os.path.basename(src))
    for ext in ('','-wal','-shm'):
        if os.path.exists(src+ext): shutil.copyfile(src+ext,d+ext)
        elif os.path.exists(d+ext): os.remove(d+ext)
    c=sqlite3.connect(f'file:{d}?mode=ro',uri=True)
    try: return c.execute(sql).fetchall()
    finally: c.close()
seen={}
def changed(k,p):
    v=st(p); o=seen.get(k); seen[k]=v; return o is not None and v!=o, o is None
cols=[r[1] for r in q(H+'/conversation_summaries.db',"pragma table_info(conversation_summaries)")] if os.path.exists(H+'/conversation_summaries.db') else []
log('START summaries cols',cols,'ws dbs',len(WS))
first=True
while time.time()<END:
    for p in glob.glob(H+'/annotations/*.pbtxt'):
        ch,new=changed('A'+p,p)
        if ch or (new and not first):
            t=open(p).read(); m=re.search(r'last_user_view_time:\{seconds:(\d+)',t); ti=re.search(r'title:"([^"]{0,30})',t)
            log('ANNOTATION',os.path.basename(p)[:8],'view=',time.strftime('%H:%M:%S',time.localtime(int(m.group(1)))) if m else None,ti.group(1) if ti else '')
    for p in WS:
        ch,_=changed('W'+p,p)
        if ch:
            try:
                r=q(p,"select value from ItemTable where key='google.google-antigravity'")
                v=json.loads(r[0][0]).get('lastConversationId') if r else None
                log('WORKSPACE',p.split('/')[-2][:8],'lastConversationId=',(v or 'None')[:8])
            except Exception as e: log('WORKSPACE',p.split('/')[-2][:8],'read error',e)
    for p in glob.glob(H+'/brain/*/.system_generated/logs/transcript_full.jsonl'):
        ch,new=changed('T'+p,p)
        if ch or (new and not first):
            log('TRANSCRIPT',p.split('/brain/')[1][:8],'lines=',sum(1 for _ in open(p)))
    for p in glob.glob(H+'/conversations/*.db'):
        a,n1=changed('D'+p,p); b,n2=changed('DW'+p,p+'-wal')
        if a or b or (n1 and not first):
            try: log('GEN_METADATA',os.path.basename(p)[:8],'rows=',q(p,'select count(*) from gen_metadata')[0][0])
            except Exception as e: log('GEN_METADATA',os.path.basename(p)[:8],'err',e)
    sp=H+'/conversation_summaries.db'
    a,_=changed('S',sp); b,_=changed('SW',sp+'-wal')
    if (a or b) and 'status' in cols:
        idc='conversation_id' if 'conversation_id' in cols else cols[0]
        r=q(sp,f"select {idc},status from conversation_summaries order by last_modified_time desc limit 2")
        log('SUMMARIES',[(str(i)[:8],s) for i,s in r])
    first=False; time.sleep(1)
log('END')
