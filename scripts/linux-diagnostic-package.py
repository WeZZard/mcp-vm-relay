#!/usr/bin/env python3
"""Package this pre-recording blocked diagnostic without inventing a video timeline."""
import hashlib, json, pathlib, shutil, sys
root=pathlib.Path(sys.argv[1]).resolve()
output=root/'blocked-review'
if output.exists(): raise RuntimeError('Never overwrite original attempt package')
originals=[]
for path in sorted(root.rglob('*')):
    if path.is_symlink(): raise RuntimeError('Symlink in evidence')
    if path.is_file(): originals.append((path,path.relative_to(root),hashlib.sha256(path.read_bytes()).hexdigest()))
output.mkdir()
for path,relative,expected in originals:
    dest=output/'evidence'/relative
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(path,dest)
    if hashlib.sha256(dest.read_bytes()).hexdigest()!=expected or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise RuntimeError('Original changed during packaging')
cleanup=json.loads((root/'cleanup.json').read_text())
acquire=json.loads((root/'acquire.json').read_text())
assert cleanup['status']=={'active':False} and cleanup['registryRemoved']
assert acquire['vm'] not in cleanup['vms']['vms']
assert not any(x['Name']==acquire['vm'] for x in cleanup['tart'])
steps=[
 {'id':'native-x11','title':'Configure and discover clone-only native X11','expected':'GDM WaylandEnable=false; authenticated full-display X11','observed':'GDM configuration and restart completed; gnome-shell discovery confirmed sessionType=x11, DISPLAY=:0, Xauthority path and 3840x2160 display. No browser or CUA daemon was started.','execution':'completed','supportingEvidence':['evidence/x11-config.json','evidence/display-discovery.json']},
 {'id':'recorder-start','title':'Start original fragmented full-display recording','expected':'Recording active and first-frame clock proven before first UI input','observed':'vm-service exec returned rc=255: admin@192.168.64.7: Permission denied (publickey,password). Stop immediately; recorder start not replayed. No recorded frames exist for this attempt.','execution':'blocked','supportingEvidence':['evidence/audit/00072-harness.json','evidence/audit/00073-exec.json','evidence/error.json']},
 {'id':'display-root-cause','title':'Diagnose desktop capture mismatch','expected':'Before/after root and CUA pixels, server-owned browser.read body, window/daemon environments and recorded overlay intervention','observed':'Not executed because recorder-start authentication failed. Overlay freeze/exclusion remains unproven; no remedy to capture source is justified.','execution':'incomplete','supportingEvidence':['evidence/error.json']},
 {'id':'cleanup','title':'Destroy the one diagnostic VM','expected':'Manager release, absence from vm-service and read-only Tart inventory, registry row removed','observed':'All cleanup checks passed. No second VM acquired; other registered workloads retained.','execution':'completed','supportingEvidence':['evidence/audit/00074-release.json','evidence/cleanup.json']}
]
for step in steps:
    step.update({'recordingId':None,'actionInterval':None,'observationPoint':None,'evidenceScope':'Original command receipts and logs only. No footage or UI claim.','humanReview':'pending'})
data={'formatVersion':1,'recordings':[],'outcomes':{'recording':'not-started','execution':'blocked','rootCause':'unresolved','humanReview':'pending','cleanup':'verified'},'steps':steps,'timeline':'Unavailable: no first frame captured. No recorder-launch-derived timestamps or fabricated per-frame mapping.'}
(output/'walkthrough.json').write_text(json.dumps(data,indent=2))
encoded=json.dumps(data).replace('<','\\u003c')
html='''<!doctype html><meta charset="utf-8"><title>Linux diagnostic — blocked before recording</title><style>body{font:16px system-ui;max-width:1100px;margin:30px auto;color:#123}main{display:grid;grid-template-columns:1fr 1fr;gap:25px}article{padding:18px;margin:15px 0;border:1px solid #ccd}.blocked,.incomplete{background:#fff1ed}.current{outline:3px solid #178}button{padding:9px}p{line-height:1.5}#media{padding:25px;background:#eee;height:200px;position:sticky;top:20px}</style><h1>Linux display diagnostic: blocked</h1><p>Recording: not started · Execution: blocked · Root cause: unresolved · Cleanup: verified · Human review: pending</p><p><a href="manifest.json">Original checksums</a> · <a href="walkthrough.json">Structured steps</a></p><main><section id="media"><h2>No recording was produced</h2><p>Recorder start was refused by guest authentication before the first UI input. There is no media timeline to seek or synchronize. These are command/log observations, not a visual walkthrough.</p></section><section><button id="prev">Previous</button> <button id="next">Next</button><div id="steps"></div></section></main><script>const data=DATA;let current=0;const cards=[];function choose(i){current=Math.max(0,Math.min(i,data.steps.length-1));cards.forEach((c,n)=>c.classList.toggle('current',n===current));history.replaceState(null,'','#step-'+data.steps[current].id)}data.steps.forEach((s,i)=>{const a=document.createElement('article');a.className=s.execution;a.id='step-'+s.id;const b=document.createElement('button');b.textContent=s.title;b.onclick=()=>choose(i);a.append(b);for(const text of ['Expected: '+s.expected,'Observed: '+s.observed,'Execution: '+s.execution,s.evidenceScope]){const p=document.createElement('p');p.textContent=text;a.append(p)}for(const path of s.supportingEvidence){const p=document.createElement('p'),l=document.createElement('a');l.href=path;l.textContent=path;p.append(l);a.append(p)}const l=document.createElement('a');l.href='#step-'+s.id;l.textContent='Stable step link';l.onclick=e=>{e.preventDefault();choose(i)};a.append(l);document.querySelector('#steps').append(a);cards.push(a)});document.querySelector('#prev').onclick=()=>choose(current-1);document.querySelector('#next').onclick=()=>choose(current+1);const selected=data.steps.findIndex(s=>'#step-'+s.id===location.hash);choose(selected<0?0:selected);</script>'''.replace('DATA',encoded)
(output/'index.html').write_text(html)
(output/'OPENING.txt').write_text('Open index.html directly. All original audit files and checksum inventory are local. No video exists: recorder start was authentication-refused. Root cause unresolved. UI inputs were never attempted. Human review pending.\n')
inventory=[]
for path in sorted(output.rglob('*')):
    if path.is_file(): inventory.append({'path':str(path.relative_to(output)),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
manifest={'formatVersion':1,'packageType':'blocked-application-diagnostic','outcomes':data['outcomes'],'recordings':[],'files':inventory,'sourceOriginals':[{'path':'evidence/'+str(relative),'sourceRelativePath':str(relative),'sha256':sha} for _,relative,sha in originals]}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2))
for f in inventory:
    path=output/f['path']
    assert path.stat().st_size==f['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest()==f['sha256']
for s in steps:
    for path in s['supportingEvidence']: assert (output/path).is_file()
print(json.dumps({'output':str(output),'filesVerified':len(inventory),'originalFilesVerified':len(originals),'outcomes':data['outcomes']}))
