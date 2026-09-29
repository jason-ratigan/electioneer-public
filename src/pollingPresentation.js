// Display rules are separate from the polling model and chamber-control thresholds.
export const pollColors = {
  D: '#3073c9', DMedium: '#79a7de', DLight: '#bed5f0',
  R: '#c94e59', RMedium: '#df9299', RLight: '#f0c5c9',
  competitive: '#a08cbc', other: '#68778b', unknown: '#dce3eb', off: '#f0f3f7'
};
export const mapLegend = [
  ['D','D 10+'],['DMedium','D 5–10'],['DLight','D 3–5'],
  ['competitive','Within 3'],['RLight','R 3–5'],['RMedium','R 5–10'],['R','R 10+'],
  ['unknown','No average'],['off','No mapped race']
];
export function mapShade(margin, override) {
  if (override) return override;
  if (margin == null || !Number.isFinite(margin)) return 'unknown';
  const lead = Math.abs(margin), party = margin > 0 ? 'D' : 'R';
  if (lead < 3 - 1e-9) return 'competitive';
  if (lead < 5 - 1e-9) return `${party}Light`;
  if (lead < 10 - 1e-9) return `${party}Medium`;
  return party;
}
export function responseGroup(response, approval = false) {
  if (approval) {
    const label = String(response.label || '').trim().toLowerCase();
    if (/^(approve|approval|strongly approve|somewhat approve)$/.test(label)) return 'D';
    if (/^(disapprove|disapproval|strongly disapprove|somewhat disapprove)$/.test(label)) return 'R';
    return 'other';
  }
  const party = String(response.party || '').trim().toUpperCase();
  if (['D','DEM','DEMOCRAT','DEMOCRATIC'].includes(party)) return 'D';
  if (['R','REP','REPUBLICAN','GOP'].includes(party)) return 'R';
  return 'other';
}
export function responseColumns(responses, approval = false) {
  const groups = {D:[],R:[],other:[]};
  for (const response of responses || []) groups[responseGroup(response, approval)].push(response);
  return groups;
}
export function trendDomain(values) {
  const finite = values.filter(v => v != null && Number.isFinite(v));
  if (!finite.length) return [-3,3];
  const min = Math.min(...finite), max = Math.max(...finite);
  const padding = Math.max(1, (max-min)*0.15, (6-(max-min))/2);
  return [Math.max(-100,Math.floor((min-padding)/2)*2),Math.min(100,Math.ceil((max+padding)/2)*2)];
}
export function approvalDomain(values) {
  const finite = values.filter(v => v != null && Number.isFinite(v));
  // Start at 25–75%; expand only when necessary to keep an observation visible.
  return [Math.max(0,Math.min(25,Math.floor((Math.min(25,...finite))/5)*5)),
    Math.min(100,Math.max(75,Math.ceil((Math.max(75,...finite))/5)*5))];
}
