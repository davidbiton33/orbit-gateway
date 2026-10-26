const url='http://127.0.0.1:4984/health';
try{
 const res=await fetch(url,{headers:{authorization:'Bearer '+process.env.GATEWAY_TOKEN},signal:AbortSignal.timeout(3500)});
 if(!res.ok)process.exitCode=1;
}catch(e){console.error('healthcheck:',e.message);process.exitCode=1;}
