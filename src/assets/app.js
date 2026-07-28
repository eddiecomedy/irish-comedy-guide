/* ============================================================
   Irish Comedy Guide — front-end app
   Data is injected by the build as <script id="icg-data" type="application/json">.
   Nothing here talks to a server; the whole site is static.
   ============================================================ */
const ICG = JSON.parse(document.getElementById("icg-data").textContent);
const day = 86400000, now = new Date();
const YT = "https://www.youtube.com/@craicdencomedyclub";
const VENUES = ICG.venues;
const COMEDIANS = ICG.comedians;
const TOURNEWS = ICG.tourNews;
const NEWSITEMS = ICG.news;
const RESOURCES = ICG.resources;
const FALLBACK_VENUE = { name: "Venue TBC", city: "", g: ["#0B1B2E", "#132a45"], nights: "" };

const SHOWS = ICG.shows.map((s, i) => {
  const dt = new Date(s.start.length === 10 ? s.start + "T20:00" : s.start);
  const venue = VENUES.find(v => v.id === s.v) || FALLBACK_VENUE;
  const com = s.com || ((s.type === "Tour show" && s.lineup && s.lineup.length === 1) ? s.lineup[0] : null);
  return Object.assign({}, s, { id: i, dt, venue, com, slug: s.slug });
});
const sym = s => (s.currency || s.venue.currency) === "GBP" ? "\u00a3" : "\u20ac";
function priceLabel(s, long) {
  if (s.price === 0) return "Free";
  if (s.price == null) return long ? "Price TBC" : "TBC";
  return sym(s) + s.price;
}
function timeLabel(s) { return s.timeConfirmed === false ? "Time TBC" : fmtTime(s.dt); }

/* ================= HELPERS ================= */
const fmtDay=dt=>dt.toLocaleDateString("en-IE",{weekday:"long",day:"numeric",month:"long"});
const fmtTime=dt=>dt.toLocaleTimeString("en-IE",{hour:"numeric",minute:"2-digit"}).toLowerCase().replace(" ","");
const fmtShort=dt=>dt.toLocaleDateString("en-IE",{weekday:"short",day:"numeric",month:"short"});
const isSameDay=(a,b)=>a.toDateString()===b.toDateString();
function inWhen(dt,mode){
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  if(mode.indexOf("m:")===0){
    const parts=mode.slice(2).split("-");
    return dt.getFullYear()===+parts[0] && dt.getMonth()===+parts[1]-1;
  }
  if(mode==="tonight")return isSameDay(dt,now);
  if(mode==="week")return dt-today<7*day&&dt>=today;
  if(mode==="weekend"){
    const dow=today.getDay();
    const fri=new Date(today);fri.setDate(today.getDate()+((5-dow+7)%7));
    if(dow===6||dow===0)fri.setDate(today.getDate());
    const end=new Date(fri.getTime()+((7-fri.getDay())%7||2)*day+day);
    return dt>=fri&&dt<end;
  }
  return true;
}
const grad=g=>`linear-gradient(135deg,${g[0]},${g[1]})`;
const initials=n=>n.split(/\s+/).map(w=>w[0]).join("").replace(/[^A-Za-zÁÉÍÓÚáéíóú]/g,"").slice(0,3);
const esc=s=>String(s).replace(/'/g,"\\'");
const slugify=s=>String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");

/* ================= NAV ================= */
let mapInit=false;
function go(v){
  document.getElementById("ddmenu").classList.remove("open");
  closeDrawer();
  document.querySelectorAll("main").forEach(m=>m.classList.add("hidden"));
  document.getElementById("view-"+v).classList.remove("hidden");
  document.querySelectorAll("nav>button").forEach(b=>b.classList.toggle("active",b.dataset.v===v));
  if(v==="map")initMap();
  window.scrollTo({top:0});
}
function toggleMore(e){e.stopPropagation();document.getElementById("ddmenu").classList.toggle("open");}
document.addEventListener("click",()=>document.getElementById("ddmenu").classList.remove("open"));
function openDrawer(){document.getElementById("drawer").classList.add("open");}
function closeDrawer(){document.getElementById("drawer").classList.remove("open");}
addEventListener("scroll",()=>document.getElementById("hdr").classList.toggle("scrolled",scrollY>12));

/* ---- hero parallax: layers drift at different speeds as you scroll ---- */
(function(){
  const reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduce)return;
  const layers=[["pl-photo",.10],["pl-rig",.20],["pl-mic",.38]];
  let ticking=false;
  function frame(){
    ticking=false;
    const hero=document.querySelector(".hero");
    if(!hero)return;
    const y=window.scrollY;
    if(y>hero.offsetHeight+200)return;
    layers.forEach(([id,rate])=>{
      const el=document.getElementById(id);
      if(el)el.style.transform="translate3d(0,"+(y*rate).toFixed(1)+"px,0)";
    });
    const g=document.querySelector(".hgrid");
    if(g){
      if(innerWidth>=980){g.style.transform="translate3d(0,"+(y*-.05).toFixed(1)+"px,0)";}
      else{g.style.transform="";}
      g.style.opacity="";
    }
  }
  addEventListener("scroll",()=>{if(!ticking){ticking=true;requestAnimationFrame(frame);}},{passive:true});
  frame();
})();

