import { test } from 'node:test';
import assert from 'node:assert/strict';

const base=process.env.BASE_URL??'http://127.0.0.1:4200';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('These fixture tests only target localhost.');
if(process.env.ALLOW_FIXTURE_WRITES!=='1' || !process.env.ADMIN_PASSWORD) throw new Error('Run with ALLOW_FIXTURE_WRITES=1 and the local .env file. Tests create fixture branches.');
const alpha='11111111-1111-1111-1111-111111111111', beta='22222222-2222-2222-2222-222222222222';
const path=(tenant,suffix)=>`/api/tenants/${tenant}/${suffix}`;
class Client {
  cookies=new Map();
  async request(url,method='GET',body,csrf=true,extraHeaders={}) {
    const headers={...extraHeaders};
    if(this.cookies.size) headers.cookie=[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    if(csrf && this.cookies.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN']=decodeURIComponent(this.cookies.get('XSRF-TOKEN'));
    if(body!==undefined) headers['content-type']='application/json';
    const res=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});
    for(const c of res.headers.getSetCookie()) { const pair=c.split(';')[0]; const eq=pair.indexOf('='); const k=pair.slice(0,eq),v=pair.slice(eq+1); if(v)this.cookies.set(k,v);else this.cookies.delete(k); }
    const text=await res.text();
    let data; try {data=JSON.parse(text);} catch {data=text;}
    return {status:res.status,data,headers:res.headers};
  }
  async login(email) {
    assert.equal((await this.request('/api/auth/csrf')).status,204);
    const result=await this.request('/api/auth/login','POST',{email,password:process.env.ADMIN_PASSWORD});
    assert.equal(result.status,204,`Login failed for ${email}: ${result.status}`);
    assert.ok(result.headers.getSetCookie().some(c=>c.includes('CampusNexa.Session=')&&c.toLowerCase().includes('httponly')&&c.toLowerCase().includes('samesite=strict')));
    assert.equal((await this.request('/api/auth/csrf')).status,204);
  }
}

