import pg from 'pg';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fork,execFileSync } from 'node:child_process';
const base=process.env.DATABASE_URL||'postgresql://signal:signal@localhost:15432/signal';
const databaseName=`signal_import_check_${Date.now()}_${randomBytes(4).toString('hex')}`;
const owner=new pg.Pool({connectionString:base});
let server;
try {
  await owner.query(`CREATE DATABASE ${databaseName}`);
  const url=new URL(base);url.pathname='/'+databaseName;
  const config={databaseUrl:url.href,databaseName,token:randomBytes(32).toString('hex'),port:Number(process.env.IMPORT_TEST_PORT||3197)};
  await fs.mkdir('.tmp',{recursive:true});
  await fs.writeFile('.tmp/import-test-config.json',JSON.stringify(config),{mode:0o600});
  execFileSync('python',['-c',"import zipfile\nwith zipfile.ZipFile('.tmp/medsl-reconciliation.zip','w',zipfile.ZIP_DEFLATED) as z:\n z.write('2024_results/ar24.zip','renamed-state.zip')\n z.write('2024_results/2024-senate-county.csv','renamed-summary.csv')"],{windowsHide:true});
  server=fork('server/tests/runImportTestServer.js',[],{stdio:'inherit',windowsHide:true});
  let ready=false;
  for(let i=0;i<60;i++) {
    if(server.exitCode!==null) throw new Error('Test API exited before startup');
    try {const response=await fetch(`http://localhost:${config.port}/api/admin/session`,{headers:{Authorization:`Bearer ${config.token}`}});if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!ready) throw new Error('Test API did not start');
  await new Promise((resolve,reject)=>{
    const smoke=fork('server/tests/importApiSmoke.js',[],{stdio:'inherit',windowsHide:true});
    smoke.on('error',reject);smoke.on('exit',code=>code===0?resolve():reject(new Error(`API integration test exited ${code}`)));
  });
}finally {
  if(server && server.exitCode===null) {const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
  // The identifier is generated above, never supplied by an operator.
  await owner.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await owner.end();
}
