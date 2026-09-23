// Application-owned deterministic provisioning allowlist. No launch/input API.
import {posix as path} from 'node:path';
export const INSTALL_TEST_APP = `const fs=require('fs'),p=require('path');const root=process.argv[1],app='/Applications/RelayClock.app';fs.mkdirSync(app+'/Contents/MacOS',{recursive:true});fs.copyFileSync(root+'/support/RelayClock',app+'/Contents/MacOS/RelayClock');fs.copyFileSync(root+'/support/Info.plist',app+'/Contents/Info.plist');fs.chmodSync(app+'/Contents/MacOS/RelayClock',493);console.log('installed');`;
export const WRITE_FIXTURE = `const fs=require('fs');fs.writeFileSync(process.argv[1]+'/workspace/fixture.html',process.argv[2]);console.log('fixture-written');`;
export const FREEZE_CLOCK_LOG = `const fs=require('fs');const p=process.argv[1]+'/workspace/trajectory/clock.jsonl';fs.copyFileSync(p,p+'.final');fs.renameSync(p+'.final',p);console.log('clock-log-frozen');`;
export type Provisioning = {kind:'mkdir-owned'|'install-test-app'|'write-fixture'|'freeze-clock-log';root:string};
export function isProvisioningCommand(argv:string[],policy:Provisioning|undefined):boolean {
 if(!policy||!/^\/var\/tmp\/[a-zA-Z0-9-]+$/.test(policy.root)||!policy.root.includes('-mcp-vm-relay-'))return false;
 const beneath=(value:string)=>{if(!path.isAbsolute(value))return false;const rel=path.relative(policy.root,path.normalize(value));return rel===''||rel!=='..'&&!rel.startsWith('../')&&!path.isAbsolute(rel);};
 if(policy.kind==='mkdir-owned')return argv[0]==='/bin/mkdir'&&argv[1]==='-p'&&argv.length>=3&&argv.slice(2).every(beneath);
 if(!argv[0]?.endsWith('/node')||argv[1]!=='-e'||argv[3]!==policy.root)return false;
 if(policy.kind==='install-test-app')return argv.length===4&&argv[2]===INSTALL_TEST_APP;
 if(policy.kind==='write-fixture')return argv.length===5&&argv[2]===WRITE_FIXTURE;
 if(policy.kind==='freeze-clock-log')return argv.length===4&&argv[2]===FREEZE_CLOCK_LOG;
 return false;
}
