import {writeFileSync} from 'node:fs';
const evidence={node:process.version,kind:'Node native lock probes only; no store/browser'};
const key='synthetic-native-throw-probe';
try {await navigator.locks.request(key,()=>{throw Error('synthetic conflict')})}catch{}
evidence.afterSyncThrow=await navigator.locks.query();
evidence.reacquire=await Promise.race([navigator.locks.request(key,()=> 'acquired'),new Promise(r=>setTimeout(()=>r('timeout after 300ms'),300))]);
const entered=Promise.withResolvers(),release=Promise.withResolvers();
const abortKey='synthetic-native-abort-probe';
const holder=navigator.locks.request(abortKey,async()=>{entered.resolve();await release.promise});await entered.promise;
const controller=new AbortController();let called=false;
const queued=navigator.locks.request(abortKey,{signal:controller.signal},()=>{called=true}).catch(e=>e.name);
controller.abort();evidence.abortRejection=await queued;evidence.beforeRelease=await navigator.locks.query();
release.resolve();await holder;await new Promise(r=>setTimeout(r,50));
evidence.afterRelease={called,...await navigator.locks.query()};
const output=JSON.stringify(evidence,null,2)+'\n';writeFileSync(new URL('./result.json',import.meta.url),output);console.log(output);
