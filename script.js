/* ====== PUT YOUR TMDB KEY HERE ====== */
const TMDB_API_KEY = "000802da6224e125437187b196cde898";
const TMDB_IMG = "https://image.tmdb.org/t/p";

/* ====== SHORTCUTS ====== */
const $ = s => document.querySelector(s);
const todayKey = () => new Date().toISOString().slice(0,10);
function show(el,on){ el.style.display = on ? "" : "none"; }
function haptics(kind="light"){ if(navigator.vibrate) navigator.vibrate(kind==="heavy"?[10,20,10]:kind==="mid"?12:6); }
document.addEventListener("contextmenu", e => { if (e.target && e.target.id==="poster") e.preventDefault(); });

/* ====== POSTERS ====== */
function posterURL(path,size="w500"){
  if(!path) return ""; const s=String(path).trim();
  if(!s || s==="null" || s==="undefined") return "";
  if(s.startsWith("http://")) return s.replace("http://","https://");
  if(s.startsWith("https://")) return s;
  const clean = s.startsWith("/")? s : "/"+s; return `${TMDB_IMG}/${size}${clean}`;
}
function setPoster(imgEl, posterPath, title){
  const conn = navigator.connection?.effectiveType || "4g";
  const order = conn.includes("4g") ? ["w780","w500","original","w342"] : ["w342","w500","w780"];
  let i=0;
  function next(){ const u=posterURL(posterPath, order[i]); if(!u){ fallback(); return; } imgEl.crossOrigin="anonymous"; imgEl.src=u; }
  function fallback(){
    imgEl.src=`data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900"><rect width="100%" height="100%" fill="#141414"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#5a5a5a" font-family="system-ui, -apple-system, Segoe UI, Roboto" font-size="28">NO POSTER</text></svg>')}`;
  }
  imgEl.alt=title||"poster"; imgEl.classList.add("skeleton");
  imgEl.onerror=()=>{ i++; (i<order.length) ? next() : (fallback(), imgEl.classList.remove("skeleton")); };
  imgEl.onload =()=> imgEl.classList.remove("skeleton");
  next();
}

/* ====== STATE ====== */
let MOVIES=[], DECK=[], lastPickIndex=null, dealtOnce=false;
let ACTIVE_PRESET="none"; // none | cozy | midnight | folk
let VARIETY="T";          // T | M | W
let THEME="all";
let FILTERS={ noGore:false, noSV:false, noKids:false };
let banished = { date: todayKey(), ids: [] };

/* VIBE TARGET (Cursed/Spooky/Cozy) — live from the triangle pad */
let TARGET = { c:33, s:33, z:34 };

/* ====== CACHE ====== */
const CACHE_KEY="mr_tmdb_cache_v5";
let TMDB_CACHE={}; try{ TMDB_CACHE=JSON.parse(localStorage.getItem(CACHE_KEY)||"{}"); }catch{}
function saveCache(){ localStorage.setItem(CACHE_KEY, JSON.stringify(TMDB_CACHE)); }
const cacheKey=(title,year)=> (title||"").toLowerCase()+"::"+String(year||"").slice(0,4);

/* ====== UI ERR ====== */
function setUIError(m=""){ const e=$("#err"); e.textContent=m; e.style.color=m?"#ffb3b3":"#9ab"; }

/* ====== TMDb SEARCH ====== */
async function tmdbSearchPoster(title,year){
  if(!TMDB_API_KEY) return null;
  const k=cacheKey(title,year); if(TMDB_CACHE[k]?.poster) return TMDB_CACHE[k].poster;
  if(!tmdbSearchPoster._q) tmdbSearchPoster._q=Promise.resolve(); tmdbSearchPoster._q=tmdbSearchPoster._q.then(()=>new Promise(r=>setTimeout(r,250))); await tmdbSearchPoster._q;
  async function call(p){ const u=new URL("https://api.themoviedb.org/3/search/movie"); u.searchParams.set("api_key",TMDB_API_KEY); for(const [k,v] of Object.entries(p)) u.searchParams.set(k,v); const r=await fetch(u); if(!r.ok) throw 0; return r.json(); }
  try{
    let j=await call({query:title, year:String(year||"").slice(0,4)}); let hit=(j.results||[])[0];
    if(!hit||!hit.poster_path){ j=await call({query:title}); hit=(j.results||[])[0]; }
    const poster=hit?.poster_path||null; TMDB_CACHE[k]=TMDB_CACHE[k]||{}; TMDB_CACHE[k].poster=poster; saveCache(); return poster;
  }catch{ return null; }
}
async function ensurePoster(item){
  if(item.poster && String(item.poster).trim()) return item.poster;
  const found=await tmdbSearchPoster(item.title,item.year);
  if(found){ item.poster=found; return found; }
  return "";
}

