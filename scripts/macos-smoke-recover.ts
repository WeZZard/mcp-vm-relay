// Recover the existing a4 enclosure after host tool timeout. No new VM/input.
import {RelayManager} from '../src/manager.js';
import {VmService,type RequestOptions} from '../src/vm-service.js';
import {verifyDeliveredPackage} from '../src/package.js';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const project=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]!);
const stateDir=(await readdir(join(root,'state')))[0]!;
const old=JSON.parse(await readFile(join(root,'state',stateDir,'lease.json'),'utf8'));
const save=(name:string,data:unknown)=>writeFile(join(root,name),JSON.stringify(data,null,2));
let verified:any={execution:'incomplete'};
try{verified=await verifyDeliveredPackage(old.hostRoot);}catch(e){await save('recovery-relay-package-error.json',{error:String(e)});}
const mediaManifest=JSON.parse(await readFile(join(root,'walkthrough-review/manifest.json'),'utf8'));
for(const f of mediaManifest.files){const b=await readFile(join(root,'walkthrough-review',f.path));if(b.length!==f.bytes||createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('Application package checksum mismatch');}
await save('recovery-precleanup-verification.json',{at:new Date().toISOString(),reason:'Recover the exact already-stopped enclosure after its retained evidence/package-review barrier. Read the attempt error and application manifest for execution outcome; no recording stop, UI input, or VM allocation is replayed.',relay:verified,application:{recording:mediaManifest.recording,execution:mediaManifest.execution,humanReview:mediaManifest.humanReview,checksumsVerified:mediaManifest.files.length}});
class CleanupVm extends VmService {
 override async release(n:string,b:{reason?:string}={},o:RequestOptions={}){
  const argv=['/bin/zsh','-c','rm -rf /Applications/RelayClock.app; test ! -e /Applications/RelayClock.app'];
  const result=await this.exec(n,{argv,timeout:30});
  await save('app-removal.json',{at:new Date().toISOString(),argv,result});
  if(result.rc!==0)throw Error('Test app removal not confirmed; retain exact lease');
  // Removal verified only after the recording/package barrier.
  const release=await super.release(n,b,o);await save('recovery-release.json',{at:new Date().toISOString(),release});return release;
 }
}
const vm=new CleanupVm();
const manager=new RelayManager({sessionId:old.row.agent.replace(/^mcp-vm-relay /,''),project,vm,stateRoot:join(root,'state'),outputRoot:join(root,'packages')});
try{await manager.initialize();await manager.cleanup('Release recovered finished package enclosure after application viewer verification');}
finally{const cleanup={at:new Date().toISOString(),status:manager.status(),registryRemoved:!(await readFile(`${process.env.HOME}/AGENTS.md`,'utf8')).includes(old.purpose),vms:await vm.list(),tart:JSON.parse(execFileSync('tart',['list','--format','json'],{encoding:'utf8'}))};await save('cleanup.json',cleanup);if(!cleanup.registryRemoved||old.lease.vm in cleanup.vms.vms||cleanup.tart.some((x:any)=>x.Name===old.lease.vm))throw Error('Cleanup verification failed');}
try{const caretaker=JSON.parse(await readFile(join(root,'retention-recovery-required.json'),'utf8'));const args=execFileSync('ps',['-p',String(caretaker.pid),'-o','args='],{encoding:'utf8'});if(!args.includes(root)||!args.includes('macos-smoke.ts'))throw Error('Caretaker identity mismatch');process.kill(caretaker.pid,'SIGTERM');await save('recovery-caretaker-stop.json',{at:new Date().toISOString(),pid:caretaker.pid,reason:'Exact VM destroyed and registry removed; no need for retention heartbeat'});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')await save('recovery-caretaker-note.json',{error:String(e)});}
await save('finish-recovered.json',{...(old.delivered??{}),applicationPackage:join(root,'walkthrough-review'),hostHarness:'existing retained enclosure recovered and destroyed after verified evidence review, without input or recorder-stop replay',humanReview:'pending'});
console.log(JSON.stringify({relay:verified,application:join(root,'walkthrough-review'),cleanup:'verified',humanReview:'pending'}));
