// Manual end-to-end harness: test configuration is created in ignored .tmp.
// Never points at the user's database unless explicitly placed in that file.
import fs from 'node:fs/promises';
const config=JSON.parse(await fs.readFile('.tmp/import-test-config.json','utf8'));
if(!config.databaseName.startsWith('signal_import_check_')) throw new Error('Expected a disposable import-check database');
process.env.DATABASE_URL=config.databaseUrl;
process.env.ADMIN_IMPORT_TOKEN=config.token;
process.env.PORT=String(config.port);
process.env.IMPORT_STORAGE_DIR='.tmp/import-check-storage';
const {initializeDatabase,db}=await import('../db.js');
await initializeDatabase();
const {vestStates}=await import('../importers/vest2020/states.js');
for(const s of vestStates) await db.query(`INSERT INTO geographies(geography_type,name,abbreviation,state_fips) VALUES('state',$1,$2,$3) ON CONFLICT DO NOTHING`,[s.name,s.abbreviation,s.stateFips]);
await import('../index.js');
