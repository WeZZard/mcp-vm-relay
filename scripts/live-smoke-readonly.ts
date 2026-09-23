// Application harness only. Not used by receiver, input, setup or recorder mutations.
export type ReadOnlyPurpose='identity-preflight'|'display-preflight'|'recorder-guard'|'media-observation'|'screenshot-observation'|'diagnostic-observation';
export async function readOnlyAuthRetry<T extends {rc:number;output:string}>(dispatch:()=>Promise<T>,purpose:ReadOnlyPurpose|undefined,onRefusal:(event:{purpose:ReadOnlyPurpose;attempt:number;retry:boolean;rc:number;output:string})=>Promise<void>):Promise<T>{
 for(let attempt=1;;attempt++){
  // Throws (including transport uncertainty) deliberately propagate without retry.
  const result=await dispatch();
  const refused=result.rc===255&&/Permission denied \(publickey,password\)\./.test(result.output);
  if(!purpose||!refused)return result;
  await onRefusal({purpose,attempt,retry:attempt<3,rc:result.rc,output:result.output});
  if(attempt===3)return result;
 }
}