let heroWhen="";
function monthList(n){
  const out=[],base=new Date(now.getFullYear(),now.getMonth(),1);
  for(let i=0;i<n;i++){
    const m=new Date(base.getFullYear(),base.getMonth()+i,1);
    const opts={month:"long"};
    if(m.getFullYear()!==now.getFullYear())opts.year="numeric";
    out.push({v:"m:"+m.getFullYear()+"-"+(m.getMonth()+1),label:m.toLocaleDateString("en-IE",opts)});
  }
  return out;
}
function buildMonths(){
  const nm=new Date(now.getFullYear(),now.getMonth()+1,1);
  const nmv="m:"+nm.getFullYear()+"-"+(nm.getMonth()+1);
  const btn=document.getElementById("q-nextmonth");
  btn.textContent="In "+nm.toLocaleDateString("en-IE",{month:"long"});
  btn.onclick=()=>quick({when:nmv});
  const months=monthList(8);
  const hm=document.getElementById("h-month");
  hm.innerHTML='<option value="">Pick a month…</option>'+months.map(m=>`<option value="${m.v}">${m.label}</option>`).join("");
  const fw=document.getElementById("f-when");
  const og=document.createElement("optgroup");og.label="By month";
  months.forEach(m=>{const o=document.createElement("option");o.value=m.v;o.textContent=m.label;og.appendChild(o);});
  fw.appendChild(og);
}
function pickWhen(btn){
  const on=btn.classList.contains("on");
  document.querySelectorAll("#h-when-set button").forEach(b=>b.classList.remove("on"));
  if(!on){btn.classList.add("on");heroWhen=btn.dataset.w;}else{heroWhen="";}
  document.getElementById("h-month").value="";
}
function pickMonth(){
  const v=document.getElementById("h-month").value;
  if(v){document.querySelectorAll("#h-when-set button").forEach(b=>b.classList.remove("on"));heroWhen=v;}
  else heroWhen="";
}
function findGigs(){
  document.getElementById("f-city").value=document.getElementById("h-city").value;
  document.getElementById("f-when").value=heroWhen;
  document.getElementById("f-type").value=document.getElementById("h-type").value;
  render();
  document.getElementById("listings-sec").scrollIntoView({behavior:"smooth",block:"start"});
}
function quick(o){
  clearFilters(true);
  if(o.city)document.getElementById("f-city").value=o.city;
  if(o.type)document.getElementById("f-type").value=o.type;
  if(o.when)document.getElementById("f-when").value=o.when;
  if(o.free)document.getElementById("f-free").checked=true;
  render();
  document.getElementById("listings-sec").scrollIntoView({behavior:"smooth",block:"start"});
}
function clearFilters(quiet){
  document.getElementById("f-city").value="";
  document.getElementById("f-type").value="";
  document.getElementById("f-when").value="";
  document.getElementById("f-free").checked=false;
  document.getElementById("f-q").value="";
  document.querySelectorAll("#h-when-set button").forEach(b=>b.classList.remove("on"));
  document.getElementById("h-month").value="";heroWhen="";
  if(!quiet)render();
}

