import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, closeDatabase, initializeDatabase } from './db.js';
import { listRaces, getHistory, getStorage, getConfig, refresh, getRuns, getArchiveFacets, getHubOptions, getHubOverview, getHubDistricts, getHubGeographies, getElectoralCollege } from './controllers/electionController.js';
await initializeDatabase();
const app=express(); app.use(express.json());
app.get('/api/health',async (_,res,next)=>{ try { await all('SELECT 1'); res.json({status:'ok',database:'postgresql'}); } catch(error) { next(error); } });
app.get('/api/races',listRaces); app.get('/api/races/:id/history',getHistory);
app.get('/api/config',getConfig); app.get('/api/storage',getStorage); app.get('/api/ingest-runs',getRuns); app.post('/api/refresh',refresh);
app.get('/api/archive/facets',getArchiveFacets);
app.get('/api/hub/options',getHubOptions);
app.get('/api/hub/overview',getHubOverview);
app.get('/api/hub/electoral-college',getElectoralCollege);
app.get('/api/hub/districts',getHubDistricts);
app.get('/api/hub/contests/:id/geographies',getHubGeographies);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); app.use(express.static(path.join(root,'dist'))); app.get('*splat',(req,res)=>res.sendFile(path.join(root,'dist','index.html')));
app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message||'Internal server error'}));
const port=Number(process.env.PORT||3000);
const server=app.listen(port,()=>console.log(`Electioneer API listening on http://localhost:${port}`));

const shutdown = signal => {
  console.log(`${signal} received; closing server.`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
