import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'backups'); mkdirSync(directory,{recursive:true,mode:0o700});
const name=`campusnexa-${new Date().toISOString().replaceAll(':','-')}-${randomBytes(3).toString('hex')}.dump`;
const path=join(directory,name);
const child=spawn('docker',['compose','exec','-T','db','pg_dump','-U','campusnexa','-d','campusnexa','-Fc','--no-owner','--no-acl'],{cwd:root,stdio:['ignore','pipe','inherit']});
const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`pg_dump exited ${code}; do not use partial file ${path}`)));});
await Promise.all([pipeline(child.stdout,createWriteStream(path,{flags:'wx',mode:0o600})),done]);
const hash=createHash('sha256');for await(const chunk of createReadStream(path)) hash.update(chunk);
writeFileSync(path+'.json',JSON.stringify({formatVersion:1,database:'campusnexa',createdAt:new Date().toISOString(),sha256:hash.digest('hex')},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`Backup created: ${path}`);
console.log('Sensitive data: store encrypted off-device before treating this as a durable backup.');
