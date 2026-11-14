# Cumulative CPU seconds of a Grab-it process, the WebKit helpers started
# after it (WebContent, GPU) and WindowServer. Usage: cpu.py <pid>
import subprocess,sys,datetime
pid=int(sys.argv[1])
out=subprocess.run(["ps","-axo","pid=,lstart=,time=,comm="],capture_output=True,text=True).stdout.splitlines()
def secs(t):
    parts=t.replace("-",":").split(":"); v=0
    for x in parts: v=v*60+float(x)
    return v
rows=[]
for l in out:
    f=l.split()
    p=int(f[0]); start=datetime.datetime.strptime(" ".join(f[1:6]),"%a %b %d %H:%M:%S %Y"); t=secs(f[6]); comm=" ".join(f[7:])
    rows.append((p,start,t,comm))
me=[r for r in rows if r[0]==pid][0]
app=me[2]; wc=gpu=ws=0
for p,st,t,c in rows:
    if st>=me[1] and "WebKit.WebContent" in c: wc+=t
    if st>=me[1] and "WebKit.GPU" in c: gpu+=t
    if c.endswith("WindowServer"): ws+=t
print(app,wc,gpu,ws)
