'use strict';
/* Modesto Job Finder — 95355. No build step, no accounts.
   Data lives only in this browser (localStorage). Job listings live on the
   linked sites; every button builds a live, pre-filled search for
   "job + Modesto, CA 95355" so results are always current. */
const KEY = 'modesto-job-finder-v1';
const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

const ROLES = [
  { label:'⭐ Any entry-level', q:'entry level', t:'bus' },
  { label:'🏠 Customer service (remote)', q:'customer service representative remote', t:'remote' },
  { label:'🏠 Data entry (remote)', q:'data entry remote', t:'remote' },
  { label:'🛒 Retail / cashier', q:'retail cashier', t:'bus' },
  { label:'🥫 Grocery stocker', q:'grocery stocker', t:'walk' },
  { label:'🍔 Food service', q:'fast food crew', t:'walk' },
  { label:'📦 Warehouse associate', q:'warehouse associate', t:'bus' },
  { label:'🧹 Janitor / cleaner', q:'janitor cleaner', t:'bus' },
  { label:'💙 Caregiver', q:'caregiver', t:'bus' },
  { label:'📞 Call center', q:'call center representative', t:'remote' },
  { label:'🛡 Security guard', q:'security guard', t:'bus' },
  { label:'🧰 General labor', q:'general labor', t:'bus' },
  { label:'🚗 Delivery driver — usually needs a car', q:'delivery driver', t:'car' },
];
const TAGS = { remote:'<span class="tag tag-remote">🏠 Remote</span>', walk:'<span class="tag tag-walk">🚶 Walk / bike possible</span>', bus:'<span class="tag tag-bus">🚌 Bus-friendly</span>', car:'<span class="tag tag-car">🚗 Usually needs a car</span>' };

/* radius: miles to search, based on how the user gets to work */
function radius(){ return { 'no-car':5, bus:10, walk:3, car:25 }[state.transport] ?? 5; }

/* Every site from the Stanislaus Workforce PDF that supports a pre-filled search.
   `good` = how good it is with no car: remote > local > regional. */