/* ====== CSV PARSE ====== */
async function fetchMaybe(url){ try{ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) return null; return await r.text(); }catch{ return null; } }
function splitCSV(str,delim=","){ const out=[]; let cur="",q=false; for(let i=0;i<str.length;i++){ const ch=str[i]; if(ch==='"'){ q=!q; continue; } if(ch===delim && !q){ out.push(cur); cur=""; continue; } cur+=ch; } out.push(cur); return out; }
function parseCSV(text){ const lines=text.split(/\r?\n/).filter(l=>l.trim()); const header=lines[0]; const delim=header.includes("\t")? "\t":","; const cols=header.split(delim).map(s=>s.trim().toLowerCase()); const out=[]; for(let i=1;i<lines.length;i++){ const row=splitCSV(lines[i],delim); const rec={}; cols.forEach((c,idx)=>rec[c]=(row[idx]??"").trim()); out.push(rec);} return {cols,rows:out}; }
function coerceFlags(s){ const set=new Set(String(s||"").toLowerCase().split(/[,\s]+/).filter(Boolean)); return {
  theme_witchy:set.has("witchy"), theme_body_horror:set.has("body"), theme_folk:set.has("folk"),
  theme_found_footage:set.has("found"), theme_neon:set.has("neon"),
  extreme_gore:set.has("gore"), sexual_violence:set.has("sv"), kids_in_peril:set.has("kids")
};}

/* ====== LOAD DATA ====== */
function loadBanished(){ try{ const raw=localStorage.getItem("mr_banished"); if(!raw) return; const obj=JSON.parse(raw); if(obj.date===todayKey()) banished=obj; }catch{} }
function saveBanished(){ localStorage.setItem("mr_banished", JSON.stringify(banished)); }
function idFor(m){ return `${m.title||""}::${m.year||""}`; }

async function loadData(){
  try{
    loadBanished();

    let js = await fetchMaybe("./movies.json?v="+Date.now());
    if (js){
      MOVIES = JSON.parse(js);
    } else {
      let enriched = await fetchMaybe("./data/movies.csv?v="+Date.now());
      if (enriched){
        const {rows}=parseCSV(enriched);
        MOVIES = rows.map(r=>({
          title:r["name"]||r["title"]||"", year:(r["year"]||"").slice(0,4),
          link:r["letterboxd uri"]||r["uri"]||"", tagline:r["tagline"]||"",
          poster:r["poster"]||"", runtime:r["runtime"]?Number(r["runtime"]):null,
          flags:coerceFlags(r["flags"]||""),
          cursed: r["cursed"]? Number(r["cursed"]) : 0,
          spooky: r["spooky"]? Number(r["spooky"]) : 0,
          cozy:   r["cozy"]?   Number(r["cozy"])   : 0
        }));
      } else {
        const base = await fetchMaybe("./data/watchlist.csv?v="+Date.now());
        if(!base) throw new Error("No movies.json or CSV found");
        const {rows}=parseCSV(base);
        MOVIES = rows.map(r=>({
          title:r["name"]||"", year:(r["year"]||"").slice(0,4),
          link:r["letterboxd uri"]||"", tagline:"",
          poster:"", runtime:null, flags:{}, cursed:33, spooky:33, cozy:34
        }));
      }
    }

    $("#total").textContent = MOVIES.length;
    rebuildDeck();
  }catch(e){ console.error(e); setUIError("Data not loaded yet."); }
}

