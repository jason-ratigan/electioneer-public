import { electionRepository } from '../repositories/electionRepository.js';
import { electionHubRepository } from '../repositories/electionHubRepository.js';
import { archivePolicy, sources } from '../config.js';
const allowedTypes = new Set(['primary', 'general', 'runoff', 'special', 'presidential_primary', 'presidential_general']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hubOffices = new Set(['president', 'governor', 'us_house', 'us_senate']);
const hubLevels = new Set(['county', 'precinct']);
export const electionService = {
  listRaces(filters) {
    if (filters.type && !allowedTypes.has(filters.type)) throw Object.assign(new Error('Unsupported election type'), { status: 400 });
    const cycle = filters.cycle ? Number(filters.cycle) : null;
    if (cycle !== null && (!Number.isInteger(cycle) || cycle < 1788)) throw Object.assign(new Error('Cycle must be a valid election year'), { status: 400 });
    return electionRepository.listRaces({type:filters.type||null,cycle,office:filters.office||null,query:filters.query||null});
  },
  facets(){ return electionRepository.archiveFacets(); },
  history(id) { if (!uuidPattern.test(id)) throw Object.assign(new Error('Contest ID must be a UUID'), { status: 400 }); return electionRepository.raceHistory(id); },
  storage(){ return electionRepository.storage(); },
  config(){ return {archivePolicy,sources}; },
  async refresh(source){ const provider=sources.find(item=>item.id===source); if(!provider) throw Object.assign(new Error('Unknown source'),{status:400}); if(!provider.enabled) throw Object.assign(new Error(`${provider.label} requires configuration before refresh`),{status:409}); throw Object.assign(new Error(`${provider.label} importer is not implemented yet`),{status:501}); },
  runs(){ return electionRepository.recentIngestRuns(); }
  ,hubOptions(){ return electionHubRepository.options(); }
  ,hubOverview(filters){
    const office = filters.office || 'president';
    if (!hubOffices.has(office)) throw Object.assign(new Error('Unsupported office'), { status: 400 });
    const cycle = Number(filters.cycle || 2020);
    if (!Number.isInteger(cycle) || cycle < 1788) throw Object.assign(new Error('Cycle must be a valid election year'), { status: 400 });
    const stage = filters.stage || 'general';
    if (!allowedTypes.has(stage)) throw Object.assign(new Error('Unsupported election stage'), { status: 400 });
    return electionHubRepository.overview({ office, cycle, stage });
  }
  ,hubDistricts(filters){
    const cycle = Number(filters.cycle || 2020);
    if (!Number.isInteger(cycle) || cycle < 1788) throw Object.assign(new Error('Cycle must be a valid election year'), { status: 400 });
    const stage = filters.stage || 'general';
    if (!allowedTypes.has(stage)) throw Object.assign(new Error('Unsupported election stage'), { status: 400 });
    return electionHubRepository.districtResults({ cycle, stage });
  }
  ,hubGeographies(id, filters){
    if (!uuidPattern.test(id)) throw Object.assign(new Error('Contest ID must be a UUID'), { status: 400 });
    const level = filters.level || 'county';
    if (!hubLevels.has(level)) throw Object.assign(new Error('Level must be county or precinct'), { status: 400 });
    return electionHubRepository.geographicResults({ contestId: id, level });
  }
};
