import snapshot from './officeholders2026.json' with {type:'json'};

// State elections only. The NGA also lists three territorial elections.
export const senate2026='AL AK AR CO DE GA ID IL IA KS KY LA ME MA MI MN MS MT NE NH NJ NM NC OK OR RI SC SD TN TX VA WV WY FL OH'.split(' ');
export const governor2026='AL AK AZ AR CA CO CT FL GA HI ID IL IA KS ME MD MA MI MN NE NV NH NM NY OH OK OR PA RI SC SD TN TX VT WI WY'.split(' ');
const upGovernor=new Set(governor2026);
const aligned=party=>party==='I'?'D':party;
const count=values=>values.reduce((n,party)=>(n[party]=(n[party]||0)+1,n),{D:0,R:0,I:0});

export function officeholderBaseline(office,cycle) {
  if(cycle!==2026 || !['us_house','us_senate','governor'].includes(office)) return null;
  let seats={},holdoverSeats={},holdovers={D:0,R:0,I:0},current,total;
  if(office==='us_house') {
    seats=snapshot.house;
    current=count(Object.values(seats).map(item=>item.party));
    current.vacant=435-Object.keys(seats).length;
    total=435;
  } else if(office==='us_senate') {
    current=count(snapshot.senate.map(item=>item.party));
    current.vacant=100-snapshot.senate.length;
    for(const member of snapshot.senate) {
      const up=member.class===2 || (member.class===3 && ['FL','OH'].includes(member.state));
      if(up) seats[member.state]={party:member.party,name:member.name};
      else {
        if(!holdoverSeats[member.state]) holdoverSeats[member.state]=[];
        holdoverSeats[member.state].push({party:member.party,name:member.name,class:member.class});
        holdovers[aligned(member.party)]++;
      }
    }
    total=100;
  } else {
    current=count(Object.values(snapshot.governors).map(item=>item.party));
    current.vacant=50-Object.keys(snapshot.governors).length;
    for(const [state,governor] of Object.entries(snapshot.governors)) {
      if(upGovernor.has(state)) seats[state]=governor;
      else {holdoverSeats[state]=governor;holdovers[governor.party]++;}
    }
    total=50;
  }
  return {asOf:snapshot.asOf,sources:snapshot.sources,office,total,current,holdovers,holdoverSeats,seats,up:office==='us_senate'?senate2026:office==='governor'?governor2026:null};
}