const BOARDS = [
  { name:'Indeed', cat:'Big job boards', good:'local', note:'Biggest list of Modesto jobs. Filter by distance & date posted.', url:q=>`https://www.indeed.com/jobs?q=${enc(q)}&l=95355&radius=${radius()}&sort=date` },
  { name:'Google Jobs', cat:'Big job boards', good:'local', note:'Searches many sites at once — exactly like the PDF suggests.', url:q=>`https://www.google.com/search?q=${enc(q+' jobs near Modesto, CA 95355')}&ibp=htl;jobs` },
  { name:'ZipRecruiter', cat:'Big job boards', good:'local', note:'Good alerts — turn on email alerts for 95355.', url:q=>`https://www.ziprecruiter.com/jobs-search?search=${enc(q)}&location=${enc('Modesto, CA 95355')}&days=30` },
  { name:'Snagajob', cat:'Big job boards', good:'local', note:'Hourly jobs: retail, food, grocery — great for entry-level.', url:q=>`https://www.snagajob.com/jobs?q=${enc(q)}&w=${enc('Modesto, CA')}` },
  { name:'LinkedIn Jobs', cat:'Big job boards', good:'remote', note:'Best for remote customer-service & office jobs.', url:q=>`https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&location=${enc('Modesto, California, United States')}&distance=${radius()}` },
  { name:'Glassdoor', cat:'Big job boards', good:'local', note:'Check pay & company reviews before you apply.', url:q=>`https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc(q)}&locKeyword=${enc('Modesto, CA')}` },
  { name:'Monster', cat:'Big job boards', good:'local', note:'From the PDF list — large national board.', url:q=>`https://www.monster.com/jobs/search?q=${enc(q)}&where=${enc('Modesto, CA')}` },
  { name:'CareerBuilder', cat:'Big job boards', good:'local', note:'From the PDF list — large national board.', url:q=>`https://www.careerbuilder.com/jobs?keywords=${enc(q)}&location=${enc('Modesto, CA 95355')}` },
  { name:'SimplyHired', cat:'Big job boards', good:'local', note:'From the PDF list — aggregates many boards.', url:q=>`https://www.simplyhired.com/search?q=${enc(q)}&l=${enc('Modesto, CA')}` },

  { name:'CalJOBS', cat:'Local & government', good:'local', note:'California’s FREE official job site. Many local employers require it. Start here.', url:()=>'https://www.caljobs.ca.gov/' },
  { name:'Stanislaus Workforce', cat:'Local & government', good:'local', note:'Free local help in Modesto: workshops, resume help, computers. (Source of the PDF.)', url:()=>'https://www.stanworkforce.com/' },
  { name:'Stanislaus County Jobs', cat:'Local & government', good:'bus', note:'County jobs — steady, benefits, many in Modesto.', url:q=>`https://www.governmentjobs.com/careers/stanislauscounty/jobs?keywords=${enc(q)}` },
  { name:'City of Modesto Jobs', cat:'Local & government', good:'bus', note:'City jobs right in Modesto.', url:q=>`https://www.governmentjobs.com/careers/modesto/jobs?keywords=${enc(q)}` },
  { name:'CalCareers (State jobs)', cat:'Local & government', good:'bus', note:'State of California jobs searchable by keyword & county.', url:q=>`https://calcareers.ca.gov/CalHRPublic/Search/JobSearchResults.aspx#kw=${enc(q)}` },
  { name:'GovernmentJobs.com', cat:'Local & government', good:'bus', note:'City/county/government jobs near 95355.', url:q=>`https://www.governmentjobs.com/jobs?keyword=${enc(q)}&location=${enc('Modesto, CA')}` },
  { name:'USAJobs (Federal)', cat:'Local & government', good:'bus', note:'Federal jobs — filter to Modesto area.', url:q=>`https://www.usajobs.gov/Search/Results?k=${enc(q)}&l=${enc('Modesto, California')}&r=25` },
  { name:'EdJoin (Schools)', cat:'Local & government', good:'bus', note:'School jobs — aides, custodial, food service, office.', url:q=>`https://www.edjoin.org/Home/JobSearch?location=${enc('Modesto, CA')}&keyword=${enc(q)}` },

  { name:'Sutter Health Careers', cat:'Direct employers', good:'bus', note:'Memorial Medical Center Modesto — support, food, clerical roles too.', url:q=>`https://www.sutterhealth.org/careers/search-jobs?keyword=${enc(q)}` },
  { name:'Kaiser Permanente Jobs', cat:'Direct employers', good:'bus', note:'Kaiser Modesto — clerical, support & clinical.', url:q=>`https://www.kaiserpermanentejobs.org/search-jobs?k=${enc(q)}` },
  { name:'Walmart Careers', cat:'Direct employers', good:'bus', note:'Several Modesto stores — stocking, cashier, pickup.', url:()=>'https://careers.walmart.com/' },
  { name:'Target Jobs', cat:'Direct employers', good:'bus', note:'Modesto stores — guest service & fulfillment.', url:q=>`https://jobs.target.com/search-jobs/${enc(q)}` },
  { name:'Amazon Jobs', cat:'Direct employers', good:'car', note:'Warehouses near Modesto/Tracy — check transport first, many shifts need a car.', url:q=>`https://www.amazon.jobs/en/search?base_query=${enc(q)}&loc_query=${enc('Modesto, CA, United States')}` },
  { name:'Save Mart Careers', cat:'Direct employers', good:'bus', note:'Local grocery chain headquartered in Modesto.', url:()=>'https://www.savemart.com/careers' },
  { name:'Robert Half', cat:'Direct employers', good:'remote', note:'Office, admin & customer-service staffing (from the PDF).', url:q=>`https://www.roberthalf.com/us/en/jobs/all/${enc(q)}` },

  { name:'FlexJobs (Remote)', cat:'Remote & flexible', good:'remote', note:'Remote jobs board from the PDF (some features paid — free browsing works).', url:q=>`https://www.flexjobs.com/search?search=${enc(q)}` },
  { name:'We Work Remotely', cat:'Remote & flexible', good:'remote', note:'Remote-only jobs (from the PDF niche list).', url:q=>`https://weworkremotely.com/remote-jobs/search?term=${enc(q)}` },
  { name:'Remote.co', cat:'Remote & flexible', good:'remote', note:'Remote-only jobs (from the PDF niche list).', url:q=>`https://remote.co/remote-jobs/search/?search_keywords=${enc(q)}` },
  { name:'Upwork (Freelance)', cat:'Remote & flexible', good:'remote', note:'Freelance work from home (from the PDF).', url:q=>`https://www.upwork.com/nx/search/jobs/?q=${enc(q)}` },
];