/* ================= MAP ================= */
/* Big, readable city labels drawn by us — so a visitor can find their city at a glance */
const CITIES=[
 {n:"Dublin",c:[53.3498,-6.2603],major:true},
 {n:"Belfast",c:[54.5973,-5.9301],major:true},
 {n:"Cork",c:[51.8985,-8.4756],major:true},
 {n:"Galway",c:[53.2707,-9.0568],major:true},
 {n:"Limerick",c:[52.6638,-8.6267],major:true},
 {n:"Waterford",c:[52.2593,-7.1101]},
 {n:"Derry",c:[54.9966,-7.3086]},
 {n:"Sligo",c:[54.2766,-8.4761]},
 {n:"Kilkenny",c:[52.6541,-7.2448]},
 {n:"Wexford",c:[52.3369,-6.4633]},
 {n:"Athlone",c:[53.4239,-7.9407]},
 {n:"Killarney",c:[52.0599,-9.5044]}
];
function initMap(){
  if(typeof L==="undefined")return;
  if(mapInit){setTimeout(()=>window._icgmap.invalidateSize(),80);return;}
  mapInit=true;
  const map=L.map("map",{scrollWheelZoom:true,minZoom:6}).setView([53.55,-7.7],7);
  window._icgmap=map;
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
    {maxZoom:19,subdomains:"abcd",attribution:"© OpenStreetMap contributors © CARTO"}).addTo(map);
  map.createPane("cities");map.getPane("cities").style.zIndex=650;map.getPane("cities").style.pointerEvents="none";
  CITIES.forEach(c=>{
    L.marker(c.c,{
      pane:"cities",interactive:false,keyboard:false,
      icon:L.divIcon({className:"citylabel"+(c.major?"":" minor"),html:`<span>${c.n}</span>`,iconSize:[0,0],iconAnchor:[0,26]})
    }).addTo(map);
  });
  function labelScale(){
    const z=map.getZoom();
    document.getElementById("map").classList.toggle("zoomed",z>=10);
    document.getElementById("map").classList.toggle("faraway",z<=6);
  }
  map.on("zoomend",labelScale);labelScale();
  VENUES.filter(v=>v.club).forEach(v=>{
    const mk=L.circleMarker(v.coords,{radius:v.featured?13:9,color:"#fff",weight:3,fillColor:v.featured?"#F26522":"#0F7A4A",fillOpacity:1}).addTo(map);
    const n=SHOWS.filter(s=>s.v===v.id&&s.dt>=now).length;
    mk.bindPopup(`<div class="pop-name">${v.name}${v.featured?" ★":""}</div><div class="pop-meta">${v.city} · ${v.nights} · ${n} upcoming show${n===1?"":"s"}</div><button class="btn btn-green btn-sm" onclick="openVenue('${v.id}')">View club &amp; listings</button>`);
  });
  setTimeout(()=>map.invalidateSize(),120);
}

/* ================= FEATURED ================= */
function drawFeatured(){
  const shows=SHOWS.filter(s=>s.venue.featured&&s.dt>=now).sort((a,b)=>a.dt-b.dt).slice(0,4);
  document.getElementById("frow").innerHTML=shows.map(s=>`
    <div class="fcard" onclick="openShow(${s.id})">
      <div class="fposter" style="background:${grad(s.venue.g)}">
        <span class="pill pill-orange tag">Featured</span>
        <span class="big">${initials(s.t)}</span>
      </div>
      <div class="fbody">
        <div class="when">${fmtShort(s.dt)} · ${timeLabel(s)}</div>
        <div class="t">${s.t}</div>
        <div class="m">${s.venue.name}, ${s.venue.city}</div>
        <div class="pricerow"><b>${priceLabel(s)}</b><span>Details →</span></div>
      </div>
    </div>`).join("");
}

