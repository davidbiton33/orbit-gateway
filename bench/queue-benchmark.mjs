import {ProviderQueue} from '../src/lib/provider-queue.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const q=new ProviderQueue({limit:20,waitMs:4000});
const active={gpt:0,gemini:0,aimode:0},peaks={...active},started=performance.now();
const providers=['gpt','gemini','aimode'];
const tasks=providers.flatMap(p=>Array.from({length:10},()=>q.run(p,async()=>{
 active[p]++;peaks[p]=Math.max(peaks[p],active[p]);
 await wait(35);active[p]--;
 return p;
})));
const done=await Promise.all(tasks);
const elapsed=Math.round(performance.now()-started);
console.log('BENCH_QUEUE',JSON.stringify({requests:done.length,elapsed_ms:elapsed,throughput_rps:+(done.length/(elapsed/1000)).toFixed(2),peak_active_per_provider:peaks,stats:q.snapshot()}));
const overloaded=new ProviderQueue({limit:3,waitMs:4000});
const batch=Array.from({length:15},()=>overloaded.run('gpt',()=>wait(50)).then(()=>true,()=>false));
const results=await Promise.all(batch);
console.log('BENCH_OVERLOAD',JSON.stringify({requests:15,accepted:results.filter(Boolean).length,rejected:results.filter(x=>!x).length,stats:overloaded.snapshot().gpt}));
