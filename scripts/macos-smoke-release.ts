// Application-owned destruction barrier: failed evidence retention is sticky.
// Manager retries must not replay recorder or uncertain cleanup operations.
export class ReleasePreparation {
 private promise?:Promise<void>;
 prepare(action:()=>Promise<void>):Promise<void>{return this.promise??=Promise.resolve().then(action);}
}