/* ================= COMEDIANS ================= */
function comedianShows(name){
  return SHOWS.filter(s => s.com === name || (s.lineup||[]).some(n => n.replace(/\s*\(MC\)\s*/,"").trim() === name))
              .filter(s => s.dt >= now).sort((a,b) => a.dt - b.dt);
}
function onTour(c){ return comedianShows(c.name).length > 0; }
function photo(c){
  return c.img ? `<img src="${c.img}" alt="${c.name}" loading="lazy">`
               : `<div class="nophoto"><span>${initials(c.name)}</span></div>`;
}
function tourCard(c){
  const gigs = comedianShows(c.name), next = gigs[0];
  return `<div class="ccard" onclick="openComedian('${esc(c.name)}')">
    <div class="cphoto">
      ${photo(c)}
      <span class="pill pill-orange badge">${gigs.length} date${gigs.length===1?"":"s"}</span>
      <div class="over"><div class="n">${c.name}</div><div class="tn">${next.venue.city || next.venue.name}</div></div>
    </div>
    <div class="cbody"><div class="nx"><span class="d"></span>Next: ${fmtShort(next.dt)} · ${next.venue.name}</div></div>
  </div>`;
}
function drawTours(){
  const t=COMEDIANS.filter(onTour).sort((a,b)=>comedianShows(b.name).length-comedianShows(a.name).length);
  document.getElementById("tourrow").innerHTML=t.slice(0,4).map(tourCard).join("");
  document.getElementById("tourfull").innerHTML=t.map(tourCard).join("")||'<p style="color:var(--muted)">No touring dates listed at the moment.</p>';
}
function dirCard(c){
  const gigs=comedianShows(c.name);
  return `<div class="ccard" onclick="openComedian('${esc(c.name)}')">
    <div class="cphoto">
      ${photo(c)}
      ${gigs.length?`<span class="pill pill-orange badge">${gigs.length} date${gigs.length===1?"":"s"}</span>`:""}
      <div class="over"><div class="n">${c.name}</div><div class="tn">${c.from||""}</div></div>
    </div>
    <div class="cbody"><div class="bio">${c.bio || (gigs.length ? "Next: "+fmtShort(gigs[0].dt)+" at "+gigs[0].venue.name : "No dates listed right now.")}</div></div>
  </div>`;
}
function drawDirectory(){
  document.getElementById("cdir").innerHTML=COMEDIANS.map(dirCard).join("");
}
function openComedian(name){
  const c=COMEDIANS.find(x=>x.name===name)||{name:name};
  const gigs=comedianShows(name);
  document.getElementById("modal").innerHTML=`
    <button class="close" onclick="closeModal()">\u2715</button>
    <div class="mhero" style="background:${grad(["#173B60","#0B1B2E"])}">
      <div class="mtop">${c.from||"Comedian"}${gigs.length?" \u00b7 "+gigs.length+" upcoming date"+(gigs.length===1?"":"s"):""}</div>
    </div>
    <div class="mbody">
      ${c.img?`<img class="mphoto" src="${c.img}" alt="${c.name}">`:""}
      <h2>${c.name}</h2>
      ${c.bio?`<p class="desc">${c.bio}</p>`:""}
      <div class="mbox"><b>Upcoming dates</b>
        ${gigs.map(s=>`<div class="line" onclick="openShow(${s.id})"><span>${s.venue.name}, ${s.venue.city}</span><span class="r">${fmtShort(s.dt)} \u00b7 ${priceLabel(s)}</span></div>`).join("")||'<div class="line">No dates listed yet \u2014 check back soon.</div>'}
      </div>
      <a class="btn btn-orange" href="/comedians/${slugify(c.name)}/">Full profile \u2192</a>
      <p class="mnote">Photos and bios via craicdencomedyclub.com where available.</p>
    </div>`;
  document.getElementById("overlay").classList.add("open");
}

