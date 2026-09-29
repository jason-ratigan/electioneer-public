import { Router } from 'express';
import { timingSafeEqual,createHash,randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { receiveUpload,limits } from './storage.js';

export function requireAdmin(req,res,next) {
  const secret=process.env.ADMIN_IMPORT_TOKEN;
  res.set('Cache-Control','no-store');
  if(!secret || secret.length<32) return res.status(503).json({error:'Admin imports are disabled. Set ADMIN_IMPORT_TOKEN to a random secret of at least 32 characters on the server.'});
  const supplied=req.get('authorization')?.replace(/^Bearer /,'')||'';
  const digest=value=>createHash('sha256').update(value).digest();
  if(!timingSafeEqual(digest(secret),digest(supplied))) return res.status(401).json({error:'Administrator authentication required'});
  next();
}
export const adminRouter=Router();
adminRouter.use(requireAdmin);
adminRouter.get('/session',(_,res)=>res.json({data:{authenticated:true,maxBytes:limits.upload}}));
adminRouter.get('/imports',async(_,res)=>res.json({data:(await db.query('SELECT * FROM admin_imports ORDER BY created_at DESC LIMIT 100')).rows}));
adminRouter.get('/imports/:id',async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).json({error:'Invalid import ID'});
  const row=(await db.query('SELECT * FROM admin_imports WHERE id=$1',[req.params.id])).rows[0];
  if(!row) return res.status(404).json({error:'Import not found'});
  res.json({data:row});
});
adminRouter.post('/imports',async(req,res)=>{
  const filename=String(req.query.filename||'');
  if(!/\.(csv|zip)$/i.test(filename) || filename.length>200 || /[\\/\x00-\x1f]/.test(filename)) return res.status(400).json({error:'Choose a CSV or ZIP file with a plain filename'});
  if(!req.is('application/octet-stream')) return res.status(415).json({error:'Send the file as application/octet-stream'});
  if(Number(req.get('content-length'))>limits.upload) return res.status(413).json({error:`Upload exceeds ${limits.upload} bytes`});
  const sourceUrl=String(req.query.sourceUrl||'');
  if(sourceUrl && (!/^https?:\/\//i.test(sourceUrl) || sourceUrl.length>2000)) return res.status(400).json({error:'Source URL must use HTTP or HTTPS'});
  const license=String(req.query.license||'');
  if(license.length>300) return res.status(400).json({error:'License is too long'});
  const pending=(await db.query("SELECT count(*)::int AS n FROM admin_imports WHERE status IN ('queued','validating','committing')")).rows[0].n;
  if(pending>=20) return res.status(429).json({error:'Import queue is full; wait for existing jobs to finish'});
  const id=randomUUID();const upload=await receiveUpload(req,id);
  const row=(await db.query(`INSERT INTO admin_imports(id,filename,sha256,byte_size,status,source_url,license) VALUES($1,$2,$3,$4,'queued',$5,$6) RETURNING *`,[id,filename,upload.sha256,upload.byteSize,sourceUrl||null,license||null])).rows[0];
  res.status(202).json({data:row});
});
adminRouter.post('/imports/:id/commit',async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).json({error:'Invalid import ID'});
  const row=(await db.query(`UPDATE admin_imports SET status='queued',phase='commit',confirmed_at=now(),updated_at=now(),progress=0,message='Commit queued' WHERE id=$1 AND status='ready' AND confirmation=$2 RETURNING *`,[req.params.id,typeof req.body?.confirmation==='string'?req.body.confirmation:''])).rows[0];
  if(row) return res.status(202).json({data:row});
  const existing=(await db.query('SELECT * FROM admin_imports WHERE id=$1',[req.params.id])).rows[0];
  if(existing?.confirmed_at && existing.confirmation===req.body?.confirmation) return res.status(200).json({data:existing});
  res.status(409).json({error:'A current validated preview and its confirmation token are required'});
});
adminRouter.post('/imports/:id/retry',async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).json({error:'Invalid import ID'});
  const row=(await db.query(`UPDATE admin_imports SET status='queued',progress=0,updated_at=now(),message='Retry queued' WHERE id=$1 AND status='failed' RETURNING *`,[req.params.id])).rows[0];
  if(!row) return res.status(409).json({error:'Only failed imports can be retried'});
  res.status(202).json({data:row});
});
