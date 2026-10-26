"use strict";
/* ---------- Helpers ---------- */
const DAYN=["Vasárnap","Hétfő","Kedd","Szerda","Csütörtök","Péntek","Szombat"];
const DAYS=["V","H","K","Sze","Cs","P","Szo"];
const MON=["jan.","febr.","márc.","ápr.","máj.","jún.","júl.","aug.","szept.","okt.","nov.","dec."];
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const mins=t=>{const[h,m]=t.split(":").map(Number);return h*60+m};
const ymd=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const km=(a,b)=>{const R=6371,r=x=>x*Math.PI/180,dLa=r(b[0]-a[0]),dLo=r(b[1]-a[1]);const h=Math.sin(dLa/2)**2+Math.cos(r(a[0]))*Math.cos(r(b[0]))*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
const massWord=c=>c.rite==="gk"?"Szent Liturgia":"Szentmise";
const riteName=c=>c.rite==="gk"?"görögkatolikus":"római katolikus";

function dayItems(c,date){
  const dow=date.getDay(), key=ymd(date), out=[];
  c.mass.filter(m=>m.d.includes(dow)).forEach(m=>out.push({k:"mass",t:m.t,end:null,what:massWord(c),n:m.n}));
  c.conf.filter(m=>m.d.includes(dow)).forEach(m=>out.push({k:"conf",t:m.f,end:m.u,what:"Gyóntatás",n:m.n}));
  (c.ador||[]).filter(m=>m.d.includes(dow)).forEach(m=>out.push({k:"ador",t:m.f,end:m.u,what:"Szentségimádás",n:m.n}));
  c.ev.filter(e=>e.date===key).forEach(e=>out.push({k:"ev",t:e.t,end:null,what:e.title,n:e.n}));
  return out.sort((a,b)=>mins(a.t)-mins(b.t));
}
function openState(c,now){
  if(!c.hours) return {known:false};
  const dow=now.getDay(), m=now.getHours()*60+now.getMinutes();
  const h=c.hours.find(x=>x.days.includes(dow));
  if(!h) return {known:true,open:false,label:"Ma zárva"};
  if(m>=mins(h.o)&&m<mins(h.c)) return {known:true,open:true,label:"Nyitva "+h.c+"-ig"};
  if(m<mins(h.o)) return {known:true,open:false,label:"Nyit "+h.o+"-kor"};
  return {known:true,open:false,label:"Zárva"};
}
function hoursText(c,dow){if(!c.hours)return "Csak szertartások idején";const h=c.hours.find(x=>x.days.includes(dow));return h?h.o+"–"+h.c:"Zárva"}

/* ---------- State ---------- */
const S={q:"",dayOffset:0,origin:"Budapest",f:{open:false,mass:false,conf:false,ev:false},sel:null,view:"find"};
try{const saved=JSON.parse(localStorage.getItem("harangszo")||"{}");if(saved.origin&&ORIGINS[saved.origin])S.origin=saved.origin}catch(e){}
const now=()=>new Date();
const selDate=()=>{const d=now();d.setDate(d.getDate()+S.dayOffset);return d};
const isToday=()=>S.dayOffset===0;

function filtered(){
  const d=selDate(), q=S.q.trim().toLowerCase(), o=ORIGINS[S.origin];
  const wkEnd=new Date(d);wkEnd.setDate(wkEnd.getDate()+7);
  return CHURCHES.map(c=>{
    const items=dayItems(c,d);
    return {c,items,dist:km(o,[c.lat,c.lon]),os:openState(c,now()),
      hasMass:items.some(i=>i.k==="mass"),hasConf:items.some(i=>i.k==="conf"),
      weekEv:c.ev.some(e=>e.date>=ymd(d)&&e.date<ymd(wkEnd))};
  }).filter(r=>{
    if(q&&!(r.c.name+" "+r.c.city+" "+r.c.addr).toLowerCase().includes(q))return false;
    if(S.f.open&&!(r.os.known&&r.os.open))return false;
    if(S.f.mass&&!r.hasMass)return false;
    if(S.f.conf&&!r.hasConf)return false;
    if(S.f.ev&&!r.weekEv)return false;
    return true;
  }).sort((a,b)=>a.dist-b.dist);
}
function upcoming(items){
  if(!isToday())return items;
  const m=now().getHours()*60+now().getMinutes();
  return items.filter(i=>mins(i.end||i.t)>=m);
}

/* ---------- Rendering: list ---------- */
const panel=$("#panel");
function dayLabel(off){const d=new Date();d.setDate(d.getDate()+off);return off===0?"Ma":off===1?"Holnap":DAYN[d.getDay()]+", "+MON[d.getMonth()]+" "+d.getDate()+"."}
function controlsHTML(){
  const opts=[...Array(8).keys()].map(i=>`<option value="${i}" ${i===S.dayOffset?"selected":""}>${dayLabel(i)}</option>`).join("");
  const ors=Object.keys(ORIGINS).map(k=>`<option ${k===S.origin?"selected":""}>${k}</option>`).join("");
  const chip=(k,cls,label,dot)=>`<button class="chip ${cls}" data-f="${k}" aria-pressed="${S.f[k]}"><span class="dot" style="background:${dot}"></span>${label}</button>`;
  return `<div class="controls pad">
    <div class="row">
      <label class="search" for="q"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Templom vagy település" value="${esc(S.q)}" autocomplete="off"></label>
    </div>
    <div class="row">
      <select id="day" class="sel" aria-label="Nap">${opts}</select>
      <select id="origin" class="sel" aria-label="Távolság innen">${ors}</select>
    </div>
    <div class="chips" role="group" aria-label="Szűrők">
      ${chip("conf","conf","Gyóntatás","var(--penance)")}${chip("mass","mass","Mise","var(--accent)")}${isToday()?chip("open","open","Most nyitva","var(--open)"):""}${chip("ev","ev","Esemény a héten","var(--gold)")}
    </div>
    <div class="summary" id="summary"></div>
  </div>`;
}
function cardHTML(r){
  const up=upcoming(r.items).filter(i=>i.k!=="ador").slice(0,3);
  const pills=up.map(i=>`<span class="pill p-${i.k}"><span class="t">${i.t}</span>${i.k==="mass"?"mise":i.k==="conf"?"gyónás":esc(i.what.length>24?i.what.slice(0,22)+"…":i.what)}</span>`).join("")
    ||`<span class="pill p-closed">${isToday()?"Ma már nincs több alkalom":"Nincs alkalom ezen a napon"}</span>`;
  const os=isToday()?(r.os.known?`<span class="pill ${r.os.open?"p-open":"p-closed"}">${r.os.label}</span>`:`<span class="pill p-closed">Szertartásokkor nyitva</span>`):"";
  const rite=r.c.rite==="gk"?`<span class="pill p-rite">görögkatolikus</span>`:"";
  return `<li><button class="card" data-id="${r.c.id}" aria-current="${S.sel===r.c.id}">
    <div class="card-top"><div><h3>${esc(r.c.name)}</h3><div class="where">${esc(r.c.city)}, ${esc(r.c.addr)}</div></div><span class="dist">${r.dist<1?"<1":Math.round(r.dist)} km</span></div>
    <div class="next">${os}${rite}${pills}</div></button></li>`;
}
function renderList(){
  const rows=filtered();
  panel.innerHTML=controlsHTML()+`<ul class="list pad">${rows.map(cardHTML).join("")||`<li class="empty">Nincs a szűrőknek megfelelő templom. Próbálj másik napot vagy kapcsolj ki egy szűrőt.</li>`}</ul>`;
  const nConf=rows.filter(r=>r.hasConf).length;
  $("#summary").textContent=`${rows.length} templom · ${nConf} helyen gyóntatnak ${isToday()?"ma":"aznap"} · távolság: ${S.origin}`;
  bindControls(); drawMarkers(rows);
}
function bindControls(){
  const q=$("#q");
  q.addEventListener("input",e=>{S.q=e.target.value;const pos=e.target.selectionStart;renderList();const n=$("#q");n.focus();try{n.setSelectionRange(pos,pos)}catch(_){}});
  $("#day").addEventListener("change",e=>{S.dayOffset=+e.target.value;if(!isToday())S.f.open=false;render()});
  $("#origin").addEventListener("change",e=>{S.origin=e.target.value;try{localStorage.setItem("harangszo",JSON.stringify({origin:S.origin}))}catch(_){}render()});
  panel.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{S.f[b.dataset.f]=!S.f[b.dataset.f];renderList()}));
  panel.querySelectorAll(".card").forEach(b=>b.addEventListener("click",()=>select(+b.dataset.id,true)));
}