const DIRECTORY = [
  ['Big boards & general', [['Indeed','https://www.indeed.com/jobs?q=entry+level&l=95355'],['Monster','https://www.monster.com/jobs/search?q=entry%20level&where=Modesto%2C%20CA'],['CareerBuilder','https://www.careerbuilder.com/'],['ZipRecruiter','https://www.ziprecruiter.com/'],['SimplyHired','https://www.simplyhired.com/'],['Glassdoor','https://www.glassdoor.com/'],['Getwork','https://www.getwork.com/'],['iHire','https://www.ihire.com/'],['Nexxt','https://www.nexxt.com/'],['Jobs2Careers','https://www.jobs2careers.com/'],['Geebo','https://www.geebo.com/'],['Joblist','https://www.joblist.com/'],['CareerPath','https://www.careerpath.com/'],['The Muse','https://www.themuse.com/'],['Craigslist Modesto (use care)','https://Modesto.craigslist.org/search/jjj'],['Facebook Jobs','https://www.facebook.com/jobs'],['LinkedIn','https://www.linkedin.com/jobs/'],['Snagajob','https://www.snagajob.com/'],['Wellfound (startups)','https://wellfound.com/jobs'],['Job.com','https://www.job.com/']]],
  ['Local, government & schools', [['CalJOBS','https://www.caljobs.ca.gov/'],['CalCareers','https://calcareers.ca.gov/'],['USAJobs','https://www.usajobs.gov/'],['GovernmentJobs','https://www.governmentjobs.com/'],['Stanislaus County','https://www.stancounty.com/'],['City of Modesto','https://www.modestogov.com/'],['StanWorkforce','https://www.stanworkforce.com/'],['EdJoin (schools)','https://www.edjoin.org/'],['City of Ceres','https://www.ceres.gov/'],['City of Turlock (needs travel)','https://ci.turlock.ca.us/'],['City of Riverbank','https://www.riverbank.org/'],['City of Salida area / county','https://www.stancounty.com/'],['County of Merced (needs travel)','https://www.countyofmerced.com/'],['JobApsCloud (public sector)','https://www.jobapscloud.com/']]],
  ['Direct employers (post here first!)', [['Sutter Health','https://www.sutterhealth.org/careers'],['Kaiser Permanente','https://www.kaiserpermanentejobs.org/'],['Walmart','https://careers.walmart.com/'],['Target','https://jobs.target.com/'],['Amazon','https://www.amazon.jobs/'],['Save Mart','https://www.savemart.com/careers'],['Robert Half','https://www.roberthalf.com/jobs'],['Foster Farms (Livingston — needs travel)','https://www.fosterfarms.com/careers/']]],
  ['Specialty / niche (less competition)', [['Dice — tech','https://www.dice.com/'],['Idealist — nonprofits','https://www.idealist.org/'],['HigherEdJobs — colleges','https://www.higheredjobs.com/'],['ConstructionJobs','https://www.constructionjobs.com/'],['JobsInLogistics — logistics','https://www.jobsinlogistics.com/'],['CallCenterJobs','https://www.callcenterjobs.com/'],['HealthcareJobs / MedZilla','https://www.medzilla.com/'],['Poached — restaurants','https://www.poachedjobs.com/'],['SalesGravy — sales','https://www.salesgravy.com/'],['Behance — creative','https://www.behance.net/joblist']]],
  ['Veterans', [['Hire Heroes USA','https://www.hireheroesusa.org/'],['RecruitMilitary','https://recruitmilitary.com/'],['VetJobs','https://vetjobs.org/'],['GI Jobs','https://www.gijobs.com/'],['Military.com','https://www.military.com/veteran-jobs'],['Fedshirevets (OPM)','https://www.opm.gov/policy-data-oversight/veterans-services/']]],
  ['Retirees / 50+', [['AARP Jobs','https://jobs.aarp.org/'],['RetirementJobs','https://www.retirementjobs.com/'],['Workforce50','https://www.workforce50.com/'],['Seniors4Hire','https://www.seniors4hire.org/'],['RetiredBrains','https://www.retiredbrains.com/'],['WAHVE — work at home','https://wahve.com/']]],
];