/* ================= LISTINGS ================= */
function dayLabel(dt){
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const diff=Math.round((new Date(dt.getFullYear(),dt.getMonth(),dt.getDate())-today)/day);
  if(diff===0)return{label:"Tonight",sub:dt.toLocaleDateString("en-IE",{weekday:"long",day:"numeric",month:"long"}),today:true};
  if(diff===1)return{label:"Tomorrow",sub:dt.toLocaleDateString("en-IE",{weekday:"long",day:"numeric",month:"long"}),today:false};
  return{label:fmtDay(dt),sub:"",today:false};
}
function showRow(s){
  return `<div class="srow${s.venue.featured?" feat":""}" onclick="openShow(${s.id})">
    <div class="dtile">
      <div class="mo">${s.dt.toLocaleDateString("en-IE",{month:"short"})}</div>
      <div class="dd">${s.dt.getDate()}</div>
      <div class="dw">${s.dt.toLocaleDateString("en-IE",{weekday:"short"})}</div>
    </div>
    <div class="thumb" style="background:${grad(s.venue.g)}">${s.img?`<img src="${s.img}" alt="">`:initials(s.t)}</div>
    <div class="sbody">
      <div class="t">${s.t}</div>
      <div class="v"><span class="time">${timeLabel(s)}</span><span class="sep"></span>${s.venue.name}<span class="sep"></span>${s.venue.city}</div>
      <div class="tags">
        ${s.venue.featured?'<span class="tag feat">Featured</span>':""}
        <span class="tag type">${s.type}</span>
        ${s.price===0?'<span class="tag free">Free entry</span>':""}
      </div>
    </div>
    <div class="sright">
      <div class="pr">${priceLabel(s)}<small>${s.price===0?"just turn up":"at the venue"}</small></div>
      <span class="btn btn-orange btn-sm">${s.soldOut?"Sold out":"Details →"}</span>
    </div>
  </div>`;
}
function render(){
  const city=document.getElementById("f-city").value,
        type=document.getElementById("f-type").value,
        when=document.getElementById("f-when").value,
        free=document.getElementById("f-free").checked,
        q=document.getElementById("f-q").value.trim().toLowerCase();
  let list=SHOWS.filter(s=>s.dt>=new Date(now-2*3600000));
  if(city)list=list.filter(s=>s.venue.city===city);
  if(type)list=list.filter(s=>s.type===type);
  if(when)list=list.filter(s=>inWhen(s.dt,when));
  if(free)list=list.filter(s=>s.price===0);
  if(q)list=list.filter(s=>(s.t+s.venue.name+s.venue.city+s.lineup.join(" ")).toLowerCase().includes(q));
  list.sort((a,b)=>a.dt-b.dt);

  const active=!!(city||type||when||free||q);
  document.getElementById("clearf").classList.toggle("hidden",!active);
  document.getElementById("count").innerHTML=list.length
    ? `<b>${list.length}</b> show${list.length===1?"":"s"} found${city?" in "+city:""}`
    : "Nothing matches those filters.";

  if(!list.length){
    document.getElementById("listings").innerHTML=`<div class="empty"><div class="e">🎤</div>
      <h3>No shows match that</h3><p>Try widening the date range, or clearing a filter or two.</p>
      <button class="btn btn-navy btn-sm" style="margin-top:16px" onclick="clearFilters()">Clear filters</button></div>`;
  }else{
    const groups=[];
    list.forEach(s=>{
      const k=s.dt.toDateString();
      let g=groups.find(x=>x.k===k);
      if(!g){g={k,dt:s.dt,items:[]};groups.push(g);}
      g.items.push(s);
    });
    document.getElementById("listings").innerHTML=groups.map(g=>{
      const L=dayLabel(g.dt);
      return `<div class="daygroup">
        <div class="dayhead">
          ${L.today?'<span class="today">Tonight</span>':""}
          <h3>${L.today?L.sub:L.label}</h3>
          <div class="rule"></div>
          <span class="n">${g.items.length} show${g.items.length===1?"":"s"}</span>
        </div>
        ${g.items.map(showRow).join("")}
      </div>`;
    }).join("");
  }
  const total=SHOWS.filter(s=>s.dt>=now).length;
  document.getElementById("st-shows").textContent=total;
  document.getElementById("st-venues").textContent=VENUES.length;
  document.getElementById("ts-count").textContent=total;
}

