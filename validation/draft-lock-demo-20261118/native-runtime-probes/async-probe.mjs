import {writeFileSync} from 'node:fs';
const key='synthetic-native-async-throw-probe';
try{await navigator.locks.request(key,async()=>{throw Error('synthetic conflict')})}catch{}
const result={node:process.version,afterThrow:await navigator.locks.query(),reacquire:await navigator.locks.request(key,()=> 'reacquired')};
const text=JSON.stringify(result,null,2)+'\n';writeFileSync(new URL('./async-result.json',import.meta.url),text);console.log(text);
