import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { privatePath, receiveUpload } from './storage.js';

const root='https://www.nytimes.com/newsgraphics/polls/';
export const nytRefreshSources=Object.freeze([
  {label:'Presidential approval polls',filename:'president-approval.csv',url:`${root}approval/president.csv`},
  {label:'Presidential approval averages',filename:'president-averages.csv',url:`${root}approval/president-averages.csv`},
  {label:'2028 presidential polls',filename:'president.csv',url:`${root}president.csv`},
  {label:'2026 Senate polls',filename:'senate.csv',url:`${root}senate.csv`},
  {label:'2026 House polls',filename:'house.csv',url:`${root}house.csv`},
  {label:'2026 governor polls',filename:'governor.csv',url:`${root}governor.csv`}
]);

// Only jobs created from the fixed catalog can ask the worker to download.
export async function downloadNytRefresh(job,{fetchImpl=fetch}={}) {
  const source=nytRefreshSources.find(item=>item.filename===job.filename&&item.url===job.source_url);
  if(!source || !job.auto_publish || !job.refresh_batch_id) throw new Error('Unrecognized NYT refresh source');
  let url=source.url,response;
  const signal=AbortSignal.timeout(120000);
  try {
    for(let redirects=0;redirects<=3;redirects++) {
      response=await fetchImpl(url,{redirect:'manual',signal,headers:{Accept:'text/csv, application/octet-stream;q=0.9'}});
      if(![301,302,303,307,308].includes(response.status)) break;
      if(redirects===3) throw new Error('too many redirects');
      const next=new URL(response.headers.get('location')||'',url);
      if(next.protocol!=='https:' || !['www.nytimes.com','static01.nyt.com'].includes(next.hostname)) throw new Error('download redirected outside approved NYT hosts');
      url=next.href;
      await response.body?.cancel();
    }
    if(!response.ok) {await response.body?.cancel();throw new Error(`download returned HTTP ${response.status}`);}
    if(!response.body) throw new Error('download was empty');
    // A crash may leave an unregistered file from a previous download attempt.
    await rm(privatePath(job.id),{force:true});
    return await receiveUpload(Readable.fromWeb(response.body),job.id);
  } catch(error) {throw new Error(`${source.label}: ${error.message}`,{cause:error});}
}