/* ====== VIBE MATH ====== */
function normTriple(c,s,z){ c=Math.max(0,c||0); s=Math.max(0,s||0); z=Math.max(0,z||0); const sum=c+s+z; if(sum<=0) return {c:33,s:33,z:34}; return {c:100*c/sum, s:100*s/sum, z:100*z/sum}; }
function distTriple(a,b){ const A=normTriple(a.c,a.s,a.z); const B=normTriple(b.c,b.s,b.z); const dx=(A.c-B.c)/100, dy=(A.s-B.s)/100, dz=(A.z-B.z)/100; return Math.sqrt(dx*dx + dy*dy + dz*dz); }
function band(){ return VARIETY==="T"?0.18: VARIETY==="M"?0.32:0.55; } // lower = tighter
function weightFor(movie, target){
  const m={c:movie.cursed||0, s:movie.spooky||0, z:movie.cozy||0};
  const d=distTriple(m, target);
  const w=Math.exp(-0.5*Math.pow(d/band(),2));
  return w;
}

/* ====== FILTER PASS ====== */
function presetPass(item){
  if (ACTIVE_PRESET==="none") return true;
  const f=item.flags||{};
  if (ACTIVE_PRESET==="midnight"){
    const count=[f.theme_neon,f.extreme_gore,f.theme_body_horror,f.theme_found_footage,f.theme_witchy].filter(Boolean).length;
    return count>=1 && (item.cursed+item.spooky)>=70;
  }
  if (ACTIVE_PRESET==="cozy"){
    if (f.extreme_gore || f.sexual_violence) return false;
    return item.cozy >= 50;
  }
  if (ACTIVE_PRESET==="folk"){
    return (f.theme_folk || f.theme_witchy);
  }
  return true;
}
function themePass(item){
  const f=item.flags||{}; if(THEME==="all")return true;
  if(THEME==="witch")return f.theme_witchy; if(THEME==="body")return f.theme_body_horror;
  if(THEME==="folk")return f.theme_folk; if(THEME==="found")return f.theme_found_footage; if(THEME==="neon")return f.theme_neon;
  return true;
}
function contentPass(item){
  const f=item.flags||{}; if(FILTERS.noGore&&f.extreme_gore)return false; if(FILTERS.noSV&&f.sexual_violence)return false; if(FILTERS.noKids&&f.kids_in_peril)return false; return true;
}

/* ====== DECK ====== */
function rebuildDeck(){
  if(!MOVIES.length) return;
  const todaysBan=(banished.date===todayKey())?new Set(banished.ids):new Set();

  let cands = MOVIES.map((m,i)=>({m,i}))
    .filter(({m})=>presetPass(m)&&!todaysBan.has(idFor(m))&&themePass(m)&&contentPass(m))
    .map(x=>x.i);

  if(!cands.length){ cands=MOVIES.map((m,i)=>({m,i})).filter(({m})=>presetPass(m)&&!todaysBan.has(idFor(m))).map(x=>x.i); if(!cands.length) cands=MOVIES.map((_,i)=>i); }

  // Shuffle
  for(let i=cands.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [cands[i],cands[j]]=[cands[j]]; }

  // Weighted by vibe distance
  const deck=[], used=new Set(), MAX=Math.min(80,cands.length);
  for(let n=0;n<MAX;n++){
    const pool=cands.filter(i=>!used.has(i)); if(!pool.length) break;
    const weights = pool.map(i=> weightFor(MOVIES[i], TARGET));
    let sum=weights.reduce((a,b)=>a+b,0); if(sum<=0){ deck.push(pool[0]); used.add(pool[0]); continue; }
    let r=Math.random()*sum; let pick=pool[0];
    for(let k=0;k<pool.length;k++){ r-=weights[k]; if(r<=0){ pick=pool[k]; break; } }
    used.add(pick); deck.push(pick);
  }

  DECK = deck.length? deck : cands;
  $("#left").textContent = DECK.length;
  $("#deckCountMini").textContent = "Deck: " + DECK.length;
  updateResetVisibility();
  setUIError("");
}

