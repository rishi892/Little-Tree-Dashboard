import { loadAll } from '../src/ar/lib/sheets.js'
import { wholesaleScope } from '../src/ar/lib/scope.js'
const data = await loadAll()
const ws = wholesaleScope(data)
const now=new Date(); now.setHours(0,0,0,0)
const map=new Map()
ws.financials.forEach(r=>{if(!r.date)return; const c=map.get(r.vendor)||{lastOrder:null,dates:[]};c.dates.push(r.date);if(!c.lastOrder||r.date>c.lastOrder)c.lastOrder=r.date;map.set(r.vendor,c)})
let churned=0,declining=0,active=0
map.forEach(c=>{
  const days=Math.floor((now-c.lastOrder)/864e5)
  let cycle=null
  if(c.dates.length>=3){const ds=[...c.dates].sort((a,b)=>a-b);const g=[];for(let i=1;i<ds.length;i++)g.push((ds[i]-ds[i-1])/864e5);g.sort((a,b)=>a-b);cycle=Math.round(g[Math.floor(g.length/2)])}
  if(days>180)churned++; else if(cycle&&days>cycle*2)declining++; else active++
})
console.log('Little Tree customers:', map.size)
console.log('  Churned (180d+ silent):', churned)
console.log('  Declining (past 2× cycle):', declining)
console.log('  Active:', active)
