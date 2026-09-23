#!/usr/bin/env node
// Application harness only: records guest UTC action intervals, outside shipped code.
const fs=require('fs'),cp=require('child_process'),path=require('path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'harness-config.json')));
const args=process.argv.slice(2),isCua=path.basename(process.argv[1])==='cua-wrapper';
const executable=isCua?'/Applications/CuaDriver.app/Contents/MacOS/cua-driver':config.node;
const action=isCua&&args[0]==='call'&&['click','press_key'].includes(args[1])?'cua':!isCua&&args[0]?.endsWith('/browser.mjs')&&args[1]==='call'?'browser':null;
let start;if(action){start=Date.now();fs.appendFileSync(config.walk+'/events.jsonl',JSON.stringify({phase:'start',utcMs:start,action,argv:args})+'\n');}
const result=cp.spawnSync(executable,args,{stdio:'inherit'});
if(action)fs.appendFileSync(config.walk+'/events.jsonl',JSON.stringify({phase:'end',utcMs:Date.now(),start,action,status:result.status,signal:result.signal})+'\n');
if(result.error)console.error(String(result.error));process.exit(result.status??1);