/* ====== PICK / REROLL ====== */
function safeDealIndex(){ if(!DECK.length) rebuildDeck(); let idx=DECK.pop(); if(idx==null||isNaN(idx)) idx=Math.floor(Math.random()*(MOVIES.length||1)); return idx; }
function dealOne(){ if(!MOVIES.length){ setUIError("Data not loaded yet."); return; } const idx=safeDealIndex(); lastPickIndex=idx; dealtOnce=true; $("#left").textContent=Math.max(0,DECK.length); render(MOVIES[idx]); updateResetVisibility(); setUIError(""); haptics("light"); }
function rerollNearby(){
  if(lastPickIndex==null){ dealOne(); return; }
  const curr=MOVIES[lastPickIndex];
  let pool=[]; // near in vibe-space to TARGET and current pick
  for(let i=0;i<MOVIES.length;i++){
    if(i===lastPickIndex) continue;
    const m=MOVIES[i]; if(!presetPass(m)||!themePass(m)||!contentPass(m)) continue;
    const dT=distTriple({c:m.cursed,s:m.spooky,z:m.cozy}, TARGET);
    const dC=distTriple({c:m.cursed,s:m.spooky,z:m.cozy}, {c:curr.cursed,s:curr.spooky,z:curr.cozy});
    if(dT<=band()*1.2 || dC<=0.18) pool.push(i);
  }
  if(!pool.length){ pool=MOVIES.map((m,i)=>i).filter(i=>i!==lastPickIndex && presetPass(MOVIES[i])&&themePass(MOVIES[i])&&contentPass(MOVIES[i])); }
  if(!pool.length){ pool=MOVIES.map((_,i)=>i).filter(i=>i!==lastPickIndex); }
  const idx=pool[Math.floor(Math.random()*pool.length)]; lastPickIndex=idx; render(MOVIES[idx]); haptics("mid");
}

/* ====== BANISH (250ms hold) ====== */
let lpTimer=null; const infoLP=$("#longPressArea");
["touchstart","mousedown"].forEach(e=>infoLP.addEventListener(e,()=>{ lpTimer=setTimeout(banishCurrent,250); },{passive:true}));
["touchend","touchcancel","mouseup","mouseleave"].forEach(e=>infoLP.addEventListener(e,()=>clearTimeout(lpTimer)));
function banishCurrent(){
  if(lastPickIndex==null) return;
  const it=MOVIES[lastPickIndex], key=idFor(it);
  if(banished.date!==todayKey()) banished={date:todayKey(), ids:[]};
  if(!banished.ids.includes(key)) banished.ids.push(key);
  saveBanished(); showToast("Banished — Undo"); rebuildDeck(); dealOne(); haptics("heavy");
}
function undoBanish(){ if(banished.date!==todayKey()||!banished.ids.length) return; banished.ids.pop(); saveBanished(); showToast("Undo ✓"); rebuildDeck(); }

/* ====== PREFETCH NEXT ====== */
async function prefetchNextPosters(n=3){
  const peek=DECK.slice(-n);
  for(const idx of peek){ const m=MOVIES[idx]; if(m && !m.poster){ ensurePoster(m); } }
}

/* ====== VIBE BADGE (readout triangle for current pick) ====== */
function renderVibeBadge(el, m){
  const w=180, h=156;
  const top   = {x:w/2, y:10};
  const left  = {x:14,  y:h-12};
  const right = {x:w-14, y:h-12};
  const C = Math.max(0, m.cursed||0), S = Math.max(0, m.spooky||0), Z = Math.max(0, m.cozy||0);
  const sum = C+S+Z || 1;
  const px = (C/sum)*top.x + (S/sum)*left.x + (Z/sum)*right.x;
  const py = (C/sum)*top.y + (S/sum)*left.y + (Z/sum)*right.y;

  el.innerHTML = `
  <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vibe triangle">
    <polygon points="${top.x},${top.y} ${left.x},${left.y} ${right.x},${right.y}"
      fill="#0f1511" stroke="#284832" stroke-width="2" />
    <line x1="${top.x}" y1="${top.y}" x2="${(left.x+right.x)/2}" y2="${left.y}"
      stroke="#1f3327" stroke-width="1"/>
    <circle cx="${px}" cy="${py}" r="5" fill="#77ffa5" stroke="#173824" stroke-width="2"/>
    <text class="lab" x="${top.x}" y="${top.y-2}" text-anchor="middle">Cursed ${Math.round(C)}%</text>
    <text class="lab" x="${left.x}" y="${left.y+12}">Spooky ${Math.round(S)}%</text>
    <text class="lab" x="${right.x}" y="${right.y+12}" text-anchor="end">Cozy ${Math.round(Z)}%</text>
  </svg>`;
}

