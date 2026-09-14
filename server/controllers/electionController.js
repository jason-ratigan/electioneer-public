import { electionService } from '../services/electionService.js';
export const listRaces = async (req,res,next) => { try { res.json({ data: await electionService.listRaces(req.query) }); } catch(e){ next(e); } };
export const getArchiveFacets = async (req,res,next) => { try {res.json({data:await electionService.facets()});} catch(e){next(e);} };
export const getHistory = async (req,res,next) => { try { res.json({ data: await electionService.history(req.params.id) }); } catch(e){ next(e); } };
export const recordObservation = async (req,res,next) => { try { res.status(201).json({ data: await electionService.record(req.params.id, req.body) }); } catch(e){ next(e); } };
export const getStorage = async (req,res,next) => { try { res.json({data:await electionService.storage()}); } catch(e){next(e);} };
export const getConfig = (req,res) => res.json({data:electionService.config()});
export const refresh = async (req,res,next) => { try {res.status(202).json({data:await electionService.refresh(req.body.source)});} catch(e){next(e);} };
export const getRuns = async (req,res,next) => { try {res.json({data:await electionService.runs()});} catch(e){next(e);} };