/* ---------- Rendering: detail ---------- */
function weekTable(c){
  const today=now().getDay();
  return [1,2,3,4,5,6,0].map(dow=>{
    const ms=c.mass.filter(m=>m.d.includes(dow)).map(m=>m.t).sort((a,b)=>mins(a)-mins(b)).join(", ")||"–";
    const cs=c.conf.filter(m=>m.d.includes(dow)).map(m=>m.f+"–"+m.u).join(", ");
    return `<tr class="${dow===today?"today":""}"><th scope="row">${DAYN[dow].slice(0,3)}.</th><td>${ms}${cs?`<br><span class="c">gyón. ${cs}</span>`:""}</td><td>${hoursText(c,dow)}</td></tr>`;
  }).join("");
}
function renderDetail(){
  const c=CHURCHES.find(x=>x.id===S.sel); if(!c){S.sel=null;return renderList()}
  const d=selDate(), items=dayItems(c,d), m=now().getHours()*60+now().getMinutes();
  const os=openState(c,now());
  const slots=items.map(i=>{const past=isToday()&&mins(i.end||i.t)<m;
    return `<div class="slot ${past?"past":""}"><span class="t">${i.t}${i.end?"–<br>"+i.end:""}</span><div><div class="k k-${i.k}">${i.k==="mass"?massWord(c):i.k==="conf"?"Gyóntatás":i.k==="ador"?"Szentségimádás":"Esemény"}</div><div class="what">${i.k==="mass"||i.k==="conf"||i.k==="ador"?(esc(i.n)||""):esc(i.what)}</div>${i.k==="ev"&&i.n?`<div class="note">${esc(i.n)}</div>`:""}</div></div>`}).join("")
    ||`<div class="slot"><span class="t">–</span><div class="what muted">Nincs meghirdetett alkalom ezen a napon.</div></div>`;
  const evs=c.ev.filter(e=>e.date>=ymd(now())).sort((a,b)=>a.date.localeCompare(b.date)).map(e=>{const dt=new Date(e.date+"T12:00");
    return `<div class="ev"><div class="date"><b>${dt.getDate()}</b><small>${MON[dt.getMonth()]}</small></div><div><h5>${esc(e.title)}</h5><div class="muted">${DAYN[dt.getDay()]}, ${e.t}${e.n?" · "+esc(e.n):""}</div></div></div>`}).join("")
    ||`<p class="muted">Nincs meghirdetett esemény. Ha tudsz egyről, küldd be lent.</p>`;
  const dir=`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  panel.innerHTML=`<div class="detail pad">
    <button class="back" id="back">← Vissza a listához</button>
    <div class="d-head">
      <div class="next">${os.known?`<span class="pill ${os.open?"p-open":"p-closed"}">${os.label}</span>`:`<span class="pill p-closed">Szertartások idején nyitva</span>`}<span class="pill p-rite">${riteName(c)}</span></div>
      <h2>${esc(c.name)}</h2>
      <div class="where">${esc(c.city)}, ${esc(c.addr)} · ${Math.round(km(ORIGINS[S.origin],[c.lat,c.lon]))} km (${esc(S.origin)})</div>
    </div>
    <div class="actions"><a class="btn primary" href="${dir}" target="_blank" rel="noopener noreferrer">Útvonal a Google Térképen</a><button class="btn" id="go-suggest">Javítás beküldése</button></div>
    <div class="sec"><h4>${dayLabel(S.dayOffset)}</h4><div class="dayline">${slots}</div></div>
    <div class="sec"><h4>Heti rend</h4><div class="week"><table><tbody>${weekTable(c)}</tbody></table></div></div>
    <div class="sec"><h4>Közelgő események</h4><div class="ev-list">${evs}</div></div>
    <div class="sec" id="suggest-sec"><h4>Pontosítás vagy új időpont</h4>${suggestForm(c)}</div>
  </div>`;
  $("#back").addEventListener("click",()=>{S.sel=null;render()});
  $("#go-suggest").addEventListener("click",()=>{$("#suggest-sec").scrollIntoView({behavior:"smooth",block:"start"});setTimeout(()=>$("#s-text")?.focus(),300)});
  bindSuggest(c);
  drawMarkers(filtered());
  panel.scrollTop=0;
}

/* ---------- Community suggestions (GitHub Issues for now) ---------- */
const CFG=window.HARANGSZO_CONFIG||{};
const REPO=CFG.repo||"szbaliint/harangszo";
const TYPES={conf:"Gyóntatási időpont",mass:"Mise időpont",hours:"Nyitvatartás",event:"Esemény",place:"Hely vagy egyéb"};
function suggestForm(c){
  return `<form class="suggest" id="s-form" novalidate>
    <label for="s-type">Mit javítanál?<select id="s-type">${Object.entries(TYPES).map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}</select></label>
    <label for="s-text">Leírás<textarea id="s-text" maxlength="600" placeholder="Pl. Szerdánként 17:00–18:00 között is gyóntatnak, a hirdetőtábla szerint."></textarea></label>
    <div class="row"><button class="btn primary" type="submit" id="s-send">Javaslat beküldése</button><span class="status" id="s-status"></span></div>
    <p class="muted" style="margin:0">A beküldés egy GitHub-hibajegyet nyit meg kitöltve (GitHub-fiók kell hozzá). Később saját űrlap váltja ki.</p>
  </form>`;
}
function bindSuggest(c){
  const f=$("#s-form"), st=$("#s-status");
  f.addEventListener("submit",e=>{
    e.preventDefault();
    const text=$("#s-text").value.trim();
    if(text.length<5){st.textContent="Írj legalább pár szót arról, mi változott.";st.className="status err";return}
    const type=TYPES[$("#s-type").value];
    const title=`[${type}] ${c.name} (${c.city})`;
    const body=`**Templom:** ${c.name}, ${c.city}, ${c.addr} (id: ${c.id})\n**Típus:** ${type}\n\n${text}`;
    const url=`https://github.com/${REPO}/issues/new?labels=javaslat&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url,"_blank","noopener");
    st.textContent="Megnyitottuk a beküldő oldalt egy új lapon.";st.className="status ok";
  });
}

