import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupSelectedCloneX11,configPath} from './selected-image-x11.js';
import {configureGdmText} from './live-smoke-x11.js';
const before='# retained\r\n[daemon]\r\n#WaylandEnable=false\r\nAutomaticLogin=admin\r\n[security]\r\n# retained too\r\n';
const after=configureGdmText(before);
const report=JSON.stringify({path:configPath,beforeBase64:Buffer.from(before).toString('base64'),afterBase64:Buffer.from(after).toString('base64'),verifiedBase64:Buffer.from(after).toString('base64')});
test('explicit clone setup preserves unrelated bytes, retains config, verifies before one restart',async()=>{
 assert.equal(after,before.replace('#WaylandEnable=false','WaylandEnable=false'));
 const calls:string[][]=[],retained:string[]=[];
 await setupSelectedCloneX11('/usr/bin/node',async argv=>{calls.push(argv);if(calls.length===1){assert.deepEqual(argv.slice(0,3),['sudo','/usr/bin/node','-e']);assert(argv[3]!.includes(configPath));return report;}assert(retained.includes('x11-config-verified.json'));return '';},async n=>{retained.push(n);});
 assert.equal(calls.length,2);assert.deepEqual(calls[1],['sudo','systemctl','restart','gdm']);
});
for(const phase of ['configuration','restart'])test(`no replay after ${phase} refuses`,async()=>{
 let calls=0;await assert.rejects(setupSelectedCloneX11('/usr/bin/node',async()=>{calls++;if(phase==='restart'&&calls===1)return report;throw Error('rc=255 refused');},async()=>{}),/rc=255/);assert.equal(calls,phase==='configuration'?1:2);
});
test('readback mismatch forbids restart',async()=>{
 let calls=0;const bad=JSON.parse(report);bad.verifiedBase64=bad.beforeBase64;
 await assert.rejects(setupSelectedCloneX11('/usr/bin/node',async()=>{calls++;return JSON.stringify(bad);},async()=>{}),/Readback differs/);assert.equal(calls,1);
});
