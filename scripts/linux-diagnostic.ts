// Application-only single-clone diagnostic. No source/golden/dependency edits.
import {RelayManager,type RunInput} from '../src/manager.js';
import {VmService,type RequestOptions,type ExecRequest,type TransferRequest} from '../src/vm-service.js';
import {Transfer} from '../src/transfer.js';
import {configureCloneX11,configureGdmText} from './live-smoke-x11.js';
import {readOnlyAuthRetry,type ReadOnlyPurpose} from './live-smoke-readonly.js';
import {mkdir,readFile,writeFile,readdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const project=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]!);
if(!process.argv.includes('--run'))throw Error('Explicit --run required');
await mkdir(join(root,'audit'),{recursive:true});await mkdir(join(root,'requests'),{recursive:true});await mkdir(join(root,'responses'),{recursive:true});
const json=async(n:string,d:unknown)=>writeFile(join(root,n),JSON.stringify(d,null,2));
let sequence=0,lease:any,manager:RelayManager,recorderStarted=false,stopAttempted=false,stopConfirmed=false,stopped=false;
async function audit<T>(kind:string,args:unknown,fn:()=>Promise<T>):Promise<T>{const n=String(sequence++).padStart(5,'0'),at=new Date().toISOString();try{const result=await fn();await json(`audit/${n}-${kind}.json`,{at,finishedAt:new Date().toISOString(),args,result});return result;}catch(e){await json(`audit/${n}-${kind}.json`,{at,finishedAt:new Date().toISOString(),args,error:String(e)});throw e;}}
class AuditVm extends VmService{
 override exec(n:string,b:ExecRequest,o:RequestOptions={}){return audit('exec',{vm:n,request:b},()=>super.exec(n,b,o));}
 override push(n:string,b:TransferRequest,o:RequestOptions={}){return audit('push',{vm:n,request:b},()=>super.push(n,b,o));}
 override pull(n:string,b:TransferRequest,o:RequestOptions={}){return audit('pull',{vm:n,request:b},()=>super.pull(n,b,o));}
 override heartbeat(n:string,b:{ttl_hours?:number}={},o:RequestOptions={}){return audit('heartbeat',{vm:n,request:b},()=>super.heartbeat(n,b,o));}
 override async release(n:string,b:{reason?:string}={},o:RequestOptions={}){
  if(lease&&recorderStarted){let source=lease.workspace+'/walkthrough';const retention:any[]=[];let available=true;
   try{await stopRecorder();}catch(e){retention.push({phase:'stop',error:String(e),recording:'incomplete; no stop replay'});source=lease.guestRoot+'/application-frozen-walkthrough';
    try{await command(['node','-e',`const fs=require('fs'),crypto=require('crypto'),path=require('path'),src=${JSON.stringify(lease.workspace+'/walkthrough')},dst=${JSON.stringify(source)};fs.mkdirSync(dst);const observations=[];for(const e of fs.readdirSync(src,{withFileTypes:true})){if(!e.isFile())throw Error('Nonregular application evidence');const p=path.join(src,e.name),before=fs.statSync(p),bytes=fs.readFileSync(p);fs.writeFileSync(path.join(dst,e.name),bytes);const fd=fs.openSync(p,'r'),prefix=Buffer.alloc(bytes.length);let count=0;while(count<prefix.length){const n=fs.readSync(fd,prefix,count,prefix.length-count,count);if(!n)break;count+=n;}fs.closeSync(fd);observations.push({path:e.name,bytes:bytes.length,prefixMatchesSource:count===bytes.length&&bytes.equals(prefix),sourceSizeBefore:before.size,sourceSizeAfter:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}fs.writeFileSync(path.join(dst,'interrupted-copy.json'),JSON.stringify({recording:'interrupted; raw source byte copies, not finalized media',observations},null,2));console.log(JSON.stringify({source:src,destination:dst,observations}));`],'Freeze raw fragmented original after unconfirmed stop; do not replay stop',120);}catch(copyError){available=false;retention.push({phase:'freeze',error:String(copyError)});}}
   if(available)for(let attempt=0;attempt<3;attempt++){try{const files=await transfer().pullVerified(source,join(root,`walkthrough-retained-${attempt}`));retention.push({attempt,source,files});break;}catch(e){retention.push({attempt,error:String(e)});}}
   await json('application-retention.json',retention);
  }
  return audit('release',{vm:n,request:b},()=>super.release(n,b,o));
 }
}
const vm=new AuditVm();manager=new RelayManager({sessionId:`linux-diagnostic-${Date.now()}`,project,vm,stateRoot:join(root,'state'),outputRoot:join(root,'packages'),heartbeatMs:10000});
const transfer=()=>new Transfer(manager.channel,lease.vm,'node',{guestRoot:lease.guestRoot,hostTempRoot:join(root,'transfer-temp'),onRetry:e=>audit('transfer-retry',{because:'Byte-copy retry only; no input',...e},async()=>true).then(()=>{})});
async function command(argv:string[],because:string,timeout=120,readOnly?:ReadOnlyPurpose){return audit('harness',{argv,because,readOnly},async()=>{const r=await readOnlyAuthRetry(()=>vm.exec(lease.vm,{argv,timeout}),readOnly,e=>audit('readonly-auth-refusal',{because,...e},async()=>true).then(()=>{}));if(r.rc!==0)throw Error(`Harness rc=${r.rc}: ${r.output}`);return r.output;});}
const helper=(op:string)=>command(['node',lease.guestRoot+'/support/harness.cjs',op],`Application recorder ${op}`,120,op==='guard'?'recorder-guard':undefined);
async function stopRecorder(){if(!stopped&&recorderStarted){if(!stopAttempted){stopAttempted=true;await helper('stop');stopConfirmed=true;}if(!stopConfirmed)throw Error('Recorder stop uncertain/refused; no replay');await new Promise(r=>setTimeout(r,1500));const result=await command(['ffprobe','-v','error','-show_format','-show_streams','-of','json',lease.workspace+'/walkthrough/original.mp4'],'Verify final original before transfer',120,'media-observation');await json('guest-media-probe.json',JSON.parse(result));stopped=true;}}
const because='Native-X11 headed browser and overlay diagnostics need an isolated full display; local host console is active and modifying its display would interrupt it';
const interpolate=(v:any):any=>typeof v==='string'?v.replaceAll('$ROOT',lease.guestRoot).replaceAll('$WORK',lease.workspace):Array.isArray(v)?v.map(interpolate):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,interpolate(x)])):v;
try{
 const probe=await manager.probe();await json('probe.json',probe);
 lease=await manager.acquire({task:'linux-display-diagnostic',image:'ubuntu2404',env:'none',ttlHours:1,extractions:[{path:'walkthrough',name:'walkthrough'},{path:'result.json',name:'result.json'}]});await json('acquire.json',lease);await json('registry.json',{present:(await readFile(`${process.env.HOME}/AGENTS.md`,'utf8')).includes(lease.purpose)});
 await command(['/bin/bash','-lc','id; hostname; date -u +%FT%T.%NZ'],'Read-only fresh guest identity',120,'identity-preflight');
 const config=await configureCloneX11(argv=>vm.exec(lease.vm,{argv,timeout:30}),e=>audit('x11-config-auth-refusal',{because:'Authorized idempotent clone-only GDM native X11 setting; no restart/input replay',...e},async()=>true).then(()=>{}));await json('x11-config.json',config);if(config.rc!==0)throw Error('GDM config failed '+config.output);
 await command(['node','-e',`${configureGdmText.toString()};const fs=require('fs'),s=fs.readFileSync('/etc/gdm3/custom.conf','utf8');if(configureGdmText(s)!==s)throw Error('GDM setting missing');console.log('Native-X11 GDM desired state verified');`],'Verify clone GDM setting read-only',30,'display-preflight');
 try{await command(['sudo','systemctl','restart','gdm'],'Restart clone GDM once before first recorded UI input',60);}catch(e){await json('x11-restart-unconfirmed.json',{error:String(e),policy:'No restart replay; native X11 readiness must be independently proven'});}
 const discovery=await command(['node','-e',await readFile(join(project,'scripts/live-smoke-display.cjs'),'utf8'),'--','--observe-display'],'Observe actual authenticated X11 session without guessing Xauthority',240,'display-preflight');const ready=JSON.parse(discovery.trim().split('\n').at(-1)!);if(!ready.ready||ready.sessionType!=='x11')throw Error('Native X11 unavailable');await json('display-discovery.json',{discovery,ready});
 await command(['/bin/bash','-lc','sudo apt-get install -y --no-install-recommends ffmpeg xdotool x11-utils wmctrl > /var/tmp/relay-smoke-tools.log 2>&1'],'Install diagnostic capture and window inventory tools on this clone once',240);
 for(const [local,remote] of [['scripts/live-smoke-node.cjs','node'],['scripts/live-smoke-guest.cjs','harness.cjs'],['scripts/linux-diagnostic-observe.cjs','diagnostic.cjs']])await transfer().pushFile(join(project,local!),lease.guestRoot+'/support/'+remote);
 const envFile=join(root,'guest-display-env.json');await writeFile(envFile,JSON.stringify(ready.env));await transfer().pushFile(envFile,lease.guestRoot+'/support/env.json',root);
 await helper('start');recorderStarted=true;await new Promise(r=>setTimeout(r,1200));await helper('guard');
 await manager.stage({nodePath:lease.guestRoot+'/support/node',cuaDriver:lease.guestRoot+'/support/cua-wrapper',files:[{local:'scripts/linux-diagnostic-cua.cjs',path:'cua-wrapper'},{local:'test-evidence/ubuntu-20260912-2127/cua-driver',path:'cua-driver'}],browser:{playwrightModule:'/usr/lib/node_modules/@playwright/mcp/node_modules/playwright'}});
 await command([lease.guestRoot+'/support/node',lease.guestRoot+'/support/diagnostic.cjs','before-daemon','no-cua'],'Independent root capture/window inventory before daemon starts',120,'diagnostic-observation');
 await command(['node','-e',`const fs=require('fs'),cp=require('child_process'),r=${JSON.stringify(lease.guestRoot)};const fd=fs.openSync(r+'/workspace/walkthrough/cua.log','a');const c=cp.spawn(r+'/support/cua-driver',['serve','--dangerously-bypass-approvals'],{env:{...process.env,...JSON.parse(fs.readFileSync(r+'/support/env.json'))},detached:true,stdio:['ignore',fd,fd]});c.unref();console.log(c.pid)`],'Start isolated driver daemon with same DISPLAY/Xauthority as persistent browser');
 await new Promise(r=>setTimeout(r,500));
 await command([lease.guestRoot+'/support/node',lease.guestRoot+'/support/diagnostic.cjs','before-navigation'],'Independent root and CUA captures before navigation',120,'diagnostic-observation');
 await json('ready.json',{lease,status:'awaiting explicit requests',deadline:new Date(Date.now()+25*60000).toISOString()});
 const seen=new Set<string>(),deadline=Date.now()+25*60000;
 let finish=false;while(!finish){if(Date.now()>deadline)throw Error('Diagnostic enclosure deadline reached');const requests=(await readdir(join(root,'requests'))).filter(n=>n.endsWith('.json')&&!seen.has(n)).sort();if(!requests.length){await new Promise(r=>setTimeout(r,250));continue;}
  for(const name of requests){seen.add(name);const req=interpolate(JSON.parse(await readFile(join(root,'requests',name),'utf8')));let result:any;
   try{
    if(req.kind==='run'){await helper('guard');result=await audit('run',{input:req.input},()=>manager.run({...req.input,because:req.input.because||because}));await json(`operation-${req.input.step.id}.json`,result);if(result.outcome.kind!=='completed'||result.outcome.exitStatus.code!==0||result.outcome.exitStatus.signal)throw Error(`Recorded operation did not complete: ${JSON.stringify(result)}`);const receipt=JSON.parse(await readFile(join(lease.output,'host/receiver-receipts',result.executionId+'.json'),'utf8'));result={...result,receipt};}
    else if(req.kind==='observe'){result=await command([lease.guestRoot+'/support/node',lease.guestRoot+'/support/diagnostic.cjs',req.label],req.because,120,'diagnostic-observation');}
    else if(req.kind==='read'){result=await command(req.argv,req.because,req.timeout||120,'diagnostic-observation');}
    else if(req.kind==='extract'){result=await manager.extract(req.names);await json('explicit-extraction.json',result);}
    else if(req.kind==='pull'){result=await transfer().pullVerified(req.source,join(root,req.destination));}
    else if(req.kind==='finish'){await command([lease.guestRoot+'/support/node',lease.guestRoot+'/support/diagnostic.cjs','final'],'Retain final original full-display pixels and inventory before cleanup',120,'diagnostic-observation');await stopRecorder();await json('finish.json',await manager.finish());result={finished:true};finish=true;}
    else if(req.kind==='stop'){throw Error('Host ended incomplete diagnostic: '+req.because);}
    else throw Error('Unknown host request');
    await json(`responses/${name}`,{ok:true,result});
   }catch(e){await json(`responses/${name}`,{ok:false,error:String(e)});throw e;}
  }
 }
}catch(e){await json('error.json',{error:String(e),stack:(e as Error).stack,status:manager.status()});process.exitCode=1;}
finally{try{await manager.cleanup('Diagnostic enclosure ended; retain original evidence and destroy sole VM')}catch(e){await json('cleanup-error.json',{error:String(e)});process.exitCode=1;}await json('cleanup.json',{status:manager.status(),registryRemoved:lease?!(await readFile(`${process.env.HOME}/AGENTS.md`,'utf8')).includes(lease.purpose):true,vms:await vm.list(),tart:JSON.parse(execFileSync('tart',['list','--format','json'],{encoding:'utf8'}))});}
