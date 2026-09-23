#!/usr/bin/env node
// Application test wrapper: X11 context and actual guest-clock intervals for browser calls.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),walk=path.join(root,'workspace/trajectory');
const env={...process.env,...JSON.parse(fs.readFileSync(path.join(root,'support/env.json'),'utf8'))};
const args=process.argv.slice(2),browser=args[0]?.endsWith('/browser.mjs')&&args[1]==='call';
if(browser){const g=cp.spawnSync('/usr/bin/node',[path.join(root,'support/harness.cjs'),'guard'],{env,encoding:'utf8'});if(g.status!==0){process.stderr.write(g.stderr);process.exit(1);}}
const start=Date.now();if(browser)fs.appendFileSync(path.join(walk,'events.jsonl'),JSON.stringify({phase:'start',tool:'browser',args,utcMs:start})+'\n');
const result=cp.spawnSync('/usr/bin/node',args,{env,encoding:'utf8',maxBuffer:8*1024*1024});
if(browser)fs.appendFileSync(path.join(walk,'events.jsonl'),JSON.stringify({phase:'end',tool:'browser',args,utcMs:Date.now(),start,code:result.status,stdout:result.stdout,stderr:result.stderr})+'\n');
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