/* ---------- Map: Google Maps when a key is configured, otherwise OpenStreetMap via Leaflet ---------- */
const KEY=(CFG.googleMapsKey&&!CFG.googleMapsKey.startsWith("__"))?CFG.googleMapsKey:"";
const HU_BOUNDS={s:45.7,w:16.1,n:48.6,e:22.9};
const pinSVG=(fill,sel)=>"data:image/svg+xml;charset=UTF-8,"+encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38"><path d="M15 37C15 37 3 22 3 14a12 12 0 0 1 24 0c0 8-12 23-12 23z" fill="${fill}" stroke="${sel?"#c9971c":"#fff"}" stroke-width="${sel?3:2}"/><path d="M14 7h2v14h-2zM10 11h10v2H10z" fill="#fff"/></svg>`);
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MapView=KEY?googleView():(typeof L!=="undefined"?leafletView():{draw(){},focus(){}});
if(!KEY&&typeof L==="undefined")document.getElementById("map").innerHTML='<p style="padding:16px;color:var(--ink-3)">A térkép nem töltődött be. A lista ettől még használható.</p>';

function leafletView(){
  const map=L.map("map",{minZoom:6,maxZoom:18,zoomSnap:.25,maxBounds:[[44.9,15.3],[49.4,23.8]]});
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
  map.fitBounds([[HU_BOUNDS.s,HU_BOUNDS.w],[HU_BOUNDS.n,HU_BOUNDS.e]]);
  const layer=L.layerGroup().addTo(map);
  window.addEventListener("resize",()=>map.invalidateSize());
  return{
    draw(list){layer.clearLayers();list.forEach(p=>{
      const mk=L.marker([p.c.lat,p.c.lon],{title:p.c.name,riseOnHover:true,zIndexOffset:p.sel?1000:0,
        icon:L.divIcon({className:"",html:`<div class="pin ${p.cls} ${p.sel?"sel":""}"><i></i></div>`,iconSize:[26,26],iconAnchor:[13,26]})});
      mk.on("click",()=>select(p.c.id,false));layer.addLayer(mk);})},
    focus(lat,lon,z){map.flyTo([lat,lon],Math.max(map.getZoom(),z),{duration:.5})}
  };
}
function googleView(){
  let gmap=null,markers=[],pending=null,pendingFocus=null;
  window.__initGoogle=()=>{
    gmap=new google.maps.Map(document.getElementById("map"),{center:{lat:47.16,lng:19.5},zoom:7,
      restriction:{latLngBounds:{north:49.4,south:44.9,west:15.3,east:23.8}},mapTypeControl:false,streetViewControl:false,fullscreenControl:false,clickableIcons:false});
    gmap.fitBounds({north:HU_BOUNDS.n,south:HU_BOUNDS.s,west:HU_BOUNDS.w,east:HU_BOUNDS.e});
    if(pending)api.draw(pending);if(pendingFocus)api.focus(...pendingFocus);
  };
  window.gm_authFailure=()=>{document.querySelector(".notice").innerHTML="<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását.";};
  const s=document.createElement("script");
  s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&callback=__initGoogle&language=hu&region=HU&loading=async`;
  s.async=true;document.head.appendChild(s);
  const colors={conf:()=>css("--penance")||"#6a2e8c","":()=>css("--accent")||"#23408e",dim:()=>css("--ink-3")||"#7b8496"};
  const api={
    draw(list){if(!gmap){pending=list;return}
      markers.forEach(m=>m.setMap(null));
      markers=list.map(p=>{const m=new google.maps.Marker({position:{lat:p.c.lat,lng:p.c.lon},map:gmap,title:p.c.name,zIndex:p.sel?1000:1,
        icon:{url:pinSVG(colors[p.cls](),p.sel),scaledSize:new google.maps.Size(30,38),anchor:new google.maps.Point(15,37)}});
        m.addListener("click",()=>select(p.c.id,false));return m;});},
    focus(lat,lon,z){if(!gmap){pendingFocus=[lat,lon,z];return}gmap.panTo({lat,lng:lon});if(gmap.getZoom()<z)gmap.setZoom(z)}
  };
  return api;
}
function drawMarkers(rows){
  const list=rows.map(r=>({c:r.c,cls:r.hasConf?"conf":(r.hasMass||r.items.length)?"":"dim",sel:S.sel===r.c.id}));
  if(S.sel&&!list.some(p=>p.sel)){const c=CHURCHES.find(x=>x.id===S.sel);if(c)list.push({c,cls:"",sel:true})}
  MapView.draw(list);
}
function select(id){
  S.sel=id;
  const c=CHURCHES.find(x=>x.id===id);
  if(c)MapView.focus(c.lat,c.lon,c.city==="Budapest"||c.city==="Székesfehérvár"?14:12);
  render();
}

/* ---------- Boot ---------- */
function render(){S.sel?renderDetail():renderList()}
document.getElementById("issues-link").href=`https://github.com/${REPO}/issues?q=label%3Ajavaslat`;
render();
setInterval(()=>{if(isToday()&&!document.activeElement?.matches("input,textarea,select"))render()},60000);
