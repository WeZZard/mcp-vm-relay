// Application-only source-frame to decoded-media mapping. Never transcodes originals.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
export type Frame={frame:number;sourceFrameEpochUs:number;sourcePtsExact:string;mediaSeconds:number;mediaPtsExact:string;mediaSecondsExact:string};
export function validateFrames(log:string,decoded:{best_effort_timestamp:string|number;best_effort_timestamp_time:string}[],duration:number):Frame[]{
 if(!/config in time_base: 1\/1000000,/.test(log))throw Error('Unsupported source time base');
 const source=[...log.matchAll(/n:\s*(\d+) pts:(\d+)/g)];
 if(source.length<2||source.length!==decoded.length)throw Error('Source/decoded frame count mismatch');
 const frames=source.map((m,i)=>({frame:Number(m[1]),sourceFrameEpochUs:Number(m[2]),sourcePtsExact:m[2]!,mediaSeconds:Number(decoded[i]!.best_effort_timestamp_time),mediaPtsExact:String(decoded[i]!.best_effort_timestamp),mediaSecondsExact:decoded[i]!.best_effort_timestamp_time}));
 for(let i=0;i<frames.length;i++){const f=frames[i]!,previous=frames[i-1];
  if(f.frame!==i||!Number.isSafeInteger(f.sourceFrameEpochUs)||!/^\d+$/.test(f.mediaPtsExact)||!Number.isFinite(f.mediaSeconds)||f.mediaSeconds<0||!(f.mediaSeconds<duration))throw Error('Invalid frame ordering/timestamp bounds');
  if(i===0&&(f.mediaSeconds!==0||BigInt(f.mediaPtsExact)!==0n))throw Error('First captured frame must define media zero');
  if(previous&&(f.sourceFrameEpochUs<=previous.sourceFrameEpochUs||f.mediaSeconds<=previous.mediaSeconds||BigInt(f.mediaPtsExact)<=BigInt(previous.mediaPtsExact)))throw Error('Nonmonotonic frame mapping');
 }
 return frames;
}
export function mapEventFrame(frames:Frame[],epochMs:number,mode:'preceding'|'following'='preceding'):Frame{
 const epochUs=epochMs*1000;
 if(!Number.isFinite(epochUs)||epochUs<frames[0]!.sourceFrameEpochUs||epochUs>frames.at(-1)!.sourceFrameEpochUs)throw Error('Event outside captured source-frame bounds');
 // Equality uses that frame. No interpolation, clock-offset assumption or clamping.
 const frame=mode==='preceding'?frames.findLast(f=>f.sourceFrameEpochUs<=epochUs):frames.find(f=>f.sourceFrameEpochUs>=epochUs);
 if(!frame)throw Error('Missing mapped frame');return frame;
}
export async function inspectRecording(video:string,logPath:string){
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',video],{encoding:'utf8'}));
 const stream=probe.streams.find((s:any)=>s.codec_type==='video'),duration=Number(probe.format.duration);
 if(!(duration>0)||stream.width!==3840||stream.height!==2160)throw Error('Unexpected media dimensions/duration');
 execFileSync('ffmpeg',['-v','error','-i',video,'-f','null','-'],{stdio:['ignore','ignore','pipe']});
 const decoded=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp,best_effort_timestamp_time','-of','json',video],{encoding:'utf8',maxBuffer:64*1024*1024})).frames;
 const frames=validateFrames(await readFile(logPath,'utf8'),decoded,duration);
 const maximumMappingErrorSeconds=Math.max(...frames.map(f=>Math.abs(f.mediaSeconds-(f.sourceFrameEpochUs-frames[0]!.sourceFrameEpochUs)/1e6)));
 return {stream,duration,frames,maximumMappingErrorSeconds,mappingErrorFormula:'max(abs(decodedMediaPtsSeconds - (sourceFrameEpochUs - firstCapturedFrameEpochUs) / 1e6))'};
}