/* ================= SHOW MODAL ================= */
function openShow(id){
  if(window.event)window.event.stopPropagation();
  const s=SHOWS.find(x=>x.id===id);
  document.getElementById("modal").innerHTML=`
    <button class="close" onclick="closeModal()">✕</button>
    <div class="mhero" style="background:${grad(s.venue.g)}">
      <div class="mtop">${fmtDay(s.dt)} · ${timeLabel(s)}${s.venue.featured?" · Featured":""}</div>
    </div>
    <div class="mbody">
      ${s.img?`<img class="mphoto" src="${s.img}" alt="">`:""}
      <h2>${s.t}</h2>
      <div class="mv">${s.venue.name}, ${s.venue.city} · ${s.type}</div>
      <p class="desc">${s.desc}</p>
      <div class="mbox"><b>Line-up</b><div class="line"><span>${s.lineup.join(" · ")}</span></div></div>
      <div class="mactions">
        ${s.ticketUrl?`<a class="btn btn-orange btn-lg" href="${s.ticketUrl}" target="_blank" rel="noopener">${s.price===0?"Free entry — just show up":"Tickets · "+priceLabel(s,1)}</a>`:`<span class="btn btn-orange btn-lg" style="opacity:.6">${priceLabel(s,1)}</span>`}
      <a class="btn btn-ghost btn-lg" href="/shows/${s.slug}/">Full details</a>
        <button class="btn btn-ghost btn-lg" onclick="openVenue('${s.v}')">Venue info</button>
      </div>
      <p class="mnote">Listed ${s.verifiedAt||"recently"} from <a href="${s.sourceUrl}" target="_blank" rel="noopener">the venue’s own listing</a>. Always check the venue before travelling.</p>
    </div>`;
  document.getElementById("overlay").classList.add("open");
}

/* ================= CLUBS & VENUES ================= */
function clubCard(v){
  const n=SHOWS.filter(s=>s.v===v.id&&s.dt>=now).length;
  return `<div class="clubcard" onclick="openVenue('${v.id}')">
    <div class="clubtop" style="background:${grad(v.g)}">
      <span class="in">${initials(v.name)}</span>
      ${v.featured?'<span class="pill pill-orange tag">Featured</span>':""}
    </div>
    <div class="clubbody">
      <h3>${v.name}</h3>
      <span class="nights">${v.nights}</span>
      <div class="n"><span>${n} upcoming show${n===1?"":"s"}</span><span>→</span></div>
    </div></div>`;
}
const CITY_ORDER=["Dublin","Cork","Galway","Limerick","Belfast"];
function byCity(list){
  const groups=[];
  list.forEach(v=>{
    let g=groups.find(x=>x.city===v.city);
    if(!g){g={city:v.city,items:[]};groups.push(g);}
    g.items.push(v);
  });
  groups.sort((a,b)=>{
    const ia=CITY_ORDER.indexOf(a.city), ib=CITY_ORDER.indexOf(b.city);
    if(ia<0&&ib<0)return a.city.localeCompare(b.city);
    if(ia<0)return 1; if(ib<0)return -1; return ia-ib;
  });
  return groups;
}
function cityBlocks(list){
  return byCity(list).map(g=>`
    <div class="citygroup">
      <div class="ch">
        <h2>${g.city} comedy clubs</h2>
        <div class="rule"></div>
        <span class="n">${g.items.length} club${g.items.length===1?"":"s"}</span>
      </div>
      <div class="clubgrid">${g.items.map(clubCard).join("")}</div>
    </div>`).join("");
}
function drawClubs(){
  document.getElementById("clubgrid").innerHTML=cityBlocks(VENUES.filter(v=>v.club));
  document.getElementById("vgrid").innerHTML=cityBlocks(VENUES);
}
function openVenue(id){
  const v=VENUES.find(x=>x.id===id);
  const shows=SHOWS.filter(s=>s.v===id&&s.dt>=now).sort((a,b)=>a.dt-b.dt);
  document.getElementById("modal").innerHTML=`
    <button class="close" onclick="closeModal()">✕</button>
    <div class="mhero" style="background:${grad(v.g)}">
      <div class="mtop">${v.city} · ${v.nights}${v.featured?" · Featured venue":""}</div>
    </div>
    <div class="mbody">
      <h2>${v.name}</h2>
      <p class="desc">${v.blurb}</p>
      <div class="mbox"><b>Upcoming shows</b>
        ${shows.slice(0,8).map(s=>`<div class="line" onclick="openShow(${s.id})"><span>${s.t}</span><span class="r">${fmtShort(s.dt)} · ${priceLabel(s)}</span></div>`).join("")||'<div class="line">No upcoming shows listed.</div>'}
      </div>
      <a class="btn btn-orange" href="/clubs/${v.id}/">Full club page →</a>
    </div>`;
  document.getElementById("overlay").classList.add("open");
}
function closeModal(){document.getElementById("overlay").classList.remove("open");}
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeModal();closeDrawer();}});