const PLAN = [
  ['Monday','Search Indeed + Google Jobs for your top 2 job types near 95355. Apply to 3–5 and Track each one.'],
  ['Tuesday','Check CalJOBS, Stanislaus County and City of Modesto jobs. Apply to any match.'],
  ['Wednesday','Go direct: Sutter, Kaiser, Walmart, Target, Save Mart career pages (they post there first).'],
  ['Thursday','Remote day: LinkedIn, FlexJobs, We Work Remotely, Upwork — customer service & data entry.'],
  ['Friday','Follow up: for every job Applied 5+ days ago with no reply, send a short polite follow-up. Update statuses.'],
  ['Weekend','Plan rides: check StanRTA bus routes for next week’s interviews. Rest — job hunting is a job.'],
];

/* ── state ─────────────────────────────────────────── */
let state = load();
function load(){ try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.jobs)) return s; } catch {} return { query:'entry level', transport:'no-car', type:'', jobs:[], plan:{} }; }
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2600); }
const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ── recommendation / roles ────────────────────────── */
function renderRec(){
  $('#transportSel').value = state.transport; $('#typeSel').value = state.type || '';
  const notes = { 'no-car':'🎯 Searching within <b>5 miles of 95355 + all remote jobs</b>. Farther jobs are tagged 🚗 so you can skip them.', bus:'🎯 Searching within <b>10 miles</b> — Modesto & Ceres by bus.', walk:'🎯 Searching within <b>3 miles</b> — walking & biking distance only.', car:'🎯 Searching within <b>25 miles</b> — includes Turlock, Riverbank, Oakdale & Salida.' };
  $('#radiusNote').innerHTML = notes[state.transport];
  $('#boardFor').textContent = `— for “${state.query}” near 95355`;
}
function renderRoles(){
  $('#roleChips').innerHTML = ROLES.map(r=>`<button type="button" class="chip ${state.query===r.q?'on':''}" data-q="${esc(r.q)}">${esc(r.label)}</button>`).join('');
  document.querySelectorAll('#roleChips .chip').forEach(b=>b.onclick=()=>{ state.query=b.dataset.q; $('#queryInput').value=state.query; save(); renderRoles(); renderRec(); renderBoards(); });
}

