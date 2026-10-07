import {setTimeout as delay} from 'node:timers/promises';
const consumed = new Set();
export async function waitForMail(inbox, email, subject) {
  for (let n=0;n<100;n++) {
    const list=await (await fetch(inbox+'/api/v1/messages?limit=200')).json();
    const item=list.messages.find(m=>!consumed.has(m.ID)&&m.To.some(t=>t.Address===email)&&m.Subject===subject);
    if(item){consumed.add(item.ID);return (await fetch(inbox+'/api/v1/message/'+item.ID)).json();}
    await delay(150);
  }
  throw new Error('Queued test email did not arrive within 15 seconds.');
}
