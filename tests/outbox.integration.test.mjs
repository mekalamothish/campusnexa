import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {waitForMail} from './mail-helper.mjs';
const base='http://127.0.0.1:4200',inbox='http://127.0.0.1:8025';
if(process.env.ALLOW_FIXTURE_WRITES!=='1'||!process.env.ADMIN_PASSWORD)throw new Error('Use the local fixture environment.');
const docker=(args)=>execFileSync('docker',['compose',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=q=>docker(['exec','-T','db','psql','-U','campusnexa','-d','campusnexa','-v','ON_ERROR_STOP=1','-Atc',q]).trim();
class Client {
 cookies=new Map();
 async call(path,body){const headers={cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
  if(this.cookies.has('XSRF-TOKEN'))headers['X-XSRF-TOKEN']=decodeURIComponent(this.cookies.get('XSRF-TOKEN'));
  if(body!==undefined)headers['content-type']='application/json';
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  for(const c of r.headers.getSetCookie()){const p=c.split(';')[0],i=p.indexOf('=');this.cookies.set(p.slice(0,i),p.slice(i+1));}
  let data;try{data=await r.json();}catch{}return{status:r.status,data};
 }
 async csrf(){await this.call('/api/auth/csrf');}
 async login(email,password=process.env.ADMIN_PASSWORD){await this.csrf();assert.equal((await this.call('/api/auth/login',{email,password})).status,204);await this.csrf();}
}
const run=promisify(execFile);
async function dispatch(id,fail=false){await run('docker',['compose',...(fail?['-f','compose.yaml','-f','tests/compose.mail-unavailable.yaml']:[]),'run','--rm','--no-deps','-e',`Mail__MessageId=${id}`,'api','--mail-dispatch-once'],{timeout:30000,maxBuffer:1024*1024});}
const state=id=>JSON.parse(sql(`SELECT row_to_json(m) FROM "MailQueue" m WHERE "Id"='${id}'`));

test('Durable local mail queue',async t=>{
 const admin=new Client();await admin.login('admin@campusnexa.test');
 const tenant='11111111-1111-1111-1111-111111111111',suffix=Date.now().toString(36);
 const branch=(await admin.call(`/api/tenants/${tenant}/branches`)).data.find(b=>b.code==='MAIN').id;
 let seq=0;
 const create=async()=>{const email=`outbox-${suffix}-${seq++}@campusnexa.test`;const r=await admin.call(`/api/tenants/${tenant}/invitations`,{email,role:'Viewer',branchId:branch});assert.equal(r.status,201);const id=sql(`SELECT "Id" FROM "MailQueue" WHERE "InvitationId"='${r.data.id}'`);assert.ok(id);return{email,invitation:r.data.id,id};};
 docker(['stop','worker']);
 t.after(()=>docker(['up','-d','--no-deps','worker']));
 const first=await create();
 await t.test('request persists encrypted payload and exposes no queue endpoint',async()=>{
  const s=state(first.id);assert.equal(s.Status,'Pending');assert.equal(s.Attempts,0);assert.ok(s.Payload.length>100);assert.ok(!s.Payload.includes(first.email));assert.ok(!s.Payload.includes('#invite='));
  assert.equal((await admin.call('/api/mail-queue')).status,404);
  assert.equal((await admin.call(`/api/tenants/${tenant}/mail-queue`)).status,404);
  const list=(await admin.call(`/api/tenants/${tenant}/invitations`)).data;assert.ok(!JSON.stringify(list).includes(s.Payload));
  assert.throws(()=>sql(`BEGIN; UPDATE "MailQueue" SET "TenantId"='22222222-2222-2222-2222-222222222222' WHERE "Id"='${first.id}'; ROLLBACK;`));
  assert.equal(state(first.id).TenantId,tenant);
 });
 await t.test('SMTP outage schedules retry and preserves committed invitation',async()=>{
  await dispatch(first.id,true);const s=state(first.id);assert.equal(s.Status,'Pending');assert.equal(s.Attempts,1);assert.equal(s.LastError,'DeliveryFailed');assert.ok(Date.parse(s.AvailableAt)>Date.now());assert.ok(s.Payload.length>100);
  assert.equal(sql(`SELECT "RevokedAt" IS NULL FROM "Invitations" WHERE "Id"='${first.invitation}'`),'t');
 });
 await t.test('fresh competing dispatchers send one copy and erase the payload',async()=>{
  sql(`UPDATE "MailQueue" SET "AvailableAt"=now() WHERE "Id"='${first.id}'`);
  await Promise.all([dispatch(first.id),dispatch(first.id)]);
  assert.equal(state(first.id).Status,'Sent');assert.equal(state(first.id).Attempts,2);assert.equal(state(first.id).Payload,'');
  await dispatch(first.id);
  const list=await(await fetch(inbox+'/api/v1/messages?limit=200')).json();assert.equal(list.messages.filter(m=>m.To.some(to=>to.Address===first.email)).length,1);
 });
 await t.test('revoked and expired jobs are suppressed',async()=>{
  const revoked=await create();assert.equal((await admin.call(`/api/tenants/${tenant}/invitations/${revoked.invitation}/revoke`,{})).status,204);
  await dispatch(revoked.id);assert.equal(state(revoked.id).Status,'Cancelled');assert.equal(state(revoked.id).Payload,'');
  const expired=await create();sql(`UPDATE "MailQueue" SET "ExpiresAt"=now()-interval '1 second' WHERE "Id"='${expired.id}'`);
  await dispatch(expired.id);assert.equal(state(expired.id).Status,'Expired');assert.equal(state(expired.id).Attempts,0);
 });
 await t.test('ciphertext copied between messages fails closed and can be replaced safely',async()=>{
  const a=await create(),b=await create();
  sql(`UPDATE "MailQueue" SET "Payload"=(SELECT "Payload" FROM "MailQueue" WHERE "Id"='${a.id}') WHERE "Id"='${b.id}'`);
  await dispatch(b.id);assert.equal(state(b.id).Status,'Dead');assert.equal(state(b.id).LastError,'PayloadUnavailable');assert.equal(state(b.id).Payload,'');
  const replacement=await admin.call(`/api/tenants/${tenant}/invitations/${b.invitation}/retry-delivery`,{});assert.equal(replacement.status,201);
  const replacementJob=sql(`SELECT "Id" FROM "MailQueue" WHERE "InvitationId"='${replacement.data.id}'`);
  await dispatch(replacementJob);assert.equal(state(replacementJob).Status,'Sent');assert.equal(state(b.id).Status,'Dead');
  assert.equal(sql(`SELECT "RevokedAt" IS NOT NULL FROM "Invitations" WHERE "Id"='${b.invitation}'`),'t');
  await admin.call(`/api/tenants/${tenant}/invitations/${a.invitation}/revoke`,{});await dispatch(a.id);
 });
 const founder=new Client();await founder.csrf();
 const inviteMail=await waitForMail(inbox,first.email,'Your CampusNexa invitation');const token=inviteMail.Text.match(/#invite=([A-F0-9]{64})/)[1];
 assert.equal((await founder.call('/api/invitations/accept',{token,displayName:'Outbox Fixture',password:'OutboxPassword!4680'})).status,200);
 await founder.login(first.email,'OutboxPassword!4680');const user=(await founder.call('/api/auth/me')).data.id;
 const recovery=async()=>{assert.equal((await founder.call('/api/auth/forgot-password',{email:first.email})).status,200);return sql(`SELECT "Id" FROM "MailQueue" WHERE "UserId"='${user}' ORDER BY "CreatedAt" DESC LIMIT 1`);};
 await t.test('terminal recovery failure is bounded, redacted and audited',async()=>{
  const id=await recovery();
  for(let n=0;n<5;n++){sql(`UPDATE "MailQueue" SET "AvailableAt"=now() WHERE "Id"='${id}'`);await dispatch(id,true);}
  assert.equal(state(id).Status,'Dead');assert.equal(state(id).Attempts,5);assert.equal(state(id).Payload,'');
  const events=(await founder.call('/api/auth/security-events')).data;assert.equal(events.filter(e=>e.action==='RecoveryDeliveryFailed').length,1);
 });
 await t.test('session revocation invalidates queued recovery and worker restart drains a pending job',async()=>{
  const id=await recovery();assert.equal((await founder.call('/api/auth/revoke-sessions',{})).status,204);await dispatch(id);assert.equal(state(id).Status,'Cancelled');
  const pending=await create();docker(['up','-d','--no-deps','worker']);await waitForMail(inbox,pending.email,'Your CampusNexa invitation');
  // Delivery can arrive just before the worker commits its success marker.
  for(let n=0;n<30&&state(pending.id).Status!=='Sent';n++)await new Promise(r=>setTimeout(r,100));
  assert.equal(state(pending.id).Status,'Sent');
 });
});