/* ================= VIDEOS ================= */
function drawVideos(){
  document.getElementById("vidgrid").innerHTML=COMEDIANS.filter(c=>c.img).map(c=>`
    <a class="vidcard" href="${YT}" target="_blank" rel="noopener">
      <div class="vthumb"><img src="${c.img}" alt="${c.name}" loading="lazy"><div class="play"><span>▶</span></div></div>
      <div class="vbody"><div class="t">${c.name} — live at the Craic Den</div><div class="m">Watch on YouTube · @craicdencomedyclub</div></div>
    </a>`).join("");
}

/* ================= TOUR NEWS ================= */
function drawTourNews(){
  const L=TOURNEWS.lead, lc=COMEDIANS.find(c=>c.name===L.com)||{name:L.com,img:""};
  const gigs=comedianShows(L.com).slice(0,3);
  const lead=`
    <article class="tnlead" onclick="openComedian('${esc(L.com)}')">
      <div class="ph">${photo(lc)}<span class="pill pill-orange badge">${L.kicker}</span></div>
      <div class="bd">
        <div class="d">${fmtShort(now)} · Tour news</div>
        <h3>${L.head}</h3>
        <p>${L.standfirst}</p>
        <div class="dates"><b>Upcoming dates</b>
          ${gigs.map(g=>`<div class="dl"><span>${g.venue.name}, ${g.venue.city}</span><span class="r">${fmtShort(g.dt)}</span></div>`).join("")||'<div class="dl"><span>Dates to be announced</span></div>'}
        </div>
        <span class="btn btn-orange cta">${L.cta} →</span>
      </div>
    </article>`;
  const side=`<div class="tnside">${TOURNEWS.items.map(i=>{
    const c=COMEDIANS.find(x=>x.name===i.com)||{name:i.com,img:""};
    return `<div class="tnitem" onclick="openComedian('${esc(i.com)}')">
      <div class="th">${photo(c)}</div>
      <div class="ib"><div class="k">${i.k}</div><div class="t">${i.t}</div><div class="m">${i.m}</div></div>
    </div>`;}).join("")}</div>`;
  document.getElementById("tourwrap").innerHTML=lead+side;
}

/* ================= NEWS ================= */
function drawNews(){
  if(!NEWSITEMS.length){
    document.getElementById("newsgrid").innerHTML='<p style="color:var(--muted)">Comedy news is coming shortly. In the meantime, the tour announcements on the home page are pulled straight from the venues.</p>';
    return;
  }
  document.getElementById("newsgrid").innerHTML=NEWSITEMS.map(([k,t,p,g])=>`
    <div class="newscard"><div class="newstop" style="background:${grad(g)}"><span class="k">${k}</span></div>
    <div class="newsbody"><h3>${t}</h3><p>${p}</p><div class="rd">Read the story →</div></div></div>`).join("");
}

/* ================= RESOURCES ================= */
function drawResources(){
  document.getElementById("rlist").innerHTML=RESOURCES.map(([g,ic,items])=>`
    <div class="rgroup"><h3><span class="ic">${ic}</span>${g}</h3>
    ${items.map(([n,p])=>`<div class="ritem"><div class="rn">${n}</div><p>${p}</p></div>`).join("")}
    </div>`).join("");
}

/* ================= MISC ================= */
function nsub(e){e.preventDefault();document.getElementById("nok").style.display="inline";e.target.style.display="none";}
function cookie(){document.getElementById("cookie").style.display="none";}

buildMonths();drawFeatured();drawTours();drawDirectory();render();drawTourNews();drawClubs();drawVideos();drawNews();drawResources();