/* ── boards ────────────────────────────────────────── */
function renderBoards(){
  const f = ($('#siteSearch').value||'').toLowerCase();
  const rank = { remote:0, local:1, bus:2, car:3 };
  const list = BOARDS.filter(b=>!f || (b.name+' '+b.cat+' '+b.note).toLowerCase().includes(f))
    .sort((a,b)=> state.transport==='car' ? 0 : rank[a.good]-rank[b.good]);
  $('#boards').innerHTML = list.map((b,i)=>`
    <article class="board">
      <b>${esc(b.name)}</b><p>${esc(b.note)}</p>
      <div>${b.good==='remote'?TAGS.remote:b.good==='car'?TAGS.car:b.good==='bus'?TAGS.bus:TAGS.bus} <span class="tag" style="background:#eef4ef">${esc(b.cat)}</span></div>
      <div class="btn-row">
        <a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${b.url(state.query)}">Apply / Search ↗</a>
        <button class="btn btn-small" type="button" data-track="${i}">＋ Track</button>
      </div>
    </article>`).join('') || '<p class="muted">No sites match that filter.</p>';
  document.querySelectorAll('[data-track]').forEach(btn=>btn.onclick=()=>{
    const b = list[Number(btn.dataset.track)];
    const job = { id: Date.now()+''+Math.random().toString(16).slice(2,6), title: state.query.replace(/\b\w/g,c=>c.toUpperCase()), company:'', location:'Modesto, CA 95355', pay:'', transport: b.good==='remote'?'remote': b.good==='car'?'car':'bus', distance:'', stage:'Saved', priority:'Normal', applied:'', follow:'', url:b.url(state.query), notes:`Found on ${b.name}. Apply there, then paste the real posting link & company here.`, created: todayISO() };
    state.jobs.unshift(job); save(); renderTracker(); renderStats(); toast(`Saved to your tracker — now apply on ${b.name}, then edit the details.`); openForm(job); document.querySelector('#tracker').scrollIntoView({behavior:'smooth'});
  });
}

/* ── tracker ───────────────────────────────────────── */
function dueInfo(j){
  if (!j.follow || !['Applied','Interview'].includes(j.stage)) return '';
  if (j.follow < todayISO()) return `<span class="due">⚠ Follow-up overdue (${esc(j.follow)})</span>`;
  if (j.follow <= new Date(Date.now()+3*864e5).toISOString().slice(0,10)) return `<span class="due-soon">Follow up ${esc(j.follow)}</span>`;
  return `<span>Follow up ${esc(j.follow)}</span>`;
}
function renderTracker(){
  const q = ($('#jobSearch').value||'').toLowerCase(), sf=$('#stageFilter').value, tf=$('#transportFilter').value;
  const list = state.jobs.filter(j=>(!sf||j.stage===sf)&&(!tf||j.transport===tf)&&(!q||(j.title+' '+j.company+' '+j.location+' '+j.notes).toLowerCase().includes(q)));
  $('#emptyState').classList.toggle('hidden', state.jobs.length>0);
  $('#jobList').innerHTML = list.map(j=>`
   <article class="job stage-${esc(j.stage)}">
     <div class="job-main">
       <b>${esc(j.title)||'(Untitled job)'}</b> ${j.priority==='High'?'<span class="tag tag-car">★ High priority</span>':''}
       <div class="job-meta"><span>${esc(j.company||'Company not set yet')}</span><span>📍 ${esc(j.location||'Modesto, CA')}</span>${j.distance?`<span>${esc(j.distance)} mi</span>`:''}${j.pay?`<span>💲 ${esc(j.pay)}</span>`:''}${TAGS[j.transport]||''}</div>
       <div class="job-meta">${j.applied?`<span>Applied ${esc(j.applied)}</span>`:''}${dueInfo(j)}</div>
       ${j.notes?`<div class="job-notes">${esc(j.notes)}</div>`:''}
     </div>
     <div style="display:flex;flex-direction:column;gap:7px;min-width:170px">
       <select class="stage-sel" data-stage="${j.id}" aria-label="Status">${['Saved','Applied','Interview','Offer','Rejected','Archived'].map(s=>`<option ${s===j.stage?'selected':''}>${s}</option>`).join('')}</select>
       <div class="btn-row">
         ${j.url?`<a class="btn btn-small" target="_blank" rel="noopener" href="${esc(j.url)}">Open posting ↗</a>`:''}
         <a class="btn btn-small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/${enc('95355')}/${enc(j.location||'Modesto, CA')}/?travelmode=transit">🚌 Bus route</a>
         <button class="btn btn-small" type="button" data-edit="${j.id}">Edit</button>
         <button class="btn btn-small btn-danger" type="button" data-del="${j.id}">Delete</button>
       </div>
     </div>
   </article>`).join('') || (state.jobs.length?'<p class="muted">No jobs match those filters.</p>':'');
  document.querySelectorAll('[data-stage]').forEach(s=>s.onchange=()=>{ const j=state.jobs.find(x=>x.id===s.dataset.stage); j.stage=s.value; if(s.value==='Applied'&&!j.applied) j.applied=todayISO(); save(); renderTracker(); renderStats(); toast(`Moved to ${s.value}`); });
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openForm(state.jobs.find(x=>x.id===b.dataset.edit)));
  document.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{ if(confirm('Delete this job from your tracker?')){ state.jobs=state.jobs.filter(x=>x.id!==b.dataset.del); save(); renderTracker(); renderStats(); } });
}
function renderStats(){
  const j = state.jobs, due = j.filter(x=>dueInfo(x).includes('overdue')).length;
  const cards = [['Saved jobs', j.filter(x=>x.stage==='Saved').length],['Applied', j.filter(x=>x.stage==='Applied').length],['Interviews', j.filter(x=>x.stage==='Interview').length],['Offers 🎉', j.filter(x=>x.stage==='Offer').length],['Follow-ups overdue', due]];
  $('#stats').innerHTML = cards.map(([k,v])=>`<div class="stat ${k.includes('overdue')&&v?'alert':''}"><b>${v}</b>${k}</div>`).join('');
  $('#heroStats').innerHTML = `<span>📋 ${j.length} job${j.length===1?'':'s'} tracked</span><span>✉️ ${j.filter(x=>x.stage==='Applied').length} applied</span><span>🎤 ${j.filter(x=>x.stage==='Interview').length} interviews</span><span>📍 95355 · ${{ 'no-car':'no car','bus':'by bus', walk:'walking', car:'by car'}[state.transport]}</span>`;
}

