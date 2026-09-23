// Fixed-purpose application setup for this task's disposable guest only.
export function configureGdmText(source:string):string{
 const newline=source.includes('\r\n')?'\r\n':'\n';const lines=source.split(/\r?\n/);let inDaemon=false,foundDaemon=false,written=false;const result:string[]=[];
 for(const line of lines){const section=line.match(/^\s*\[([^\]]+)\]\s*$/);if(section){if(inDaemon&&!written){result.push('WaylandEnable=false');written=true;}inDaemon=section[1]==='daemon';if(inDaemon)foundDaemon=true;}
  if(inDaemon&&/^\s*#?\s*WaylandEnable\s*=/.test(line)){if(!written){result.push('WaylandEnable=false');written=true;}continue;}result.push(line);
 }
 if(!foundDaemon)throw Error('Missing GDM daemon section');if(inDaemon&&!written)result.push('WaylandEnable=false');return result.join(newline);
}
export function configArgv(){return ['sudo','/usr/bin/node','-e',`${configureGdmText.toString()};const fs=require('fs'),p='/etc/gdm3/custom.conf';const before=fs.readFileSync(p,'utf8'),after=configureGdmText(before);if(after!==before)fs.writeFileSync(p,after);console.log(JSON.stringify({path:p,changed:after!==before,desired:'WaylandEnable=false'}));`];}
export async function configureCloneX11<T extends {rc:number;output:string}>(dispatch:(argv:string[])=>Promise<T>,audit:(event:{attempt:number;retry:boolean;rc:number;output:string})=>Promise<void>):Promise<T>{
 for(let attempt=1;;attempt++){const result=await dispatch(configArgv());const refused=result.rc===255&&/^[^\r\n]+: Permission denied \(publickey,password\)\.\r?\n?$/.test(result.output);if(!refused)return result;await audit({attempt,retry:attempt<3,rc:result.rc,output:result.output});if(attempt===3)return result;}
}
