import './loadEnv.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { adminRouter, requireAdmin } from './importers/admin/routes.js';
import { listPolls, pollFacets, listPublishedAverages } from './repositories/pollRepository.js';
import { getOutlook } from './repositories/outlookRepository.js';
import { all, closeDatabase, initializeDatabase } from './db.js';
import { listRaces, getHistory, getStorage, getConfig, refresh, getRuns, getArchiveFacets, getHubOptions, getHubOverview, getHubDistricts, getHubGeographies, getElectoralCollege } from './controllers/electionController.js';
await initializeDatabase();
const app=express(); app.use(express.json());
app.get('/api/health',async (_,res,next)=>{ try { await all('SELECT 1'); res.json({status:'ok',database:'postgresql'}); } catch(error) { next(error); } });
app.get('/api/races',listRaces); app.get('/api/races/:id/history',getHistory);
app.get('/api/config',getConfig); app.get('/api/storage',getStorage); app.get('/api/ingest-runs',requireAdmin,getRuns); app.post('/api/refresh',requireAdmin,refresh);
app.use('/api/admin',adminRouter);
app.get('/api/polls',listPolls); app.get('/api/polls/facets',pollFacets); app.get('/api/poll-averages',listPublishedAverages);
app.get('/api/archive/facets',getArchiveFacets);
app.get('/api/hub/options',getHubOptions);
app.get('/api/hub/outlook',getOutlook);
app.get('/api/hub/overview',getHubOverview);
app.get('/api/hub/electoral-college',getElectoralCollege);
app.get('/api/hub/districts',getHubDistricts);
app.get('/api/hub/contests/:id/geographies',getHubGeographies);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); app.use(express.static(path.join(root,'dist'))); app.get('*splat',(req,res)=>res.sendFile(path.join(root,'dist','index.html')));
app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message||'Internal server error'}));
const port=Number(process.env.PORT||3000);
const server=app.listen(port,()=>console.log(`Signal API listening on http://localhost:${port}`));
let worker;
let shuttingDown=false;
function startWorker() {
  worker=fork(fileURLToPath(new URL('./importers/admin/worker.js',import.meta.url)),[],{stdio:'inherit',windowsHide:true});
  worker.on('exit',()=>{if(!shuttingDown) setTimeout(startWorker,3000).unref();});
}
if(process.env.ADMIN_IMPORT_TOKEN?.length>=32) startWorker();

const shutdown = signal => {
  shuttingDown=true;
  worker?.kill();
  console.log(`${signal} received; closing server.`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