/* ── form ──────────────────────────────────────────── */
function openForm(job){
  const f = $('#jobForm'); f.classList.remove('hidden'); $('#formTitle').textContent = job ? 'Edit job' : 'Add a job';
  const v = job || { title:'',company:'',location:'Modesto, CA 95355',pay:'',transport: state.transport==='no-car'?'bus': state.transport, distance:'',stage:'Saved',priority:'Normal',applied:'',follow:'',url:'',notes:'' };
  $('#fId').value = job ? job.id : ''; for (const [id,val] of [['fTitle',v.title],['fCompany',v.company],['fLocation',v.location],['fPay',v.pay],['fTransport',v.transport],['fDistance',v.distance],['fStage',v.stage],['fPriority',v.priority],['fApplied',v.applied],['fFollow',v.follow],['fUrl',v.url],['fNotes',v.notes]]) $('#'+id).value = val||'';
  $('#fTitle').focus();
}
$('#jobForm').addEventListener('submit', e=>{
  e.preventDefault();
  const id = $('#fId').value || Date.now()+''+Math.random().toString(16).slice(2,6);
  const job = { id, title:$('#fTitle').value.trim(), company:$('#fCompany').value.trim(), location:$('#fLocation').value.trim(), pay:$('#fPay').value.trim(), transport:$('#fTransport').value, distance:$('#fDistance').value, stage:$('#fStage').value, priority:$('#fPriority').value, applied:$('#fApplied').value, follow:$('#fFollow').value, url:$('#fUrl').value.trim(), notes:$('#fNotes').value.trim(), created: todayISO() };
  const i = state.jobs.findIndex(x=>x.id===id); if (i>=0) state.jobs[i]=job; else state.jobs.unshift(job);
  save(); $('#jobForm').classList.add('hidden'); renderTracker(); renderStats(); toast('Job saved ✔');
});