/* ====== RENDER CARD ====== */
function links(container,item){
  container.innerHTML="";
  const lb=document.createElement("a"); lb.textContent="Open on Letterboxd"; lb.href=item.link||"#"; lb.target="_blank"; lb.rel="noopener";
  container.appendChild(lb);
  const s=document.createElement("a");
  const q=encodeURIComponent(`${item.title} full movie site:archive.org OR site:youtube.com OR torrent`);
  s.textContent="Where to watch (search)"; s.href="https://www.google.com/search?q="+q; s.target="_blank"; s.rel="noopener";
  container.appendChild(s);
}
async function render(item){
  setPoster($("#poster"), "/null", item.title);
  const posterPath = await ensurePoster(item);
  setPoster($("#poster"), posterPath || "/null", item.title);

  $("#title").textContent = item.title || "Untitled";
  const tg=(item.tagline||"").trim(); $("#taglineInline").textContent=tg; show($("#taglineInline"), !!tg);

  if(item.year){ $("#year").textContent=`Year: ${item.year}`; show($("#year"),true); } else show($("#year"),false);
  const run=item.runtime?`${item.runtime} min`:""; $("#runChip").textContent=run; show($("#runChip"), !!run);

  renderVibeBadge($("#vibeBadge"), item);
  links($("#linksRow"), item);

  prefetchNextPosters(3);
}

/* ====== SHARE (poster postcard; fallback to native share text+link) ====== */
async function shareCurrent(){
  if(lastPickIndex==null) return; const m=MOVIES[lastPickIndex];
  const posterPath = await ensurePoster(m); const posterUrl = posterURL(posterPath||"", "w500");
  try{
    const img = await loadImage(posterUrl);
    const canvas=document.createElement("canvas"); const W=900,H=1350; canvas.width=W; canvas.height=H; const ctx=canvas.getContext("2d");
    ctx.fillStyle="#0d0d0d"; ctx.fillRect(0,0,W,H);
    const PX=60, PW=W-120, PH=Math.round(PW*1.5), PY=60;
    roundRect(ctx,PX,PY,PW,PH,24); ctx.save(); ctx.clip(); ctx.drawImage(img,PX,PY,PW,PH); ctx.restore();
    // title + tagline
    ctx.fillStyle="#eafff3"; ctx.font="bold 44px system-ui,-apple-system,Segoe UI,Inter"; wrapText(ctx, m.title||"Untitled", 60, 990, W-120, 52);
    ctx.fillStyle="#cfe8dc"; ctx.font="400 28px system-ui,-apple-system,Segoe UI,Inter"; wrapText(ctx, (m.tagline||"").trim(), 60, 1050, W-120, 36);
    // vibe chips
    drawChip(ctx, `Cursed ${m.cursed||0}%`, 60, 1150);
    drawChip(ctx, `Spooky ${m.spooky||0}%`, 270, 1150);
    drawChip(ctx, `Cozy ${m.cozy||0}%`, 470, 1150);
    // link
    ctx.fillStyle="#8fb8a5"; ctx.font="500 22px system-ui,-apple-system,Segoe UI,Inter";
    const urlText=(m.link||"").replace(/^https?:\/\//,""); ctx.fillText(urlText||"letterboxd.com", 60, 1290);

    const blob=await new Promise(res=>canvas.toBlob(b=>res(b),"image/png",0.92));
    const file=new File([blob], `${(m.title||"movie").replace(/\W+/g,'_')}.png`, {type:"image/png"});
    if(navigator.canShare && navigator.canShare({files:[file]})){ await navigator.share({files:[file], text:`${m.title} — ${m.tagline||""}`, url:m.link||undefined}); return; }
    window.open(URL.createObjectURL(blob), "_blank");
  }catch{
    const text=`${m.title}${m.year?` (${m.year})`:''}\n${m.tagline||''}\n${m.link||''}`.trim();
    if(navigator.share){ try{ await navigator.share({title:m.title||"Movie", text, url:m.link||undefined}); return; }catch{} }
    try{ await navigator.clipboard.writeText(text); showToast("Copied details to clipboard"); }catch{ window.prompt("Copy this", text); }
  }
}
function loadImage(url){ return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=url; }); }
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function drawChip(ctx, text, x, y){ ctx.save(); ctx.font="bold 26px system-ui,-apple-system,Segoe UI,Inter"; const padX=16; const w=ctx.measureText(text).width+padX*2; ctx.fillStyle="#18291f"; ctx.strokeStyle="#284832"; ctx.lineWidth=2; roundRect(ctx,x,y-28,w,42,18); ctx.fill(); ctx.stroke(); ctx.fillStyle="#bff7cf"; ctx.fillText(text,x+padX,y); ctx.restore(); }
function wrapText(ctx,text,x,y,maxWidth,lineHeight){ const words=(text||"").split(/\s+/); let line=""; let dy=0; for(let n=0;n<words.length;n++){ const test=line+words[n]+" "; if(ctx.measureText(test).width>maxWidth && n>0){ ctx.fillText(line,x,y+dy); line=words[n]+" "; dy+=lineHeight; } else line=test; } ctx.fillText(line,x,y+dy); }