test('Phase 1 platform — real PostgreSQL and HTTP integration',async t=>{
  const admin=new Client(),other=new Client(),branch=new Client(),viewer=new Client(),anon=new Client();
  let mainBranch,secondBranch,created;
  const code=`T${Date.now().toString(36).toUpperCase()}`;
  await t.test('API liveness and database readiness',async()=>{
    const live=await anon.request('/health/live'); assert.equal(live.status,200); assert.equal(live.data.service,'CampusNexa API');
    const ready=await anon.request('/health/ready'); assert.equal(ready.status,200); assert.equal(ready.data.status,'ready');
  });
  await t.test('anonymous access denied and login requires CSRF',async()=>{
    assert.equal((await anon.request(path(alpha,'branches'))).status,401);
    assert.equal((await anon.request('/api/auth/login','POST',{email:'admin@campusnexa.test',password:process.env.ADMIN_PASSWORD},false)).status,400);
  });
  await t.test('four fixture roles sign in with protected cookies',async()=>{
    await admin.login('admin@campusnexa.test');await other.login('other@campusnexa.test');
    await branch.login('branch@campusnexa.test');await viewer.login('viewer@campusnexa.test');
  });
  await t.test('identity returns only the current user’s memberships',async()=>{
    const me=await admin.request('/api/auth/me');assert.equal(me.status,200);
    assert.deepEqual(me.data.memberships.map(x=>x.tenantId),[alpha]);
    const branches=await admin.request(path(alpha,'branches')); assert.equal(branches.status,200);
    mainBranch=branches.data.find(b=>b.code==='MAIN');secondBranch=branches.data.find(b=>b.code==='NORTH');
    assert.ok(mainBranch && secondBranch);
  });
  await t.test('cross-tenant reads and writes are denied for every scoped endpoint',async()=>{
    for(const endpoint of ['overview','branches','settings','members','audit','modules']) assert.equal((await admin.request(path(beta,endpoint))).status,404,endpoint);
    assert.equal((await admin.request(path(beta,'branches'),'POST',{name:'Forbidden',code:'NOPE'})).status,404);
    assert.equal((await other.request(path(alpha,'branches'))).status,404);
  });
  await t.test('forged tenant and role headers cannot widen access',async()=>{
    const result=await branch.request(path(alpha,'branches'),'GET',undefined,true,{'X-Tenant-ID':beta,'X-Role':'OrganizationAdmin'});
    assert.equal(result.status,200);assert.deepEqual(result.data.map(x=>x.id),[mainBranch.id]);
  });
  await t.test('branch-scoped reads exclude sibling branches',async()=>{
    assert.equal((await branch.request(path(alpha,`branches/${secondBranch.id}`))).status,404);
    assert.equal((await viewer.request(path(alpha,`branches/${secondBranch.id}/settings`))).status,404);
    const members=await branch.request(path(alpha,'members'));assert.equal(members.status,200);
    assert.ok(members.data.every(m=>m.branchId===mainBranch.id));
  });
  await t.test('branch administrator cannot create branches or alter organization defaults',async()=>{
    assert.equal((await branch.request(path(alpha,'branches'),'POST',{name:'Forbidden',code:'NOPE'})).status,403);
    assert.equal((await branch.request(path(alpha,'settings'),'PUT',{})).status,403);
    assert.equal((await branch.request(path(alpha,`branches/${secondBranch.id}/settings`),'PUT',{timeZone:null,locale:null,currency:null})).status,404);
  });
  await t.test('viewers cannot view member directory or modify settings',async()=>{
    assert.equal((await viewer.request(path(alpha,'members'))).status,403);
    assert.equal((await viewer.request(path(alpha,`branches/${mainBranch.id}/settings`),'PUT',{timeZone:null,locale:null,currency:null})).status,403);
  });
  await t.test('mutations reject missing CSRF token',async()=>{
    assert.equal((await admin.request(path(alpha,'branches'),'POST',{name:'Forbidden',code:'NOPE'},false)).status,400);
  });
  await t.test('branch validation, creation and duplicate detection',async()=>{
    assert.equal((await admin.request(path(alpha,'branches'),'POST',{name:' ',code:'!'})).status,400);
    const result=await admin.request(path(alpha,'branches'),'POST',{name:`Integration campus ${code}`,code,tenantId:beta});
    assert.equal(result.status,201);assert.equal(result.data.tenantId,alpha);created=result.data;
    assert.equal((await admin.request(path(alpha,'branches'),'POST',{name:'Duplicate',code})).status,409);
    assert.equal((await other.request(path(beta,`branches/${created.id}`))).status,404);
    assert.equal((await branch.request(path(alpha,`branches/${created.id}`))).status,404);
  });
  await t.test('branch codes are unique within a tenant, not globally',async()=>{
    const result=await other.request(path(beta,'branches'),'POST',{name:`Other fixture ${code}`,code});
    assert.equal(result.status,201);assert.equal(result.data.tenantId,beta);
  });
  await t.test('defaults inherit, overrides apply, and clearing restores inheritance',async()=>{
    const org=(await admin.request(path(alpha,'settings'))).data;
    const saved={timeZone:mainBranch.timeZoneOverride,locale:mainBranch.localeOverride,currency:mainBranch.currencyOverride};
    const url=path(alpha,`branches/${mainBranch.id}/settings`);
    const update=async values=>branch.request(url,'PUT',{...values,version:(await branch.request(url)).data.version});
    try {
      assert.equal((await update({timeZone:null,locale:null,currency:null})).status,200);
      let effective=(await branch.request(url)).data; assert.equal(effective.timeZone,org.timeZone);
      assert.equal((await update({timeZone:'Asia/Kolkata',locale:'en-IN',currency:'INR'})).status,200);
      effective=(await branch.request(url)).data;assert.equal(effective.currency,'INR');assert.equal(effective.timeZone,'Asia/Kolkata');
      assert.equal((await update({timeZone:'Not/AZone',locale:'en-IN',currency:'INR'})).status,400);
      assert.equal((await update({timeZone:null,locale:null,currency:null})).status,200);
      assert.equal((await branch.request(url)).data.currency,org.currency);
    } finally {assert.equal((await update(saved)).status,200);}
  });
  await t.test('organization preference changes remain isolated',async()=>{
    const current=(await admin.request(path(alpha,'settings'))).data;
    const otherBefore=(await other.request(path(beta,'settings'))).data;
    try {
      assert.equal((await admin.request(path(alpha,'settings'),'PUT',{...current,academicYearLabel:'Integration verification'})).status,200);
      assert.equal((await admin.request(path(alpha,'settings'))).data.academicYearLabel,'Integration verification');
      assert.deepEqual((await other.request(path(beta,'settings'))).data,otherBefore);
    } finally { assert.equal((await admin.request(path(alpha,'settings'),'PUT',{...current,version:(await admin.request(path(alpha,'settings'))).data.version})).status,200); }
  });
  await t.test('audit contains mutations but no other tenant or sibling-branch activity',async()=>{
    const audit=(await admin.request(path(alpha,'audit'))).data.items;
    assert.ok(audit.some(a=>a.action==='branch.created'&&a.subject===created.name));
    assert.ok(!audit.some(a=>a.subject===`Other fixture ${code}`));
    const branchAudit=(await branch.request(path(alpha,'audit'))).data.items;
    assert.ok(branchAudit.length>0);assert.ok(branchAudit.every(a=>a.branchId===mainBranch.id));
    assert.ok(branchAudit.some(a=>a.action==='branch.settings.updated'));
  });
  await t.test('disabled modules are enforced on the server',async()=>{
    const modules=(await admin.request(path(alpha,'modules'))).data;
    assert.equal(modules.find(m=>m.module==='platform').enabled,true);
    assert.equal(modules.find(m=>m.module==='academics').enabled,false);
    assert.equal((await admin.request(path(alpha,'academics'))).status,403);
  });
  await t.test('logout removes access',async()=>{
    assert.equal((await viewer.request('/api/auth/logout','POST')).status,204);
    assert.equal((await viewer.request('/api/auth/me')).status,401);
  });
  await t.test('session revocation invalidates another browser cookie',async()=>{
    const second=new Client();await second.login('other@campusnexa.test');
    assert.equal((await other.request('/api/auth/revoke-sessions','POST')).status,204);
    assert.equal((await second.request('/api/auth/me')).status,401);
  });
});
