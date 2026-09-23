// Application-owned live macOS acceptance. All guest traffic is vm-service HTTP.
import {RelayManager,type RunInput} from '../src/manager.js';
import {VmService,type RequestOptions,type ExecRequest,type TransferRequest} from '../src/vm-service.js';
import {Transfer} from '../src/transfer.js';
import {observationCommand,desktopSession,nativeSession,assertCuaDispatch,assertSessionScope,desktopClickArgs,closeSession,assertConsentDismissed} from './macos-smoke-observation.js';
import {ReleasePreparation} from './macos-smoke-release.js';
import {INSTALL_TEST_APP,WRITE_FIXTURE,FREEZE_CLOCK_LOG,type Provisioning} from './macos-smoke-provisioning.js';
import {mkdir,readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const project=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]!);
if(!process.argv.includes('--run'))throw Error('Explicit --run required');
await mkdir(join(root,'audit'),{recursive:true});await mkdir(join(root,'support'),{recursive:true});
let seq=0,lease:any,node='node',recorder=false,stopped=false,app=false,manager:RelayManager,retained=false;
let stopPromise:Promise<void>|undefined,mediaPromise:Promise<void>|undefined,fixtureStopPromise:Promise<void>|undefined;
const reviewGates=process.argv.includes('--review-gates');
async function waitControl(name:string){await json('gate.json',{name,at:new Date().toISOString(),state:'awaiting-agent-review'});console.log('REVIEW GATE '+name);const deadline=Date.now()+600000;while(Date.now()<deadline){try{const value=JSON.parse(await readFile(join(root,`control-${name}.json`),'utf8'));await json(`gate-${name}-accepted.json`,{at:new Date().toISOString(),value});if(value.reject)throw Error(`Review gate rejected: ${value.reject}`);return value;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,500));}throw Error(`Agent review deadline exceeded: ${name}`);}
const json=async(name:string,value:any)=>writeFile(join(root,name),JSON.stringify(value,null,2));
async function audit<T>(kind:string,args:unknown,fn:()=>Promise<T>):Promise<T>{const id=String(seq++).padStart(5,'0'),at=new Date().toISOString();try{const result=await fn();await json(`audit/${id}-${kind}.json`,{at,finishedAt:new Date().toISOString(),args,result});return result;}catch(e){await json(`audit/${id}-${kind}.json`,{at,finishedAt:new Date().toISOString(),args,error:String(e)});throw e;}}
class AuditVm extends VmService {
 private releasePreparation=new ReleasePreparation();
 private next=0;
 private async pace(){const now=Date.now(),scheduled=Math.max(now,this.next);this.next=scheduled+250;if(scheduled>now)await new Promise(r=>setTimeout(r,scheduled-now));}
 override async exec(n:string,b:ExecRequest,o:RequestOptions={}){await this.pace();return audit('exec',{vm:n,request:b},()=>super.exec(n,b,o));}
 override async push(n:string,b:TransferRequest,o:RequestOptions={}){await this.pace();return audit('push',{vm:n,request:b},()=>super.push(n,b,o));}
 override async pull(n:string,b:TransferRequest,o:RequestOptions={}){await this.pace();return audit('pull',{vm:n,request:b},()=>super.pull(n,b,o));}
 override async release(n:string,b:{reason?:string}={},o:RequestOptions={}){
  await this.releasePreparation.prepare(async()=>{
  if(lease&&!retained){
   try{if(recorder){await stopRecorder();await retainFinalizedVideo();}if(app)await stopFixture();await transfer().pullVerified(lease.workspace+'/walkthrough',join(root,'application-original'));retained=true;await json('application-retention.json',{retained:true});
    // Build and verify the portable application package BEFORE destruction.
    if(recorder){execFileSync(join(project,'node_modules/.bin/tsx'),[join(project,'scripts/macos-smoke-viewer.ts'),root],{cwd:project,stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024});if(reviewGates){await waitControl('package-review');execFileSync(join(project,'node_modules/.bin/tsx'),[join(project,'scripts/macos-smoke-viewer.ts'),root],{cwd:project,stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024});}}
   }catch(e){await json('application-retention-error.json',{error:String(e),stderr:String((e as any).stderr??'')});throw e;}
  }
  if(app){try{await command(['/bin/zsh','-c',`rm -rf /Applications/RelayClock.app; test ! -e /Applications/RelayClock.app`],'Remove only tested native harness app before destroying its VM');app=false;}catch(e){await json('app-removal-error.json',{error:String(e)});throw e;}}
  });
  return audit('release',{vm:n,request:b},()=>super.release(n,b,o));
 }
}
const vm=new AuditVm();manager=new RelayManager({sessionId:`macos-live-${Date.now()}`,project,vm,stateRoot:join(root,'state'),outputRoot:join(root,'packages'),heartbeatMs:15000});
const transfer=()=>new Transfer(manager.channel,lease.vm,node,{guestRoot:lease.guestRoot,hostTempRoot:join(root,'frames'),onRetry:event=>json(`retry-${Date.now()}-${seq++}.json`,event)});
// Narrowly allow bounded retries of explicitly read-only application observations
// on pre-dispatch SSH auth denial. Never retry receiver, recorder start/stop, or
// ambiguous mutating operations. Every refusal remains in the audit.
async function command(argv:string[],because:string,timeout=120,provisioning?:Provisioning){return audit('harness',{because,argv,provisioning},()=>observationCommand(argv,because,()=>vm.exec(lease.vm,{argv,timeout}),(attempt,result)=>json(`harness-auth-refusal-${Date.now()}-${seq++}.json`,{because,attempt,argv,provisioning,result,dispatch:'rejected before guest execution'}),ms=>new Promise(r=>setTimeout(r,ms)),provisioning));}
const cua='/Applications/CuaDriver.app/Contents/MacOS/cua-driver';
async function call(tool:string,args:any={}){const out=await command([cua,'call',tool,'--json',JSON.stringify(args)],`Application recorder/capability ${tool}; preserve launchd daemon TCC identity`);try{return JSON.parse(out);}catch{return {raw:out};}}
async function observe(name:string){await call('get_desktop_state',{screenshot_out_file:lease.workspace+`/walkthrough/${name}.png`});await transfer().pullVerified(lease.workspace+`/walkthrough/${name}.png`,join(root,`${name}.png`));const windows=await call('list_windows',{on_screen_only:true});await json(`${name}-windows.json`,windows);return windows;}
async function guard(){const state=await call('get_recording_state');await json('latest-recording-state.json',state);const text=JSON.stringify(state);if(state.enabled!==true||state.video_active!==true||state.last_error)throw Error('Recording guard did not establish active native recorder: '+text);}
async function stopRecorder(){if(!recorder)return;return stopPromise??=(async()=>{await json('recorder-stop.json',await call('stop_recording'));stopped=true;})();}
async function stopFixture(){return fixtureStopPromise??=command(['/bin/zsh','-c','pkill -x RelayClock || true'],'Stop timing fixture writes after original video verification').then(()=>{});}
async function retainFinalizedVideo(){return mediaPromise??=(async()=>{const path=join(root,'finalized-original-retained.mp4');const facts=await transfer().pullVerified(lease.workspace+'/walkthrough/recording.mp4',path);const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{encoding:'utf8'}));if(!(Number(probe.format.duration)>0)||!probe.streams.some((s:any)=>s.codec_type==='video'))throw Error('Finalized recording lacks valid video stream');execFileSync('ffmpeg',['-v','error','-i',path,'-f','null','-'],{stdio:['ignore','ignore','pipe']});await json('finalized-recording-retention.json',{at:new Date().toISOString(),verified:true,fullMediaDecode:'passed',path:'finalized-original-retained.mp4',facts,probe,appCleanupNotYetStarted:true});})();}
async function run(input:RunInput){await guard();if(input.kind==='cua'){const session=String(input.args?.session??'');const facts=await call('get_session_state',{session});await json(`session-before-${input.step.id}.json`,facts);assertSessionScope(facts,session,input.args?.scope==='desktop'?'desktop':'window');}const result=await audit('run',{input},()=>manager.run(input));await json(`operation-${input.step.id}.json`,result);if(result.outcome.kind!=='completed'||result.outcome.exitStatus.code!==0||result.outcome.exitStatus.signal)throw Error('Recorded operation failed: '+JSON.stringify(result));if(input.kind==='cua'){const receipt=JSON.parse(await readFile(join(lease.output,'host/receiver-receipts',result.executionId+'.json'),'utf8'));assertCuaDispatch(receipt.stdout);}return result;}
const step=(id:string,title:string,expected:string)=>({id,title,expected,inputMode:'ordinary' as const});
const because='Live ordinary pointer/keyboard and headed persistent-browser acceptance would change the host display; a fresh macOS VM isolates the interruptive test';
try{
 await json('probe.json',await manager.probe());
 execFileSync('/usr/bin/swiftc',['-target','arm64-apple-macosx15.0',join(project,'scripts/macos-smoke-clock.swift'),'-o',join(root,'support/RelayClock')],{stdio:['ignore','pipe','pipe']});
 await writeFile(join(root,'support/Info.plist'),'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.wezzard.relay-smoke.clock</string><key>CFBundleExecutable</key><string>RelayClock</string><key>CFBundleName</key><string>RelayClock</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 lease=await manager.acquire({task:process.env.MACOS_SMOKE_TASK??'relay-smoke-macos',image:'macos26',env:'none',ttlHours:1,extractions:[{path:'walkthrough',name:'walkthrough'},{path:'result.json',name:'result.json'}]});await json('acquire.json',lease);
 await json('registry.json',{present:(await readFile(`${process.env.HOME}/AGENTS.md`,'utf8')).includes(lease.purpose)});
 // One actual read-only identity observation; bounded explicit pre-dispatch
 // auth-denial retries are handled by command(). Do not invent a consecutive
 // successes gate: transient read-only refusals do not establish UI failure.
 await json('guest-identity.json',{identity:await command(['/usr/bin/id'],'Read actual guest identity before staging',15)});
 const discovery=await command(['/bin/zsh','-lc',`node -e 'const fs=require("fs"),cp=require("child_process"),p=require("path");const global=cp.execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim();console.log(JSON.stringify({node:process.execPath,global,home:process.env.HOME,candidates:[global+"/@playwright/mcp/node_modules/playwright",global+"/playwright"]}));'`],'Discover actual image node and bundled Playwright module without GUI changes');
 const facts=JSON.parse(discovery.trim().split('\n').at(-1)!);node=facts.node;await json('guest-runtime.json',facts);
 const module=await command([node,'-e',`const fs=require('fs');const c=${JSON.stringify(facts.candidates)};let p=c.find(x=>fs.existsSync(x+'/package.json'));if(!p){const root=${JSON.stringify(facts.home)}+'/.npm/_npx';for(const e of fs.readdirSync(root)){for(const s of ['/node_modules/playwright','/node_modules/@playwright/mcp/node_modules/playwright'])if(fs.existsSync(root+'/'+e+s+'/package.json')){p=root+'/'+e+s;break;}if(p)break;}}if(!p)process.exit(1);console.log(p);`],'Locate pinned bundled Playwright, not installed personal Chrome');
 await json('permissions.json',JSON.parse(await command([cua,'permissions','status','--json'],'Read actual launchd daemon permission identity')));
 await command(['/bin/mkdir','-p',lease.workspace+'/walkthrough',lease.guestRoot+'/support'],'Prepare application evidence and support directories',120,{kind:'mkdir-owned',root:lease.guestRoot});
 await json('daemon.json',await command(['/bin/zsh','-c',`ps -axo pid,ppid,command | /usr/bin/grep '[c]ua-driver serve'; launchctl print gui/$(id -u)/com.trycua.driver.serve`],'Verify daemon remains launchd-owned; never replace it with shell process'));
 await call('get_desktop_state',{screenshot_out_file:lease.workspace+'/walkthrough/preflight.png'});
 await transfer().pushFile(join(root,'support/RelayClock'),lease.guestRoot+'/support/RelayClock');await transfer().pushFile(join(root,'support/Info.plist'),lease.guestRoot+'/support/Info.plist');
 app=true;await command([node,'-e',INSTALL_TEST_APP,lease.guestRoot],'Install only deterministic tested app bytes; do not launch',120,{kind:'install-test-app',root:lease.guestRoot});
 await command(['/usr/bin/open','/Applications/RelayClock.app','--args',lease.workspace+'/walkthrough'],'Launch tested app and timing beacon once; never replay this operation');
 await command([node,'-e',`const fs=require('fs');let n=0;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(lease.workspace+'/walkthrough/clock-geometry.json')})){clearInterval(t);console.log('clock-ready')}else if(++n>100){clearInterval(t);process.exitCode=1}},100);`],'Read actual app timing beacon readiness before starting recording');
 await json('recorder-start.json',await call('start_recording',{output_dir:lease.workspace+'/walkthrough',record_video:true}));recorder=true;await guard();
 const geometry=JSON.parse(await command([node,'-e',`console.log(require('fs').readFileSync(${JSON.stringify(lease.workspace+'/walkthrough/clock-geometry.json')},'utf8'))`],'Read native test field pixel coordinates from harness, not accessibility activation'));
 await writeFile(join(root,'support/harness-config.json'),JSON.stringify({node,walk:lease.workspace+'/walkthrough'}));
 const wrapper=(await readFile(join(project,'scripts/macos-smoke-dispatch.cjs'),'utf8')).replace('#!/usr/bin/env node',`#!${node}`);
 for(const name of ['node','cua-wrapper']){await writeFile(join(root,'support',name),wrapper);await chmod(join(root,'support',name),0o755);await transfer().pushFile(join(root,'support',name),lease.guestRoot+'/support/'+name);}
 await transfer().pushFile(join(root,'support/harness-config.json'),lease.guestRoot+'/support/harness-config.json');
 await manager.stage({nodePath:lease.guestRoot+'/support/node',cuaDriver:lease.guestRoot+'/support/cua-wrapper',browser:{playwrightModule:module.trim()}});
 // Explicitly declare the user-authorized desktop input modality BEFORE any
 // session-keyed input. This is a non-input CUA session setup, not a TCC change.
 await json('cua-desktop-session.json',await call('start_session',desktopSession));
 await json('cua-native-session.json',await call('start_session',nativeSession));
 assertSessionScope(await call('get_session_state',{session:desktopSession.session}),desktopSession.session,'desktop');
 assertSessionScope(await call('get_session_state',{session:nativeSession.session}),nativeSession.session,'window');
 // Recording is already active. The agent observes the actual system dialog,
 // authorizes exactly one pixel click, then verifies its visible result.
 if(reviewGates){await observe('consent-before');const control=await waitControl('consent-before');if(!control.observedControl||control.args?.element_index!==undefined||!Number.isFinite(control.args?.x)||!Number.isFinite(control.args?.y))throw Error('Consent requires observed exact control and ordinary pixel coordinates');await run({because:'User authorized normal test consent; observed control: '+control.observedControl,kind:'cua',tool:'click',args:desktopClickArgs(control.args.x,control.args.y),step:step('consent-allow','Allow observed direct capture consent','Ordinary click on observed Allow dismisses CuaDriver direct-screen-access dialog'),snapshots:{afterIntervalMs:500}});await observe('consent-after');assertConsentDismissed(await waitControl('consent-after'));}
 // Stage starts Chromium, but native pixel input targets exact existing app window via its PID.
 await run({because,kind:'cua',tool:'click',args:{pid:geometry.pid,window_id:geometry.windowId,x:geometry.localX,y:geometry.localY,session:nativeSession.session},step:step('native-click','Focus native field','Real screen-pixel click focuses native test field'),snapshots:{afterIntervalMs:200}});
 for(let i=0;i<5;i++)await run({because,kind:'cua',tool:'press_key',args:{pid:geometry.pid,key:'relay'[i],session:nativeSession.session},step:step(`native-key-${i}`,`Type ${'relay'[i]}`,'CGEvent key with no element index; explicit consecutive text group'),snapshots:{group:{groupId:'native-relay',phase:i===0?'first':i===4?'last':'member',...(i===4?{afterIntervalMs:100}:{})}}});
 const entered=await command([node,'-e',`console.log(require('fs').readFileSync(${JSON.stringify(lease.workspace+'/walkthrough/native-text.txt')},'utf8'))`],'Read native field after ordinary keyboard group');if(entered.trim()!=='relay')throw Error('Native ordinary input expected relay, saw '+JSON.stringify(entered));await json('native-assertion.json',{text:entered.trim()});
 // This fresh step tests the observed close button, NOT the failed a10 key equivalent.
 // Desktop coordinates keep the post-close full-display snapshot valid after the window disappears.
 if(!reviewGates)throw Error('Native close requires an agent-observed close-button review gate');
 await observe('native-filled');const closeControl=await waitControl('native-filled');
 if(!closeControl.observedControl||closeControl.args?.element_index!==undefined||!Number.isFinite(closeControl.args?.x)||!Number.isFinite(closeControl.args?.y))throw Error('Native close requires observed exact button and ordinary desktop pixel coordinates');
 // Consent's earlier desktop session may have ended during native work/review.
 // Establish a distinct session after observing the close button, before input.
 await json('cua-close-session.json',await call('start_session',closeSession));
 assertSessionScope(await call('get_session_state',{session:closeSession.session}),closeSession.session,'desktop');
 await run({because:because+'; observed close control: '+closeControl.observedControl,kind:'cua',tool:'click',args:desktopClickArgs(closeControl.args.x,closeControl.args.y,closeSession.session),step:step('native-close','Click native fixture close button','Ordinary real pixel click on observed red close button closes field window; timing strip remains visible for browser actions'),snapshots:{afterIntervalMs:300}});
 const nativeState=JSON.parse(await command([node,'-e',`console.log(require('fs').readFileSync(${JSON.stringify(lease.workspace+'/walkthrough/native-window.json')},'utf8'))`],'Read actual native AppKit window visibility after ordinary close-button click'));await json('native-close-state.json',nativeState);await observe('native-closed');if(nativeState.windowVisible!==false)throw Error('Observed close-button click did not close native fixture');await waitControl('native-closed');
 const html='<!doctype html><style>body{font:28px system-ui;padding:80px;background:#eef}input,button{font:28px system-ui;padding:16px}#state{margin:40px 0}</style><h1>Persistent Playwright acceptance</h1><input id="text" oninput="document.querySelector(\'#echo\').textContent=this.value"><p id="echo"></p><button id="button" onclick="document.querySelector(\'#state\').textContent=\'Playwright click confirmed\'">Confirm</button><p id="state">Waiting</p>';
 await command([node,'-e',WRITE_FIXTURE,lease.guestRoot,html],'Write deterministic private browser fixture',120,{kind:'write-fixture',root:lease.guestRoot});
 await command([node,'-e',`const fs=require('fs'),cp=require('child_process');const fd=fs.openSync(${JSON.stringify(lease.workspace+'/walkthrough/server.log')},'a');const p=cp.spawn(process.execPath,['-e',${JSON.stringify(`require('http').createServer((q,s)=>s.end(require('fs').readFileSync(${JSON.stringify(lease.workspace+'/fixture.html')}))).listen(8876,'127.0.0.1')`)}],{detached:true,stdio:['ignore',fd,fd]});p.unref();console.log(p.pid);`],'Start disposable local fixture server outside extension; no UI input hidden in harness');
 await run({because,kind:'exec',argv:['/usr/bin/printf','relay exec verified\n'],step:step('exec-smoke','Recorded exec','Exit zero with causal full-display snapshots'),snapshots:{afterIntervalMs:100}});
 await run({because,kind:'script',localPath:'scripts/live-smoke-upload.js',language:'javascript',step:step('uploaded-script','Uploaded script','Write declared result.json through recorded uploaded script'),snapshots:{afterIntervalMs:100}});
 for(const [id,browser,expected] of [
  ['browser-navigate',{action:'navigate',url:'http://127.0.0.1:8876'},'Fixture appears in fresh bundled browser'],
  ['browser-click',{action:'click',selector:'#text'},'Real Playwright pointer focuses field on same persistent page'],
  ['browser-type',{action:'type',selector:'#text',text:'relay'},'Sequential real keyboard events enter relay'],
  ['browser-read',{action:'read',selector:'#echo'},'DOM observation retains relay across operations'],
  ['browser-confirm',{action:'click',selector:'#button'},'Button changes confirmation on same page'],
  ['browser-final',{action:'read',selector:'#state'},'DOM observation reports Playwright click confirmed']
 ] as const){const result=await run({because,kind:'browser',browser,step:step(id,id,expected),snapshots:{afterIntervalMs:id==='browser-navigate'?500:200}});if(id==='browser-read'||id==='browser-final'){const receipt=JSON.parse(await readFile(join(lease.output,'host/receiver-receipts',result.executionId+'.json'),'utf8'));const text=JSON.parse(receipt.stdout).result.text;if(text!==(id==='browser-read'?'relay':'Playwright click confirmed'))throw Error('Persistent page assertion failed');}}
 await call('get_desktop_state',{screenshot_out_file:lease.workspace+'/walkthrough/final.png'});if(reviewGates){await observe('final-visible');await waitControl('final-visible');}await guard();await stopRecorder();await retainFinalizedVideo();
 await stopFixture();
 await json('explicit-extraction.json',await manager.extract(['result.json']));
 await json('finish.json',await manager.finish());
 await json('success.json',{execution:'passed',recording:'see walkthrough-review/manifest.json',humanReview:'pending'});
}catch(e){await json('error.json',{error:String(e),stack:(e as Error).stack,status:manager.status(),stderr:String((e as any).stderr??'')});process.exitCode=1;}
finally{try{await manager.cleanup('macOS acceptance ended; retain original attempt evidence and destroy dedicated manager lease')}catch(e){await json('cleanup-error.json',{error:String(e)});process.exitCode=1;}await json('cleanup.json',{status:manager.status(),registryRemoved:lease?!(await readFile(`${process.env.HOME}/AGENTS.md`,'utf8')).includes(lease.purpose):true,vms:await vm.list(),tart:JSON.parse(execFileSync('tart',['list','--format','json'],{encoding:'utf8'}))});if((manager.status() as any).vm){await json('retention-recovery-required.json',{at:new Date().toISOString(),vm:lease.vm,purpose:lease.purpose,stateRoot:manager.root,pid:process.pid,reason:'Evidence/app removal barrier failed. No destruction allowed. Detached owner keeps TTL alive for exact-lease recovery; no recorder/input replay.'});const retainLease=setInterval(()=>{void vm.heartbeat(lease.vm,{ttl_hours:1}).catch(e=>json('retention-heartbeat-error.json',{at:new Date().toISOString(),error:String(e)}));},30000);await new Promise(()=>{});clearInterval(retainLease);}}
