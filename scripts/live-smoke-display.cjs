// Application-only read-only graphical-session discovery. Never reads/logs Xauthority cookie bytes.
const fs=require('node:fs'),cp=require('node:child_process');
function candidates(processes,uid,rejected=[]){
 const out=[];
 // Linux /proc/PID/comm truncates gnome-session-binary to 15 bytes.
 for(const p of processes){if(!['gnome-shell','gnome-session-binary','gnome-session-b','gnome-session'].includes(p.name))continue;
  if(p.uid!==uid){rejected.push({pid:p.pid,name:p.name,uid:p.uid,reason:'different-user'});continue;}
  const e=Object.fromEntries(p.environ.split('\0').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
  if(!/^:\d+(\.\d+)?$/.test(e.DISPLAY||'')||!e.XAUTHORITY?.startsWith('/')){rejected.push({pid:p.pid,name:p.name,uid:p.uid,reason:'missing-or-invalid-display-environment',displayPresent:Boolean(e.DISPLAY),authorityPresent:Boolean(e.XAUTHORITY)});continue;}
  const env={DISPLAY:e.DISPLAY,XAUTHORITY:e.XAUTHORITY,DBUS_SESSION_BUS_ADDRESS:e.DBUS_SESSION_BUS_ADDRESS||`unix:path=/run/user/${uid}/bus`};
  if(!out.some(x=>x.env.DISPLAY===env.DISPLAY&&x.env.XAUTHORITY===env.XAUTHORITY))out.push({pid:p.pid,name:p.name,sessionType:e.XDG_SESSION_TYPE||'unknown',env});
 }return out;
}
function processFacts(errors=[]){const facts=[];for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name))continue;try{const base='/proc/'+name;facts.push({pid:Number(name),uid:fs.statSync(base).uid,name:fs.readFileSync(base+'/comm','utf8').trim(),environ:fs.readFileSync(base+'/environ','utf8')});}catch(e){if(errors.length<100)errors.push({pid:Number(name),code:e.code||'UNKNOWN'});}}return facts;}
function inspectDetailed(deps={}){
 const uid=deps.uid??process.getuid(),errors=[],rejected=[],commands=[];
 const now=deps.now||(()=>performance.now()),deadline=deps.deadline??Infinity;
 const facts=(deps.processFacts||processFacts)(errors);
 const baseEnv={...process.env,XDG_RUNTIME_DIR:`/run/user/${uid}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${uid}/bus`};
 function run(command,args,env=baseEnv){
  const remaining=Math.floor(deadline-now());
  const r=remaining<=0?{status:null,error:{code:'DISCOVERY_DEADLINE'},stderr:'Discovery budget exhausted; command not run'}:
   (deps.spawnSync||cp.spawnSync)(command,args,{env,encoding:'utf8',timeout:Math.min(3000,remaining),maxBuffer:65536});
  commands.push({command,args,rc:r.status,errorCode:r.error?.code,stderr:(r.stderr||'').slice(0,2048),
   // Never retain the user manager's complete environment.
   stdout:command==='systemctl'?undefined:(r.stdout||'').slice(0,4096)});
  return r;
 }
 const userEnvironment=run('systemctl',['--user','show-environment']);
 if(userEnvironment.status===0)facts.push({pid:0,uid,name:'gnome-session',environ:(userEnvironment.stdout||'').replaceAll('\n','\0')});
 let graphicalType='unknown';
 const sessions=run('loginctl',['list-sessions','--no-legend']);
 for(const line of (sessions.stdout||'').trim().split('\n').slice(0,64)){
  const sid=line.trim().split(/\s+/)[0];if(!sid)continue;
  const result=run('loginctl',['show-session',sid,'-p','Type','-p','User','-p','Active']);
  const fields=Object.fromEntries((result.stdout||'').trim().split('\n').map(s=>s.split('=')));
  if(result.status===0&&fields.User===String(uid)&&fields.Active==='yes'&&['x11','wayland'].includes(fields.Type))graphicalType=fields.Type;
 }
 const observations=candidates(facts,uid,rejected).map(c=>{
  const r=run('xrandr',['--current'],{...process.env,...c.env});
  return {...c,sessionType:graphicalType,rc:r.status,stderr:(r.stderr||'').slice(0,2048),display:(r.stdout||'').split('\n')[0],modeListOmitted:true,
   connectionSucceeded:r.status===0,ready:graphicalType==='x11'&&r.status===0};
 });
 return {uid,processReadErrors:errors,rejected:rejected.slice(0,100),commands,observations};
}
function inspect(){return inspectDetailed().observations;}
async function observe(sample=inspect,pause=()=>new Promise(r=>setTimeout(r,1000)),emit=console.log){for(let attempt=1;attempt<=60;attempt++){const observations=sample();emit(JSON.stringify({attempt,utc:new Date().toISOString(),observations}));const ready=observations.find(x=>x.ready&&x.sessionType==='x11');if(ready){const result={ready:true,env:ready.env,sessionType:ready.sessionType,pid:ready.pid};emit(JSON.stringify(result));return result;}if(attempt<60)await pause();}return null;}
// Read-only readiness sampling only: never restarts sessions or replays a mutation.
// The deadline is passed into inspectDetailed so every command keeps its 3s cap
// and is additionally bounded by the remaining overall discovery budget.
async function observeDetailed(deps={}){
 const now=deps.now||(()=>performance.now()),pause=deps.pause||(ms=>new Promise(r=>setTimeout(r,ms)));
 const timeoutMs=deps.timeoutMs??30000,maxAttempts=deps.maxAttempts??7,intervalMs=deps.intervalMs??2000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isInteger(maxAttempts)||maxAttempts<1||!Number.isFinite(intervalMs)||intervalMs<0)throw Error('Invalid discovery bounds');
 const deadline=now()+timeoutMs,samples=[];
 const sample=deps.sample||((deadline)=>inspectDetailed({deadline,now}));
 for(let attempt=1;attempt<=maxAttempts&&now()<deadline;attempt++){
  const report=await sample(deadline);
  const entry={attempt,utc:new Date().toISOString(),report};samples.push(entry);
  // Retain each complete diagnostic before interpreting it, including failures.
  if(deps.retain)await deps.retain(entry);
  const selected=report.observations.find(x=>x.ready&&x.connectionSucceeded&&x.sessionType==='x11');
  if(selected)return {status:'ready',selected,samples};
  if(report.observations.some(x=>x.connectionSucceeded&&x.sessionType==='wayland'))return {status:'unsupported-session-type',sessionType:'wayland',samples};
  // An observed connection failure is not permission to replay xrandr.
  if(report.observations.some(x=>!x.connectionSucceeded))return {status:'connection-failed',samples};
  if(attempt<maxAttempts&&now()<deadline)await pause(Math.min(intervalMs,deadline-now()));
 }
 return {status:'unavailable',samples};
}
module.exports={candidates,observe,inspectDetailed,observeDetailed};
if(process.argv.includes('--observe-display'))observe().then(result=>{if(!result)process.exitCode=1;}).catch(e=>{console.error(String(e));process.exitCode=1;});
