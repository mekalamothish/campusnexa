import {test} from 'node:test';
import {waitForMail} from './mail-helper.mjs';
import assert from 'node:assert/strict';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
const base='http://127.0.0.1:4200', inbox='http://127.0.0.1:8025';
if(process.env.ALLOW_FIXTURE_WRITES!=='1'||!process.env.ADMIN_PASSWORD)throw new Error('Load .env and set ALLOW_FIXTURE_WRITES=1.');
const alpha='11111111-1111-1111-1111-111111111111',beta='22222222-2222-2222-2222-222222222222';
const url=(id,part='invitations')=>`/api/tenants/${id}/${part}`;
class Client{
 cookies=new Map();
 async request(path,method='GET',body,csrf=true){const headers={cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
 if(csrf&&this.cookies.has('XSRF-TOKEN'))headers['X-XSRF-TOKEN']=decodeURIComponent(this.cookies.get('XSRF-TOKEN'));
 if(body!==undefined)headers['content-type']='application/json';
 const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],n=pair.indexOf('=');this.cookies.set(pair.slice(0,n),pair.slice(n+1));}
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:r.status,data};}
 async csrf(){assert.equal((await this.request('/api/auth/csrf')).status,204);}
 async login(email,password=process.env.ADMIN_PASSWORD){await this.csrf();assert.equal((await this.request('/api/auth/login','POST',{email,password})).status,204);await this.csrf();}
}
async function tokenFor(email){const mail=await waitForMail(inbox,email,'Your CampusNexa invitation');const token=mail.Text.match(/#invite=([A-F0-9]{64})/)?.[1];assert.ok(token);return token;}
const sql=q=>execFileSync('docker',['compose','exec','-T','db','psql','-U','campusnexa','-d','campusnexa','-v','ON_ERROR_STOP=1','-Atc',q],{encoding:'utf8'}).trim();

test('Invitation lifecycle and local school onboarding',async t=>{
 const admin=new Client(),other=new Client(),branch=new Client(),anon=new Client();
 await admin.login('admin@campusnexa.test');await other.login('other@campusnexa.test');await branch.login('branch@campusnexa.test');await anon.csrf();
 const main=(await admin.request(url(alpha,'branches'))).data.find(b=>b.code==='MAIN');
 const foreign=(await other.request(url(beta,'branches'))).data[0];
 const suffix=Date.now().toString(36), email=`invite-${suffix}@campusnexa.test`;let id,token;
 const input={email,role:'Viewer',branchId:main.id};
 await t.test('tenant, role, branch and CSRF boundaries',async()=>{
  assert.equal((await anon.request(url(alpha))).status,401);
  assert.equal((await branch.request(url(alpha))).status,403);
  assert.equal((await branch.request(url(alpha),'POST',input)).status,403);
  assert.equal((await other.request(url(alpha),'POST',input)).status,404);
  assert.equal((await admin.request(url(alpha),'POST',{...input,branchId:foreign.id})).status,404);
  assert.equal((await admin.request(url(alpha),'POST',{...input,role:'RootAdmin'})).status,400);
  assert.equal((await admin.request(url(alpha),'POST',{...input,role:'OrganizationAdmin'})).status,400);
  assert.equal((await admin.request(url(alpha),'POST',input,false)).status,400);
 });
 await t.test('issue email, reject duplicate, redact token from API',async()=>{
  const r=await admin.request(url(alpha),'POST',input);assert.equal(r.status,201);id=r.data.id;token=await tokenFor(email);
  assert.equal((await admin.request(url(alpha),'POST',input)).status,409);
  const list=(await admin.request(url(alpha))).data.items;assert.ok(list.some(i=>i.id===id));assert.ok(!JSON.stringify(list).includes(token));assert.ok(!JSON.stringify(list).includes('tokenHash'));
  assert.ok(!JSON.stringify((await other.request(url(beta))).data).includes(email));
  assert.equal(sql(`SELECT length("TokenHash") FROM "Invitations" WHERE "Id"='${id}'`),'64');
  assert.notEqual(sql(`SELECT "TokenHash" FROM "Invitations" WHERE "Id"='${id}'`),token);
 });
 await t.test('invalid token and weak password cannot create account',async()=>{
  assert.equal((await anon.request('/api/invitations/preview','POST',{token:'INVALID'})).status,400);
  assert.equal((await anon.request('/api/invitations/preview','POST',{token},false)).status,400);
  const preview=(await anon.request('/api/invitations/preview','POST',{token})).data;assert.equal(preview.email,email);assert.equal(preview.requiresSignIn,false);
  assert.equal((await anon.request('/api/invitations/accept','POST',{token,displayName:'Invite Test',password:'weak'})).status,400);
 });
 await t.test('accept once, verify email, preserve invited role and branch',async()=>{
  const password='InvitationTest!48276';
  assert.equal((await anon.request('/api/invitations/accept','POST',{token,displayName:'Invite Test',password,role:'OrganizationAdmin',tenantId:beta})).status,200);
  assert.equal((await anon.request('/api/invitations/accept','POST',{token,displayName:'Replay',password})).status,400);
  assert.equal((await anon.request('/api/invitations/preview','POST',{token})).status,400);
  await anon.login(email,password);const me=(await anon.request('/api/auth/me')).data;
  assert.deepEqual(me.memberships.map(m=>[m.tenantId,m.role,m.branchId]),[[alpha,'Viewer',main.id]]);
  assert.equal((await anon.request(url(beta,'branches'))).status,404);
  assert.equal((await admin.request(url(alpha)+`/${id}/revoke`,'POST')).status,409);
 });
 await t.test('revoke is scoped, idempotent and invalidates the link',async()=>{
  const revEmail=`revoked-${suffix}@campusnexa.test`;const r=await admin.request(url(alpha),'POST',{...input,email:revEmail});assert.equal(r.status,201);
  const secret=await tokenFor(revEmail);const revoke=url(alpha)+`/${r.data.id}/revoke`;
  assert.equal((await other.request(revoke,'POST')).status,404);assert.equal((await branch.request(revoke,'POST')).status,403);
  assert.equal((await admin.request(revoke,'POST')).status,204);assert.equal((await admin.request(revoke,'POST')).status,204);
  assert.equal((await anon.request('/api/invitations/preview','POST',{token:secret})).status,400);
 });
 await t.test('expired invitation is rejected and can be replaced',async()=>{
  const expEmail=`expired-${suffix}@campusnexa.test`;const r=await admin.request(url(alpha),'POST',{...input,email:expEmail});assert.equal(r.status,201);const secret=await tokenFor(expEmail);
  sql(`UPDATE "Invitations" SET "ExpiresAt"=now()-interval '1 second' WHERE "Id"='${r.data.id}'`);
  assert.equal((await anon.request('/api/invitations/preview','POST',{token:secret})).status,400);
  assert.equal((await admin.request(url(alpha),'POST',{...input,email:expEmail})).status,201);
 });
 await t.test('existing account must authenticate and never has password replaced',async()=>{
  const r=await other.request(url(beta),'POST',{email,role:'BranchAdmin',branchId:foreign.id});assert.equal(r.status,201);const secret=await tokenFor(email);
  const fresh=new Client();await fresh.csrf();assert.equal((await fresh.request('/api/invitations/accept','POST',{token:secret,password:'HijackPassword!567'})).status,403);
  assert.equal((await admin.request('/api/invitations/accept','POST',{token:secret})).status,403);
  assert.equal((await anon.request('/api/invitations/accept','POST',{token:secret,password:'IgnoredPassword!'})).status,200);
  await fresh.login(email,'InvitationTest!48276');assert.equal((await fresh.request('/api/auth/me')).data.memberships.length,2);
 });
 await t.test('concurrent acceptance creates only one membership',async()=>{
  const raceEmail=`race-${suffix}@campusnexa.test`;assert.equal((await admin.request(url(alpha),'POST',{...input,email:raceEmail})).status,201);const secret=await tokenFor(raceEmail);
  const a=new Client(),b=new Client();await a.csrf();await b.csrf();const body={token:secret,displayName:'Race Test',password:'RaceTestPassword!345'};
  const result=await Promise.all([a.request('/api/invitations/accept','POST',body),b.request('/api/invitations/accept','POST',body)]);
  assert.equal(result.filter(r=>r.status===200).length,1);assert.ok(result.every(r=>[200,400,409].includes(r.status)));
 });
 await t.test('server-side onboarding creates a school and initial administrator invite',async()=>{
  const schoolEmail=`founder-${suffix}@campusnexa.test`;
  execFileSync('docker',['compose','run','--rm','--no-deps','-e',`Onboard__Name=Test Academy ${suffix}`,'-e',`Onboard__Slug=test-${suffix}`,'-e',`Onboard__Email=${schoolEmail}`,'api','--onboard'],{stdio:['ignore','pipe','pipe']});
  const secret=await tokenFor(schoolEmail),newAdmin=new Client();await newAdmin.csrf();
  const onboardId=sql(`SELECT "Id" FROM "Organizations" WHERE "Slug"='test-${suffix}'`);
  try {
   sql(`UPDATE "Organizations" SET "IsActive"=false WHERE "Id"='${onboardId}'`);
   assert.equal((await newAdmin.request('/api/invitations/preview','POST',{token:secret})).status,400);
  } finally {sql(`UPDATE "Organizations" SET "IsActive"=true WHERE "Id"='${onboardId}'`);}
  try {
   sql(`UPDATE "Entitlements" SET "Enabled"=false WHERE "TenantId"='${onboardId}' AND "Module"='platform'`);
   assert.equal((await newAdmin.request('/api/invitations/accept','POST',{token:secret,displayName:'Blocked',password:'NewSchoolPassword!123'})).status,400);
  } finally {sql(`UPDATE "Entitlements" SET "Enabled"=true WHERE "TenantId"='${onboardId}' AND "Module"='platform'`);}
  assert.equal((await newAdmin.request('/api/invitations/accept','POST',{token:secret,displayName:'New School Admin',password:'NewSchoolPassword!123'})).status,200);
  await newAdmin.login(schoolEmail,'NewSchoolPassword!123');const membership=(await newAdmin.request('/api/auth/me')).data.memberships[0];assert.equal(membership.role,'OrganizationAdmin');assert.notEqual(membership.tenantId,alpha);
  assert.equal((await newAdmin.request(url(membership.tenantId,'branches'))).data.length,1);assert.equal((await admin.request(url(membership.tenantId,'branches'))).status,404);
 });
 await t.test('trusted local operator recovers an expired bootstrap invitation',async st=>{
  const slug=`bootstrap-${suffix}`,founder=`bootstrap-${suffix}@campusnexa.test`;
  const cli=async(command,env={},options=[])=>{
   try{const result=await promisify(execFile)('docker',['compose','run','--rm','--no-deps',...options,...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),'api',command],{timeout:30000,maxBuffer:1024*1024});return {ok:true,output:result.stdout};}
   catch(e){if(e.killed||e.signal||typeof e.code!=='number')throw new Error('Operator command did not complete normally; this is not an expected refusal.');return {ok:false,output:String(e.stdout??'')+String(e.stderr??'')};}
  };
  assert.equal((await cli('--onboard',{'Onboard__Name':'Bootstrap Test','Onboard__Slug':slug,'Onboard__Email':founder})).ok,true);
  const org=sql(`SELECT "Id" FROM "Organizations" WHERE "Slug"='${slug}'`);
  const original=sql(`SELECT "Id" FROM "Invitations" WHERE "TenantId"='${org}'`),oldToken=await tokenFor(founder);
  const env={'Bootstrap__Slug':slug,'Bootstrap__InvitationId':original};
  const count=()=>sql(`SELECT count(*) FROM "Invitations" WHERE "TenantId"='${org}'`);
  const inspect=async()=>{const r=await cli('--bootstrap-status',{'Bootstrap__Slug':slug});assert.equal(r.ok,true);return JSON.parse(r.output.split('\n').find(l=>l.startsWith('{')));};
  await st.test('status is read-only and refuses an unexpired link',async()=>{
   const state=await inspect();assert.equal(state.invitationId,original);assert.equal(state.eligible,false);assert.equal(state.email,founder);
   assert.ok(!JSON.stringify(state).includes(oldToken));assert.ok(!JSON.stringify(state).includes('tokenHash'));
   assert.equal((await cli('--reissue-bootstrap',env)).ok,false);assert.equal(count(),'1');
   sql(`UPDATE "Invitations" SET "ExpiresAt"=now()-interval '1 second' WHERE "Id"='${original}'`);
   assert.equal((await inspect()).eligible,true);
  });
  await st.test('production, disabled mail and foreign invitation IDs are refused',async()=>{
   for(const override of [{'ASPNETCORE_ENVIRONMENT':'Production'},{'Invitations__LocalMailEnabled':'false'},{'Bootstrap__InvitationId':id},{'Bootstrap__Slug':'missing-'+suffix}])
    assert.equal((await cli('--reissue-bootstrap',{...env,...override})).ok,false);
   assert.equal(count(),'1');
   assert.equal((await admin.request(`/api/tenants/${org}/invitations`)).status,404);
   assert.equal((await admin.request('/api/reissue-bootstrap','POST',env)).status,404);
  });
  await st.test('inactive school and disabled platform cannot be recovered',async()=>{
   try {sql(`UPDATE "Organizations" SET "IsActive"=false WHERE "Id"='${org}'`);assert.equal((await cli('--reissue-bootstrap',env)).ok,false);}
   finally {sql(`UPDATE "Organizations" SET "IsActive"=true WHERE "Id"='${org}'`);}
   try {sql(`UPDATE "Entitlements" SET "Enabled"=false WHERE "TenantId"='${org}' AND "Module"='platform'`);assert.equal((await cli('--reissue-bootstrap',env)).ok,false);}
   finally {sql(`UPDATE "Entitlements" SET "Enabled"=true WHERE "TenantId"='${org}' AND "Module"='platform'`);}
   assert.equal(count(),'1');
  });
  await st.test('queue write failure rolls back revocation, replacement and audit',async()=>{
   const fn=`bootstrap_fail_${suffix}`;
   sql(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."TenantId"='${org}' THEN RAISE EXCEPTION 'Test queue failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON "MailQueue" FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
   try {const r=await cli('--reissue-bootstrap',env);assert.equal(r.ok,false);}
   finally {sql(`DROP TRIGGER ${fn} ON "MailQueue"; DROP FUNCTION ${fn}();`);}
   assert.equal(count(),'1');assert.equal(sql(`SELECT "RevokedAt" IS NULL FROM "Invitations" WHERE "Id"='${original}'`),'t');
   assert.equal(sql(`SELECT count(*) FROM "AuditEvents" WHERE "TenantId"='${org}' AND "Action"='invitation.bootstrap-reissued'`),'0');
  });
  let replacement,secret;
  await st.test('concurrent recovery has one winner and preserves recipient and scope',async()=>{
   const result=await Promise.all([cli('--reissue-bootstrap',env),cli('--reissue-bootstrap',env)]);assert.equal(result.filter(r=>r.ok).length,1);
   assert.equal(count(),'2');assert.equal(sql(`SELECT "RevokedAt" IS NOT NULL FROM "Invitations" WHERE "Id"='${original}'`),'t');
   replacement=sql(`SELECT "Id" FROM "Invitations" WHERE "TenantId"='${org}' AND "RevokedAt" IS NULL`);secret=await tokenFor(founder);assert.notEqual(secret,oldToken);
   assert.equal(sql(`SELECT "Email" || '|' || "Role" || '|' || ("BranchId" IS NULL)::text FROM "Invitations" WHERE "Id"='${replacement}'`),`${founder}|OrganizationAdmin|true`);
   assert.ok(!result.find(r=>r.ok).output.includes(secret));
   assert.equal((await cli('--reissue-bootstrap',env)).ok,false);
   const guest=new Client();await guest.csrf();assert.equal((await guest.request('/api/invitations/preview','POST',{token:oldToken})).status,400);
  });
  await st.test('a recovered link grants only its school and closes bootstrap recovery',async()=>{
   const guest=new Client();await guest.csrf();const password='BootstrapTestPassword!4680';
   assert.equal((await guest.request('/api/invitations/accept','POST',{token:secret,displayName:'Recovered Founder',password})).status,200);
   await guest.login(founder,password);const memberships=(await guest.request('/api/auth/me')).data.memberships;
   assert.deepEqual(memberships.map(m=>[m.tenantId,m.role,m.branchId]),[[org,'OrganizationAdmin',null]]);
   assert.equal((await guest.request(url(alpha,'branches'))).status,404);
   const events=(await guest.request(url(org,'audit'))).data.items;const event=events.find(e=>e.action==='invitation.bootstrap-reissued');assert.ok(event);assert.ok(event.subject.includes(original)&&event.subject.includes(replacement));assert.ok(!JSON.stringify(events).includes(secret));
   assert.equal((await inspect()).eligible,false);assert.equal((await cli('--reissue-bootstrap',{'Bootstrap__Slug':slug,'Bootstrap__InvitationId':replacement})).ok,false);
  });
 });
});