/* ── directory, plan, export ───────────────────────── */
function renderDirectory(){
  $('#siteDirectory').innerHTML = DIRECTORY.map(([g,links])=>`<div class="dir-group"><h3>${esc(g)}</h3><div class="dir-links">${links.map(([n,u])=>`<a target="_blank" rel="noopener" href="${u}">${esc(n)} ↗</a>`).join('')}</div></div>`).join('');
}
function renderPlan(){
  $('#planList').innerHTML = PLAN.map(([d,t],i)=>`<label class="plan-item ${state.plan[i]?'done':''}"><input type="checkbox" data-plan="${i}" ${state.plan[i]?'checked':''}><span><b>${esc(d)}:</b> ${esc(t)}</span></label>`).join('');
  document.querySelectorAll('[data-plan]').forEach(c=>c.onchange=()=>{ state.plan[c.dataset.plan]=c.checked; save(); renderPlan(); });
}
function download(name, text, type){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }

/* ── events ────────────────────────────────────────── */
$('#queryInput').addEventListener('input', e=>{ state.query=e.target.value.trim()||'entry level'; save(); renderRec(); renderBoards(); renderRoles(); });
$('#transportSel').addEventListener('change', e=>{ state.transport=e.target.value; save(); renderRec(); renderBoards(); renderStats(); });
$('#typeSel').addEventListener('change', e=>{ state.type=e.target.value; save(); });
$('#siteSearch').addEventListener('input', renderBoards);
$('#jobSearch').addEventListener('input', renderTracker);
$('#stageFilter').addEventListener('change', renderTracker);
$('#transportFilter').addEventListener('change', renderTracker);
$('#addJobBtn').onclick = ()=>openForm(null);
$('#cancelForm').onclick = ()=>$('#jobForm').classList.add('hidden');
$('#demoBtn').onclick = ()=>{ if(state.jobs.some(j=>j.id==='example')) return toast('Example already loaded'); state.jobs.unshift({ id:'example', title:'EXAMPLE — Store Associate', company:'Save Mart (example)', location:'Modesto, CA 95355', pay:'$16–18/hr (example)', transport:'bus', distance:'2', stage:'Saved', priority:'Normal', applied:'', follow:'', url:'', notes:'This is an example so you can see how the tracker works. Edit it or delete it and add your real jobs.', created:todayISO() }); save(); renderTracker(); renderStats(); toast('Example job loaded — try Edit or change its status'); };
$('#exportCsv').onclick = ()=>{ const rows=[['Title','Company','Location','Miles','Transport','Pay','Status','Priority','Applied','Follow-up','Link','Notes'],...state.jobs.map(j=>[j.title,j.company,j.location,j.distance,j.transport,j.pay,j.stage,j.priority,j.applied,j.follow,j.url,(j.notes||'').replace(/\n/g,' ')])]; download('modesto-job-applications.csv', rows.map(r=>r.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n'), 'text/csv'); };
$('#exportJson').onclick = ()=>download('modesto-job-finder-backup.json', JSON.stringify(state,null,2), 'application/json');
$('#importJson').addEventListener('change', async e=>{ const file=e.target.files[0]; if(!file) return; try { const s=JSON.parse(await file.text()); if(!Array.isArray(s.jobs)) throw 0; state=s; save(); location.reload(); } catch { toast('That backup file could not be read.'); } });
$('#printBtn').onclick = ()=>window.print();
$('#resetPlan').onclick = ()=>{ state.plan={}; save(); renderPlan(); toast('New week started — you’ve got this 💪'); };

/* ── init ──────────────────────────────────────────── */
$('#queryInput').value = state.query;
renderRec(); renderRoles(); renderBoards(); renderTracker(); renderStats(); renderDirectory(); renderPlan();
