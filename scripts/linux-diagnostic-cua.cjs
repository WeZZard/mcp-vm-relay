#!/usr/bin/env node
// Application-only environment, guard and UTC events. Delegate unchanged to real CUA.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),walk=path.join(root,'workspace/trajectory');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'support/env.json'),'utf8'));
const args=process.argv.slice(2),tool=args[1],event=args[0]==='call'&&tool!=='get_desktop_state';
if(event){const g=cp.spawnSync('/usr/bin/node',[path.join(root,'support/harness.cjs'),'guard'],{env:{...process.env,...cfg},encoding:'utf8'});if(g.status!==0){process.stderr.write(g.stderr);process.exit(1);}}
const start=Date.now();if(event)fs.appendFileSync(path.join(walk,'events.jsonl'),JSON.stringify({phase:'start',tool,args,utcMs:start})+'\n');
const r=cp.spawnSync(path.join(root,'support/cua-driver'),args,{env:{...process.env,...cfg},encoding:'utf8',maxBuffer:8*1024*1024});
if(event)fs.appendFileSync(path.join(walk,'events.jsonl'),JSON.stringify({phase:'end',tool,args,utcMs:Date.now(),start,code:r.status,stdout:r.stdout,stderr:r.stderr})+'\n');
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
