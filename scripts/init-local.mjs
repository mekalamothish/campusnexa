import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target=fileURLToPath(new URL('../.env',import.meta.url));
const contents=`# Generated local secrets. Never commit this file.\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nADMIN_PASSWORD=Cn!${randomBytes(24).toString('hex')}\nWEB_PORT=4200\n`;
try { writeFileSync(target,contents,{flag:'wx',mode:0o600}); console.log('Created .env with random local credentials (permissions 600). See README for login accounts.'); }
catch(e) { if(e.code==='EEXIST') console.log('.env already exists; existing credentials were preserved.'); else throw e; }