/* ====== TOAST ====== */
function showToast(text){ const t=$("#toast"); t.textContent=text; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),3000); }

/* ====== FILTERS & PRESETS WIRES ====== */
const dlg=$("#filtersDlg");
$("#openFilters").onclick = ()=>dlg.showModal();
$("#closeFilters").onclick = ()=>dlg.close();
$("#resetAll").onclick = ()=>{
  VARIETY="T"; THEME="all"; FILTERS={noGore:false,noSV:false,noKids:false}; ACTIVE_PRESET="none";
  TARGET={c:33,s:33,z:34}; drawPad(); updatePadPercents();
  [...$("#biasSegTop").children].forEach(b=>b.classList.remove("active")); $("#biasSegTop").children[0].classList.add("active");
  ["thAll","thWitch","thBody","thFolk","thFound","thNeon"].forEach(id=>$("#"+id).classList.remove("active")); $("#thAll").classList.add("active");
  ["fNoGore","fNoSV","fNoKids"].forEach(id=>$("#"+id).classList.remove("active"));
  $("#presetLock").style.display="none";
  rebuildDeck(); dlg.close(); haptics("light");
};
$("#biasSegTop").addEventListener("click",(e)=>{ if(e.target.tagName!=="BUTTON")return; VARIETY=e.target.dataset.bias; [...$("#biasSegTop").children].forEach(b=>b.classList.toggle("active",b===e.target)); rebuildDeck(); haptics("light"); });

function setTheme(w){ THEME=w; ["thAll","thWitch","thBody","thFolk","thFound","thNeon"].forEach(id=>$("#"+id).classList.remove("active")); const map={all:"thAll",witch:"thWitch",body:"thBody",folk:"thFolk",found:"thFound",neon:"thNeon"}; $("#"+map[w]).classList.add("active"); rebuildDeck(); haptics("light"); }
$("#thAll").onclick=()=>setTheme("all"); $("#thWitch").onclick=()=>setTheme("witch"); $("#thBody").onclick=()=>setTheme("body"); $("#thFolk").onclick=()=>setTheme("folk"); $("#thFound").onclick=()=>setTheme("found"); $("#thNeon").onclick=()=>setTheme("neon");

$("#fNoGore").onclick =()=>{ FILTERS.noGore=!FILTERS.noGore; $("#fNoGore").classList.toggle("active",FILTERS.noGore); rebuildDeck(); haptics("light"); };
$("#fNoSV").onclick   =()=>{ FILTERS.noSV=!FILTERS.noSV; $("#fNoSV").classList.toggle("active",FILTERS.noSV); rebuildDeck(); haptics("light"); };
$("#fNoKids").onclick =()=>{ FILTERS.noKids=!FILTERS.noKids; $("#fNoKids").classList.toggle("active",FILTERS.noKids); rebuildDeck(); haptics("light"); };

