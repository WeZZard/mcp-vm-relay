// Test application recording/fixture harness; NOT shipped by mcp-vm-relay.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http');
const root=path.resolve(__dirname,'..'),walk=path.join(root,'workspace/walkthrough');fs.mkdirSync(walk,{recursive:true});
const env=JSON.parse(fs.readFileSync(path.join(__dirname,'env.json'),'utf8'));Object.assign(process.env,env);
function detach(cmd,args,out){const fd=fs.openSync(path.join(walk,out),'a');const child=cp.spawn(cmd,args,{detached:true,stdio:['ignore',fd,fd],env:process.env});child.unref();fs.closeSync(fd);return child.pid;}
const op=process.argv[2];
const fixture='<!doctype html><title>Relay Ubuntu Verification</title><style>body{font:24px sans-serif;padding:35px;background:#eef3fa;color:#123}input,button{font:28px sans-serif;padding:14px;margin:16px 0}input{display:block;width:520px}h1{font-size:40px}#state,#echo{font-size:28px;color:#076}</style><h1>Relay Ubuntu verification</h1><label>Sender-declared text group<input id="text" placeholder="Type relay here" oninput="document.querySelector(\'#echo\').textContent=this.value"></label><p id="echo">Empty</p><button id="button" onclick="document.querySelector(\'#state\').textContent=\'Playwright click confirmed\'">Confirm with Playwright</button><p id="state">Waiting for input</p>';
if(op==='start'){
 if(fs.existsSync('/var/tmp/relay-smoke-tools.log'))fs.copyFileSync('/var/tmp/relay-smoke-tools.log',path.join(walk,'tools-install.log'));
 fs.writeFileSync(path.join(walk,'display.txt'),cp.execFileSync('xrandr',['--current'],{encoding:'utf8'}));
 const pid=detach('ffmpeg',['-nostdin','-y','-copyts','-f','x11grab','-draw_mouse','1','-framerate','10','-video_size','3840x2160','-i',env.DISPLAY,'-vf','showinfo,setpts=PTS-STARTPTS','-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p','-fps_mode','passthrough','-g','10','-movflags','+frag_keyframe+empty_moov+default_base_moof',path.join(walk,'original.mp4')],'ffmpeg.log');
 fs.writeFileSync(path.join(walk,'recorder.pid'),String(pid));
 const server=detach(process.execPath,[__filename,'fixture'],'fixture.log');fs.writeFileSync(path.join(walk,'fixture.pid'),String(server));console.log(JSON.stringify({recorder:pid,fixture:server}));
}
if(op==='fixture')http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture)}).listen(8876,'127.0.0.1');
if(op==='guard'){
 const pid=Number(fs.readFileSync(path.join(walk,'recorder.pid'),'utf8'));process.kill(pid,0);
 const log=fs.readFileSync(path.join(walk,'ffmpeg.log'),'utf8');const frames=[...log.matchAll(/n:\s*\d+ pts:(\d+)/g)];
 if(!frames.length)throw Error('Recorder has not captured a frame');
 const lastEpochUs=Number(frames.at(-1)[1]);if(Date.now()-lastEpochUs/1000>3000)throw Error('Recorder frame stream stalled');
 console.log(JSON.stringify({recorderAlive:true,firstFrameEpochUs:Number(frames[0][1]),lastFrameEpochUs:lastEpochUs,frameCount:frames.length,observedAtUtcMs:Date.now()}));
}
if(op==='stop'){
 try{process.kill(Number(fs.readFileSync(path.join(walk,'recorder.pid'))),'SIGINT')}catch(e){if(e.code!=='ESRCH')throw e}console.log('recorder SIGINT sent');
}
