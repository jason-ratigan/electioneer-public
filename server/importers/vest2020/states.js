const entries = [
  ['AL', 'Alabama', '01'], ['AK', 'Alaska', '02'], ['AZ', 'Arizona', '04'],
  ['AR', 'Arkansas', '05'], ['CA', 'California', '06'], ['CO', 'Colorado', '08'],
  ['CT', 'Connecticut', '09'], ['DE', 'Delaware', '10'], ['DC', 'District of Columbia', '11'],
  ['FL', 'Florida', '12'], ['GA', 'Georgia', '13'], ['HI', 'Hawaii', '15'],
  ['ID', 'Idaho', '16'], ['IL', 'Illinois', '17'], ['IN', 'Indiana', '18'],
  ['IA', 'Iowa', '19'], ['KS', 'Kansas', '20'], ['KY', 'Kentucky', '21'],
  ['LA', 'Louisiana', '22'], ['ME', 'Maine', '23'], ['MD', 'Maryland', '24'],
  ['MA', 'Massachusetts', '25'], ['MI', 'Michigan', '26'], ['MN', 'Minnesota', '27'],
  ['MS', 'Mississippi', '28'], ['MO', 'Missouri', '29'], ['MT', 'Montana', '30'],
  ['NE', 'Nebraska', '31'], ['NV', 'Nevada', '32'], ['NH', 'New Hampshire', '33'],
  ['NJ', 'New Jersey', '34'], ['NM', 'New Mexico', '35'], ['NY', 'New York', '36'],
  ['NC', 'North Carolina', '37'], ['ND', 'North Dakota', '38'], ['OH', 'Ohio', '39'],
  ['OK', 'Oklahoma', '40'], ['OR', 'Oregon', '41'], ['PA', 'Pennsylvania', '42'],
  ['RI', 'Rhode Island', '44'], ['SC', 'South Carolina', '45'], ['SD', 'South Dakota', '46'],
  ['TN', 'Tennessee', '47'], ['TX', 'Texas', '48'], ['UT', 'Utah', '49'],
  ['VT', 'Vermont', '50'], ['VA', 'Virginia', '51'], ['WA', 'Washington', '53'],
  ['WV', 'West Virginia', '54'], ['WI', 'Wisconsin', '55'], ['WY', 'Wyoming', '56']
];

export const vestStates = Object.freeze(entries.map(([abbreviation, name, stateFips]) => Object.freeze({
  abbreviation,
  code: abbreviation.toLowerCase(),
  name,
  stateFips,
  archiveName: `${abbreviation.toLowerCase()}_2020.zip`,
  shapeBasename: `${abbreviation.toLowerCase()}_2020`,
  namespace: `vest:2020:${abbreviation.toLowerCase()}`
})));

export const vestStateByCode = new Map(vestStates.flatMap(state => [
  [state.code, state],
  [state.abbreviation, state]
]));

export function resolveVestState(value) {
  const state = vestStateByCode.get(String(value).trim().toUpperCase())
    || vestStateByCode.get(String(value).trim().toLowerCase());
  if (!state) throw new Error(`Unknown state abbreviation: ${value}`);
  return state;
}