$("#presets").addEventListener("click",(e)=>{
  const b=e.target.closest(".preset"); if(!b) return;
  ACTIVE_PRESET=b.dataset.preset; $("#presetLock").style.display="inline-block";
  $("#presetLock").textContent=(ACTIVE_PRESET==="midnight"?"Cult midnight":ACTIVE_PRESET==="cozy"?"Cozy offbeat":"Folk dread")+" 🔒";
  // nudge TARGET
  if (ACTIVE_PRESET==="cozy") TARGET={c:10,s:15,z:75};
  else if (ACTIVE_PRESET==="midnight") TARGET={c:70,s:25,z:5};
  else TARGET={c:25,s:65,z:10}; // folk dread
  drawPad(); updatePadPercents(); rebuildDeck(); haptics("mid");
});
$("#presetLock").onclick=()=>{ ACTIVE_PRESET="none"; $("#presetLock").style.display="none"; rebuildDeck(); };

/* ====== TRIANGLE PAD (draggable target) ====== */
const pad = $("#vibePad");
let padCanvas, ctx, padGeom;

function initPad(){
  pad.innerHTML = ""; padCanvas = document.createElement("canvas");
  padCanvas.width = pad.clientWidth * devicePixelRatio;
  padCanvas.height = pad.clientHeight * devicePixelRatio;
  padCanvas.style.width = "100%"; padCanvas.style.height="100%";
  pad.appendChild(padCanvas);
  ctx = padCanvas.getContext("2d");
  padGeom = computeGeom();
  drawPad();
  // events
  const down = (e)=>{ moveDot(e); e.preventDefault(); dragging=true; };
  const move = (e)=>{ if(!dragging) return; moveDot(e); e.preventDefault(); };
  const up   = ()=>{ dragging=false; };
  let dragging=false;
  pad.addEventListener("mousedown", down);
  pad.addEventListener("touchstart", down, {passive:false});
  window.addEventListener("mousemove", move, {passive:false});
  window.addEventListener("touchmove", move, {passive:false});
  window.addEventListener("mouseup", up);
  window.addEventListener("touchend", up);
  window.addEventListener("resize", ()=>{ initPad(); });
}
function computeGeom(){
  const W=padCanvas.width, H=padCanvas.height;
  const m=18*devicePixelRatio;
  const top={x:W/2,y:m+4}, left={x:m,y:H-m}, right={x:W-m,y:H-m};
  return {W,H,top,left,right};
}
function drawPad(){
  const {W,H,top,left,right}=padGeom;
  ctx.clearRect(0,0,W,H);
  // tri
  ctx.fillStyle="#0f1511"; ctx.strokeStyle="#284832"; ctx.lineWidth=2*devicePixelRatio;
  ctx.beginPath(); ctx.moveTo(top.x,top.y); ctx.lineTo(left.x,left.y); ctx.lineTo(right.x,right.y); ctx.closePath(); ctx.fill(); ctx.stroke();
  // internal line
  ctx.strokeStyle="#1f3327"; ctx.lineWidth=1*devicePixelRatio; ctx.beginPath(); ctx.moveTo(top.x,top.y); ctx.lineTo((left.x+right.x)/2,left.y); ctx.stroke();
  // dot -> from TARGET percentages to point
  const p = baryToPoint(normTriple(TARGET.c,TARGET.s,TARGET.z), top,left,right);
  ctx.fillStyle="#77ffa5"; ctx.strokeStyle="#173824"; ctx.lineWidth=2*devicePixelRatio;
  ctx.beginPath(); ctx.arc(p.x,p.y,5*devicePixelRatio,0,Math.PI*2); ctx.fill(); ctx.stroke();
}
function moveDot(e){
  const rect=padCanvas.getBoundingClientRect();
  const clientX = (e.touches? e.touches[0].clientX : e.clientX);
  const clientY = (e.touches? e.touches[0].clientY : e.clientY);
  const x = (clientX - rect.left) * devicePixelRatio;
  const y = (clientY - rect.top) * devicePixelRatio;
  const {top,left,right}=padGeom;

  // clamp to triangle by projecting to barycentric and clipping
  let bary = pointToBary({x,y}, top,left,right);
  bary = clipBary(bary);
  // update TARGET
  TARGET = { c:bary.c*100, s:bary.s*100, z:bary.z*100 };
  updatePadPercents();
  drawPad();
  rebuildDeck();
  haptics("light");
}
function updatePadPercents(){
  $("#pcC").textContent = Math.round(normTriple(TARGET.c,TARGET.s,TARGET.z).c) + "%";
  $("#pcS").textContent = Math.round(normTriple(TARGET.c,TARGET.s,TARGET.z).s) + "%";
  $("#pcZ").textContent = Math.round(normTriple(TARGET.c,TARGET.s,TARGET.z).z) + "%";
}
/* geometry helpers */
function pointToBary(p, A,B,C){
  const v0={x:B.x-A.x, y:B.y-A.y}, v1={x:C.x-A.x, y:C.y-A.y}, v2={x:p.x-A.x, y:p.y-A.y};
  const d00=v0.x*v0.x+v0.y*v0.y, d01=v0.x*v1.x+v0.y*v1.y, d11=v1.x*v1.x+v1.y*v1.y;
  const d20=v2.x*v0.x+v2.y*v0.y, d21=v2.x*v1.x+v2.y*v1.y; const denom=d00*d11-d01*d01||1;
  let v=(d11*d20-d01*d21)/denom, w=(d00*d21-d01*d20)/denom, u=1-v-w;
  return {c:u, s:v, z:w}; // map: top→cursed(u), left→spooky(v), right→cozy(w)
}
function baryToPoint(bary, A,B,C){
  return { x: bary.c*A.x + bary.s*B.x + bary.z*C.x, y: bary.c*A.y + bary.s*B.y + bary.z*C.y };
}
function clipBary(b){ // clip to triangle
  let {c,s,z}=b;
  c=Math.max(0,Math.min(1,c));
  s=Math.max(0,Math.min(1,s));
  z=Math.max(0,Math.min(1,z));
  const sum=c+s+z; if(sum===0){ c=1; s=0; z=0; }
  else{ c/=sum; s/=sum; z/=sum; }
  return {c,s,z};
}

