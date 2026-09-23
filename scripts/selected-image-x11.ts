// Explicit disposable-clone setup only. Never retries configuration or restart.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configureGdmText } from './live-smoke-x11.js';
export const configPath='/etc/gdm3/custom.conf';
export async function setupSelectedCloneX11(node:string, guest:(argv:string[])=>Promise<string>, retain:(name:string,value:unknown)=>Promise<unknown>) {
 const script=`${configureGdmText.toString()};const fs=require('fs'),p=${JSON.stringify(configPath)};const before=fs.readFileSync(p);const after=Buffer.from(configureGdmText(before.toString('utf8')));if(!after.equals(before))fs.writeFileSync(p,after);const verified=fs.readFileSync(p);console.log(JSON.stringify({path:p,beforeBase64:before.toString('base64'),afterBase64:after.toString('base64'),verifiedBase64:verified.toString('base64')}));if(!verified.equals(after))process.exitCode=1;`;
 // guest() throws on every nonzero/refused/uncertain dispatch; nothing is replayed.
 const output=await guest(['sudo',node,'-e',script]);
 const report=JSON.parse(output.trim());
 await retain('x11-config-original-result.json',report);
 assert.equal(report.path,configPath);
 const before=Buffer.from(report.beforeBase64,'base64'),after=Buffer.from(report.afterBase64,'base64'),verified=Buffer.from(report.verifiedBase64,'base64');
 assert.equal(after.toString('utf8'),configureGdmText(before.toString('utf8')));
 assert(after.equals(verified),'Readback differs from intended configuration');
 assert.equal(configureGdmText(verified.toString('utf8')),verified.toString('utf8'));
 const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 await retain('x11-config-verified.json',{path:configPath,changed:!before.equals(after),beforeSha256:hash(before),afterSha256:hash(after),verifiedSha256:hash(verified),policy:'Explicit disposable clone only; helper preserves unrelated config text; no retries'});
 // Exactly once, before bounded display discovery; failure escapes immediately.
 const restart=await guest(['sudo','systemctl','restart','gdm']);
 await retain('x11-restart.json',{output:restart,confirmedZero:true,attempts:1});
}
