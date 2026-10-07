import {expect, type APIRequestContext} from '@playwright/test';
const consumed = new Set<string>();
export async function waitForMail(request:APIRequestContext,inbox:string,email:string,subject:string) {
  let item: {ID:string}|undefined;
  await expect.poll(async()=>{
    const list=await(await request.get(inbox+'/api/v1/messages?limit=200')).json();
    item=list.messages.find((m:{ID:string;Subject:string;To:{Address:string}[]})=>!consumed.has(m.ID)&&m.Subject===subject&&m.To.some(t=>t.Address===email));
    return !!item;
  },{timeout:15000}).toBe(true);
  consumed.add(item!.ID);
  return (await request.get(inbox+'/api/v1/message/'+item!.ID)).json();
}
