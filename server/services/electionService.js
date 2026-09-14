import { randomUUID } from 'node:crypto';
import { electionRepository } from '../repositories/electionRepository.js';
import { archivePolicy, sources } from '../config.js';
const allowedTypes = new Set(['primary', 'general', 'presidential_primary', 'presidential_general']);
export const electionService = {
  listRaces(filters) { if (filters.type && !allowedTypes.has(filters.type)) throw Object.assign(new Error('Unsupported election type'), { status: 400 }); return electionRepository.listRaces({type:filters.type||null,cycle:filters.cycle?Number(filters.cycle):null,office:filters.office||null,query:filters.query||null}); },
  facets(){ return electionRepository.archiveFacets(); },
  history(id) { return electionRepository.raceHistory(id); },
  async record(raceId, input) { if (![input.valueA,input.valueB,input.reporting].every(Number.isFinite)) throw Object.assign(new Error('Numeric values are required'), { status: 400 }); const storage=await electionRepository.storage(); if(storage.megabytes>=storage.limitMegabytes) throw Object.assign(new Error('Local database storage limit reached'),{status:507}); const row={ id:randomUUID(), raceId, observedAt:new Date().toISOString(), metric:input.metric || 'returns', valueA:input.valueA, valueB:input.valueB, reporting:input.reporting, source:input.source || 'manual' }; await electionRepository.addObservation(row); return row; },
  storage(){ return electionRepository.storage(); },
  config(){ return {archivePolicy,sources}; },
  async refresh(source){ const provider=sources.find(item=>item.id===source); if(!provider) throw Object.assign(new Error('Unknown source'),{status:400}); if(!provider.enabled) throw Object.assign(new Error(`${provider.label} requires configuration before refresh`),{status:409}); const now=new Date().toISOString(); const result={id:randomUUID(),source,startedAt:now,completedAt:now,status:'completed',rowsAdded:0,message:'Manual refresh recorded; connect provider adapter to import records.'}; await electionRepository.recordIngestRun(result); return result; },
  runs(){ return electionRepository.recentIngestRuns(); }
};