/* ====== LINKS + TOAST ====== */
function showToast(text){ const t=$("#toast"); t.textContent=text; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),3000); }

/* ====== WIRES ====== */
const dlg=$("#filtersDlg");
$("#openFilters").onclick = ()=>dlg.showModal();
$("#closeFilters").onclick = ()=>dlg.close();
$("#deal").onclick = ()=>dealOne();
$("#reroll").onclick = ()=>rerollNearby();
$("#shareCard").onclick = ()=>shareCurrent();
$("#undo").onclick = ()=>{ undoBanish(); haptics("mid"); };
function resetDeck(){ rebuildDeck(); $("#left").textContent=DECK.length; dealtOnce=false; updateResetVisibility(); haptics("mid"); }
function updateResetVisibility(){ show($("#resetDeck"), dealtOnce); }
$("#resetDeck").onclick = resetDeck;

/* ====== START ====== */
initPad();
loadData();

/* ====== CARD UTIL (end) ====== */
function links(container,item){
  container.innerHTML="";
  const lb=document.createElement("a"); lb.textContent="Open on Letterboxd"; lb.href=item.link||"#"; lb.target="_blank"; lb.rel="noopener";
  container.appendChild(lb);
  const s=document.createElement("a");
  const q=encodeURIComponent(`${item.title} full movie site:archive.org OR site:youtube.com OR torrent`);
  s.textContent="Where to watch (search)"; s.href="https://www.google.com/search?q="+q; s.target="_blank"; s.rel="noopener";
  container.appendChild(s);
}
async function render(item){
  setPoster($("#poster"), "/null", item.title);
  const posterPath = await ensurePoster(item);
  setPoster($("#poster"), posterPath || "/null", item.title);

  $("#title").textContent = item.title || "Untitled";
  const tg=(item.tagline||"").trim(); $("#taglineInline").textContent=tg; show($("#taglineInline"), !!tg);

  if(item.year){ $("#year").textContent=`Year: ${item.year}`; show($("#year"),true); } else show($("#year"),false);
  const run=item.runtime?`${item.runtime} min`:""; $("#runChip").textContent=run; show($("#runChip"), !!run);

  renderVibeBadge($("#vibeBadge"), item);
  links($("#linksRow"), item);

  prefetchNextPosters(3);
}
