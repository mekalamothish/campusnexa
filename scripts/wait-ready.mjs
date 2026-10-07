const base=process.env.BASE_URL??'http://127.0.0.1:4200';
const end=Date.now()+90000;
while(Date.now()<end) {
  try { const r=await fetch(base+'/health/ready',{signal:AbortSignal.timeout(3000)}); if(r.ok && (await r.json()).status==='ready') {console.log('CampusNexa is ready.');process.exit(0);} }
  catch { /* service startup may still be in progress */ }
  await new Promise(resolve=>setTimeout(resolve,1000));
}
console.error('Readiness timed out. Inspect docker compose ps -a and service logs.'); process.exit(1);
