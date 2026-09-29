import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import unzipper from 'unzipper';

export const storageRoot = path.resolve(process.env.IMPORT_STORAGE_DIR || '.import-storage');
const publicRoot=path.resolve('dist');
if(storageRoot===publicRoot || storageRoot.startsWith(publicRoot+path.sep)) throw new Error('IMPORT_STORAGE_DIR must be outside the public dist directory');
export const limits = { upload: Number(process.env.IMPORT_MAX_BYTES || 536870912), expanded: Number(process.env.IMPORT_MAX_EXPANDED_BYTES || 2147483648), entry: Number(process.env.IMPORT_MAX_ENTRY_BYTES || 536870912), entries: 500, depth: 2 };
for(const [name,value] of Object.entries(limits)) if(!Number.isSafeInteger(value)||value<=0) throw new Error(`Invalid import limit: ${name}`);
export function privatePath(id, name = 'upload') {
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[a-z0-9.-]+$/.test(name)) throw new Error('Invalid private storage key');
  return path.join(storageRoot,id,name);
}
export async function receiveUpload(stream,id) {
  await mkdir(path.dirname(privatePath(id)),{recursive:true,mode:0o700});
  let size=0; const hash=createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,callback) {
    size+=chunk.length;
    if(size>limits.upload) return callback(Object.assign(new Error(`Upload exceeds ${limits.upload} bytes`),{status:413}));
    hash.update(chunk); callback(null,chunk);
  }});
  try {
    await pipeline(stream,meter,createWriteStream(privatePath(id),{flags:'wx',mode:0o600}));
    if(!size) throw Object.assign(new Error('File is empty'),{status:400});
    return {byteSize:size,sha256:hash.digest('hex')};
  } catch(error) { await rm(privatePath(id),{force:true}); throw error; }
}
export async function hashFile(file) {
  const hash=createHash('sha256'); for await(const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export function validateZipEntry(entry) {
  const name=entry.path.replaceAll('\\','/');
  if (!name || name.startsWith('/') || name.split('/').some(p=>p==='..') || /[:\x00-\x1f]/.test(name)) throw new Error(`Unsafe ZIP path: ${entry.path}`);
  const mode=(entry.externalFileAttributes >>>16)&0xf000;
  if(mode===0xa000 || (entry.flags&1)) throw new Error('ZIP symlinks and encrypted entries are unsupported');
  if(entry.uncompressedSize>limits.entry || (entry.uncompressedSize>1048576 && entry.uncompressedSize/Math.max(1,entry.compressedSize)>1000)) throw new Error('ZIP entry exceeds expansion limits');
  return name;
}
// No source paths are extracted. Each member is streamed to an opaque private name.
export async function expandUpload(id,filename) {
  const budget={bytes:0,count:0}; const members=[];
  async function visit(file,name,depth) {
    if(!name.toLowerCase().endsWith('.zip')) {members.push({file,name});return;}
    if(depth>limits.depth) throw new Error('ZIP nesting exceeds two levels');
    const directory=await unzipper.Open.file(file);
    const names=new Set();
    for(const entry of directory.files) {
      const safe=validateZipEntry(entry);
      if(names.has(safe.toLowerCase())) throw new Error(`Duplicate ZIP member: ${safe}`);
      names.add(safe.toLowerCase());
      if(++budget.count>limits.entries) throw new Error('ZIP contains too many entries');
      if(entry.type==='Directory') continue;
      const dest=privatePath(id,randomUUID()); let actual=0;
      const meter=new Transform({transform(chunk,encoding,callback){
        actual+=chunk.length; budget.bytes+=chunk.length;
        if(actual>limits.entry || budget.bytes>limits.expanded) return callback(new Error('ZIP expansion limit exceeded'));
        callback(null,chunk);
      }});
      await pipeline(entry.stream(),meter,createWriteStream(dest,{flags:'wx',mode:0o600}));
      if(actual!==entry.uncompressedSize) throw new Error('ZIP member size does not match its directory');
      await visit(dest,safe,depth+1);
    }
  }
  await visit(privatePath(id),filename,0); return members;
}
export const savePlan=(id,plan)=>writeFile(privatePath(id,'plan'),serialize(plan),{mode:0o600});
export const readPlan=async id=>deserialize(await readFile(privatePath(id,'plan')));
