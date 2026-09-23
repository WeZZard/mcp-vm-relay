// Application-only exact-refusal retry policy. No receiver operation uses this.
import {isProvisioningCommand,type Provisioning} from './macos-smoke-provisioning.js';
export const desktopSession={session:'macos-consent',capture_scope:'desktop'} as const;
export const nativeSession={session:'macos-native',capture_scope:'window'} as const;
// Pixel coordinates come from the observed control; scope comes from our owned
// session, never from optional reviewer JSON (omission defaults to window).
export const closeSession={session:'macos-native-close',capture_scope:'desktop'} as const;
export function desktopClickArgs(x:number,y:number,session:string=desktopSession.session){return {x,y,scope:'desktop',session} as const;}
export function assertConsentDismissed(control:any){if(control.dialogDismissed!==true)throw Error('Consent dialog dismissal must be visually confirmed; completed dispatch is not visual success');}
export function assertSessionScope(value:any,session:string,scope:'desktop'|'window'){if(value.code||value.session!==session||value.capture_scope!==scope||value.effective_scope!==scope||scope==='desktop'&&value.desktop_unlocked!==true)throw Error('CUA session scope not established: '+JSON.stringify(value));}
export function assertCuaDispatch(stdout:string){const value=JSON.parse(stdout);if(value.code||value.isError===true||value.error)throw Error('CUA operation refused or failed: '+JSON.stringify(value));return value;}
export function isReadOnlyObservation(argv:string[],because:string):boolean {
 const binary=argv[0]?.endsWith('/cua-driver');
 return !!(binary&&((argv[1]==='permissions'&&argv[2]==='status')||(argv[1]==='call'&&['get_recording_state','get_desktop_state','list_windows','get_window_state','get_session_state'].includes(argv[2]!)))) || /^(Read |Discover |Locate |Verify daemon)/.test(because);
}
export async function observationCommand(argv:string[],because:string,exec:()=>Promise<{rc:number;output:string}>,onRefusal:(attempt:number,result:{rc:number;output:string})=>Promise<void>,wait:(ms:number)=>Promise<void>,provisioning?:Provisioning):Promise<string> {
 for(let attempt=1;;attempt++) {
  const result=await exec();if(result.rc===0)return result.output;
  if(!(isReadOnlyObservation(argv,because)||isProvisioningCommand(argv,provisioning))||attempt>=3||result.rc!==255||!/Permission denied \((?:publickey,)?password(?:,keyboard-interactive)?\)/.test(result.output))throw Error(`Guest harness rc=${result.rc}: ${result.output}`);
  await onRefusal(attempt,result);await wait(attempt*250);
 }
}
