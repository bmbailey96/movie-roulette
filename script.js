/* ====== PUT YOUR TMDB KEY HERE (keep the variable name) ====== */
const TMDB_API_KEY = "000802da6224e125437187b196cde898"; // e.g. "000802da6224e125437187b196cde898"
const TMDB_IMG = "https://image.tmdb.org/t/p";

/* ====== SHORTCUTS ====== */
const $ = s => document.querySelector(s);
function setText(el, t){ el.textContent=t; }
function show(el, on){ el.style.display = on ? "" : "none"; }
function todayKey(){ return new Date().toISOString().slice(0,10); }
function haptics(kind="light"){
  if (!navigator.vibrate) return;
  if (kind==="heavy") navigator.vibrate([10,20,10]);
  else if (kind==="mid") navigator.vibrate(12);
  else navigator.vibrate(6);
}
document.addEventListener("contextmenu", e => {
  if (e.target && (e.target.id==="poster" || e.target.closest("#poster"))) e.preventDefault();
});

function setUIError(m=""){ const e=$("#err"); e.textContent=m; e.style.color=m?"#ffb3b3":"#9ab"; }

/* ====== POSTER HELPERS ====== */
function posterURL(path, size="w500"){
  if (!path) return "";
  const s = String(path).trim();
  if (!s || s==="null" || s==="undefined") return "";
  if (s.startsWith("http://")) return s.replace("http://","https://");
  if (s.startsWith("https://")) return s;
  const clean = s.startsWith("/") ? s : "/"+s;
  return `${TMDB_IMG}/${size}${clean}`;
}
function setPoster(imgEl, posterPath, title){
  const conn = navigator.connection?.effectiveType || "4g";
  const sizesOrder = conn.includes("4g") ? ["w780","w500","original","w342"] : ["w342","w500","w780"];
  let i = 0;
  function tryNext(){ const u = posterURL(posterPath, sizesOrder[i]); if (!u){ setFallback(); return; } imgEl.src = u; }
  function setFallback(){
    imgEl.src = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900"><rect width="100%" height="100%" fill="#141414"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#5a5a5a" font-family="system-ui, -apple-system, Segoe UI, Roboto" font-size="28">NO POSTER</text></svg>')}`;
  }
  imgEl.alt = title || "poster"; imgEl.classList.add("skeleton");
  imgEl.onerror = () => { i++; (i < sizesOrder.length) ? tryNext() : (setFallback(), imgEl.classList.remove("skeleton")); };
  imgEl.onload  = () => imgEl.classList.remove("skeleton");
  tryNext();
}

/* ====== STATE ====== */
let MOVIES=[], DECK=[];
let MODE="mix";      // order | mix | chaos
let VARIETY="T";     // T | M | W
let THEME="all";
let FILTERS={ noGore:false, noSV:false, noKids:false };
let lastPickIndex=null;
let banished = { date: todayKey(), ids: [] };
let ACTIVE_PRESET = "none"; // none | cozy | midnight | folk
let dealtOnce = false;

/* ====== TMDb CACHE ====== */
const CACHE_KEY = "mr_tmdb_cache_v4";
let TMDB_CACHE = {};
try{ TMDB_CACHE = JSON.parse(localStorage.getItem(CACHE_KEY)||"{}"); }catch{ TMDB_CACHE={}; }
function saveCache(){ localStorage.setItem(CACHE_KEY, JSON.stringify(TMDB_CACHE)); }
function cacheKey(title, year){ return (title||"").toLowerCase()+"::"+String(year||"").slice(0,4); }

/* ====== CURATION OVERRIDES (selection only) ====== */
const OVERRIDES = {
  "Bridget Jones's Diary::2001": { chaos:10, flags:[], tagline:"Diary, disaster, darling; not chaos." },
  "High Fidelity::2000": { chaos:15, flags:[], tagline:"Mixtapes and malaise, not madness." },
  "A River Runs Through It::1992": { chaos:8, flags:[], tagline:"Pastoral reverie; zero delirium." },
  "Friday the 13th Part VIII: Jason Takes Manhattan::1989": { chaos:42, flags:["gore"], tagline:"Boat trip to punch a rooftop head off." },
  "The Smashing Machine::2025": { chaos:10, flags:[], tagline:"Straight doc energy. Calm in the cage." },
  "Come and See::1985": { chaos:75, flags:["gore","kids"], tagline:"War as fever dream; soul on fire." },
  "Valerie and Her Week of Wonders::1970": { chaos:78, flags:["folk","witchy"], tagline:"Lace, teeth, and puberty spells." },
  "The Color of Pomegranates::1969": { chaos:82, flags:["neon"], tagline:"Symbols upon symbols until language breaks." },
  "The Substance::2024": { chaos:74, flags:["body","gore"], tagline:"You shed her, she devours you back." },
  "Ghostwatch::1992": { chaos:55, flags:["found"], tagline:"The TV lied and Britain screamed." },
  "Phantom of the Paradise::1974": { chaos:68, flags:["neon"], tagline:"Glam Faust in a bird mask." },
  "Tetsuo: The Iron Man::1989": { chaos:90, flags:["body","gore","neon"], tagline:"Meat becomes metal, screams become rhythm." },
  "Begotten::1989": { chaos:95, flags:["gore"], tagline:"Biblical rot flickers into being." },
  "Belladonna of Sadness::1973": { chaos:85, flags:["witchy","folk","body","sv"], tagline:"Watercolor witch scream." },
  "Taxidermia::2006": { chaos:88, flags:["body","gore","sv"], tagline:"Generations of grotesque mutation." },
  "Sweet Movie::1974": { chaos:90, flags:["sv","body"], tagline:"Sugar, politics, filth; a dare." },
  "Visitor Q::2001": { chaos:88, flags:["sv","gore"], tagline:"Miike milks the void." },
  "Things::1989": { chaos:80, flags:["gore"], tagline:"Shot-on-video, shot in the dark." },
  "Miami Connection::1987": { chaos:62, flags:[], tagline:"Friends fight ninjas; sincerity detonates." },
  "Samurai Cop::1991": { chaos:60, flags:[], tagline:"Wigs, katana, deadpan carnage." },
  "Street Trash::1987": { chaos:66, flags:["gore","body"], tagline:"Liquor that melts the poor." },
  "Meet the Feebles::1989": { chaos:70, flags:["gore","sv"], tagline:"Puppets with track marks." },
  "The Peanut Butter Solution::1985": { chaos:63, flags:["kids"], tagline:"Haunted PB grows cursed hair." },
  "964 Pinocchio::1991": { chaos:82, flags:["neon","body"], tagline:"Sex-cyborg screams Tokyo inside out." },
  "Funky Forest: The First Contact::2005": { chaos:78, flags:["neon"], tagline:"Sketchbook from a parallel puberty." },
  "The Beyond::1981": { chaos:60, flags:["gore","witchy"], tagline:"Hotel on Hell. Keys don’t help." },
  "On the Silver Globe::1988": { chaos:76, flags:[], tagline:"Unfinished prophecy on another world." },
  "The Wizard of Gore::1970": { chaos:58, flags:["gore"], tagline:"Stage illusions with actual viscera." },
  "Zardoz::1974": { chaos:65, flags:[], tagline:"Stone head, red diaper, immortality malaise." },
  "Barbarella::1968": { chaos:55, flags:["neon"], tagline:"Camp, kink, killer dolls." },
  "Nothing Lasts Forever::1984": { chaos:64, flags:[], tagline:"Lost satire wandered back." },
  "Liquid Sky::1982": { chaos:72, flags:["neon"], tagline:"Aliens harvest orgasms in downtown glare." },
  "The Boxer's Omen::1983": { chaos:80, flags:["body","gore","witchy"], tagline:"Black magic pukes up neon toads." }
};

/* ====== LOAD/SAVE ====== */
function idFor(m){ return `${m.title || ""}::${m.year || ""}`; }
function loadBanished(){
  const raw = localStorage.getItem("mr_banished");
  if (!raw) return;
  try{
    const obj = JSON.parse(raw);
    if (obj.date === todayKey() && Array.isArray(obj.ids)) banished = obj;
  }catch{}
}
function saveBanished(){ localStorage.setItem("mr_banished", JSON.stringify(banished)); }

async function fetchMaybe(url){
  try{
    const r = await fetch(url, {cache:"no-store"});
    if (!r.ok) return null;
    return await r.text();
  }catch{ return null; }
}
function splitCSV(str, delim=","){
  const out=[]; let cur=""; let inQ=false;
  for (let i=0;i<str.length;i++){
    const ch=str[i];
    if (ch === '"'){ inQ=!inQ; continue; }
    if (ch === delim && !inQ){ out.push(cur); cur=""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
  const header = lines[0];
  const delim = header.includes("\t") ? "\t" : ",";
  const cols = header.split(delim).map(s=>s.trim().toLowerCase());
  const out=[];
  for (let i=1;i<lines.length;i++){
    const row = splitCSV(lines[i], delim);
    const rec={};
    cols.forEach((c,idx)=> rec[c]= (row[idx]??"").trim());
    out.push(rec);
  }
  return {cols, rows:out};
}
function coerceFlags(s){
  const set = new Set(String(s||"").toLowerCase().split(/[,\s]+/).filter(Boolean));
  return {
    theme_witchy: set.has("witchy"),
    theme_body_horror: set.has("body"),
    theme_folk: set.has("folk"),
    theme_found_footage: set.has("found"),
    theme_neon: set.has("neon"),
    extreme_gore: set.has("gore"),
    sexual_violence: set.has("sv"),
    kids_in_peril: set.has("kids"),
  };
}
function mergeOverride(item){
  const key = idFor(item);
  const o = OVERRIDES[key];
  if (!o) return item;
  const flags = {...item.flags};
  if (o.flags) {
    const set = new Set(o.flags);
    flags.theme_witchy = flags.theme_witchy || set.has("witchy");
    flags.theme_body_horror = flags.theme_body_horror || set.has("body");
    flags.theme_folk = flags.theme_folk || set.has("folk");
    flags.theme_found_footage = flags.theme_found_footage || set.has("found");
    flags.theme_neon = flags.theme_neon || set.has("neon");
    flags.extreme_gore = flags.extreme_gore || set.has("gore");
    flags.sexual_violence = flags.sexual_violence || set.has("sv");
    flags.kids_in_peril = flags.kids_in_peril || set.has("kids");
  }
  return {
    ...item,
    chaos: (o.chaos ?? item.chaos),
    tagline: (o.tagline ?? item.tagline),
    flags
  };
}

async function loadData(){
  try{
    loadBanished();

    let js = await fetchMaybe("./movies.json?v="+Date.now());
    if (js){
      MOVIES = JSON.parse(js);
    } else {
      let enriched = await fetchMaybe("./data/movies.csv?v="+Date.now());
      if (enriched){
        const {rows} = parseCSV(enriched);
        MOVIES = rows.map(r=>{
          const item = {
            title: r["name"]||r["title"]||"",
            year: (r["year"]||"").slice(0,4),
            link: r["letterboxd uri"]||r["uri"]||"",
            tagline: r["tagline"]||"",
            chaos: r["chaos"]? Number(r["chaos"]) : null,
            poster: r["poster"]||"",
            runtime: r["runtime"]? Number(r["runtime"]) : null,
            flags: coerceFlags(r["flags"]||""),
            providers:[]
          };
          return mergeOverride(item);
        });
      } else {
        const base = await fetchMaybe("./data/watchlist.csv?v="+Date.now());
        if (!base) throw new Error("No movies.json or CSV found");
        const {rows} = parseCSV(base);
        MOVIES = rows.map(r=>{
          const item = {
            title: r["name"]||"",
            year: (r["year"]||"").slice(0,4),
            link: r["letterboxd uri"]||"",
            tagline: "",
            chaos: null,
            poster: "",
            runtime: null,
            flags: {},
            providers:[]
          };
          return mergeOverride(item);
        });
      }
    }

    MOVIES = MOVIES.map(m=>({
      ...m,
      chaos: (typeof m.chaos==="number" && !Number.isNaN(m.chaos)) ? m.chaos : null,
      flags: m.flags || {}
    }));

    $("#total").textContent = MOVIES.length;
    rebuildDeck();
  }catch(e){
    console.error(e);
    setUIError("Data not loaded yet (couldn’t find movies.json or CSV).");
  }
}

/* ====== PRESET HARD FILTERS ====== */
function presetPass(item){
  if (ACTIVE_PRESET==="none") return true;
  const f = item.flags || {};
  const c = (typeof item.chaos === "number") ? item.chaos : 50;

  if (ACTIVE_PRESET==="midnight"){
    const count = [f.theme_neon,f.extreme_gore,f.theme_body_horror,f.theme_found_footage,f.theme_witchy].filter(Boolean).length;
    if (count >= 2) return c >= 60;
    if (count === 1) return c >= 70;
    return false;
  }
  if (ACTIVE_PRESET==="cozy"){
    if (f.extreme_gore || f.sexual_violence) return false;
    return c <= 45;
  }
  if (ACTIVE_PRESET==="folk"){
    return (f.theme_folk || f.theme_witchy);
  }
  return true;
}

/* ====== THEMES & CONTENT ====== */
function themePass(item){
  const f=item.flags||{};
  if (THEME==="all") return true;
  if (THEME==="witch") return f.theme_witchy;
  if (THEME==="body")  return f.theme_body_horror;
  if (THEME==="folk")  return f.theme_folk;
  if (THEME==="found") return f.theme_found_footage;
  if (THEME==="neon")  return f.theme_neon;
  return true;
}
function contentPass(item){
  const f=item.flags||{};
  if (FILTERS.noGore && f.extreme_gore) return false;
  if (FILTERS.noSV && f.sexual_violence) return false;
  if (FILTERS.noKids && f.kids_in_peril) return false;
  return true;
}

/* ====== CHAOS WEIGHTING ====== */
function chaosTarget(){ return MODE==="order" ? 15 : MODE==="chaos" ? 85 : 50; }
function band(){ return VARIETY==="T"?8: VARIETY==="M"?18:35; }
function weightFor(chaos, target, width){
  if (typeof chaos!=="number") return 0.1;
  const d = (chaos - target)/width;
  return Math.exp(-0.5*d*d);
}
function weightedPick(indices, target, width){
  if (!indices.length) return null;
  const weights = indices.map(i=>{
    const c = typeof MOVIES[i].chaos==="number" ? MOVIES[i].chaos : 50;
    return weightFor(c, target, width);
  });
  let sum = weights.reduce((a,b)=>a+b,0);
  if (sum<=0) return indices[Math.floor(Math.random()*indices.length)];
  let r = Math.random()*sum;
  for (let k=0;k<indices.length;k++){
    r -= weights[k];
    if (r<=0) return indices[k];
  }
  return indices[indices.length-1];
}

/* ====== DECK ====== */
function rebuildDeck(){
  if (!MOVIES.length) return;
  const target = chaosTarget();
  let width = band();
  const todaysBan = (banished.date===todayKey()) ? new Set(banished.ids) : new Set();

  let cands = MOVIES.map((m,i)=>({m,i}))
    .filter(({m}) => presetPass(m) && !todaysBan.has(idFor(m)) && themePass(m) && contentPass(m))
    .map(x=>x.i);

  if (!cands.length) {
    cands = MOVIES.map((m,i)=>({m,i})).filter(({m})=>presetPass(m) && !todaysBan.has(idFor(m))).map(x=>x.i);
    if (!cands.length) cands = MOVIES.map((_,i)=>i);
  }

  // shuffle
  for (let i=cands.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [cands[i],cands[j]]=[cands[j],cands[i]]; }

  const deck=[];
  const used=new Set();
  const MAX = Math.min(80, cands.length);
  for (let n=0; n<MAX; n++){
    const pool = cands.filter(i=>!used.has(i));
    if (!pool.length) break;
    const idx = weightedPick(pool, target, width) ?? pool[0];
    used.add(idx);
    deck.push(idx);
    width = Math.max(10, width - (VARIETY==="T"?0.6:(VARIETY==="M"?0.4:0.2)));
  }

  DECK = deck.length ? deck : cands;
  $("#left").textContent = DECK.length;
  $("#deckCountMini").textContent = "Deck: " + DECK.length;
  updateResetVisibility();
  setUIError("");
}

/* ====== TMDb SEARCH (with yearless retry) ====== */
async function tmdbSearchPoster(title, year){
  if (!TMDB_API_KEY) return null;
  const key = cacheKey(title, year);
  if (TMDB_CACHE[key]?.poster) return TMDB_CACHE[key].poster;

  if (!tmdbSearchPoster._q) tmdbSearchPoster._q = Promise.resolve();
  tmdbSearchPoster._q = tmdbSearchPoster._q.then(()=>new Promise(res=>setTimeout(res,250)));
  await tmdbSearchPoster._q;

  async function call(params){
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("api_key", TMDB_API_KEY);
    for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error("search fail");
    return r.json();
  }

  try{
    let j = await call({ query:title, year:String(year||"").slice(0,4) });
    let hit = (j.results||[])[0];
    if (!hit || !hit.poster_path){
      j = await call({ query:title });
      hit = (j.results||[])[0];
    }
    const poster = hit?.poster_path || null;
    TMDB_CACHE[key] = TMDB_CACHE[key] || {};
    TMDB_CACHE[key].poster = poster;
    saveCache();
    return poster;
  }catch(e){
    console.warn("TMDb search error:", e);
    return null;
  }
}

async function ensurePoster(item){
  if (item.poster && String(item.poster).trim()) return item.poster;
  const found = await tmdbSearchPoster(item.title, item.year);
  if (found) { item.poster = found; return found; }
  return "";
}

/* ====== RENDER ====== */
function links(container, item){
  container.innerHTML = "";
  const lb=document.createElement("a");
  lb.textContent="Open on Letterboxd"; lb.href=item.link||"#"; lb.target="_blank"; lb.rel="noopener";
  container.appendChild(lb);

  const s=document.createElement("a");
  const q=encodeURIComponent(`${item.title} full movie site:archive.org OR site:youtube.com OR torrent`);
  s.textContent="Where to watch (search)"; s.href="https://www.google.com/search?q="+q; s.target="_blank"; s.rel="noopener";
  container.appendChild(s);
}

async function render(item){
  setPoster($("#poster"), "/null", item.title); // skeleton
  const posterPath = await ensurePoster(item);
  setPoster($("#poster"), posterPath || "/null", item.title);

  setText($("#title"), item.title||"Untitled");
  const tg=(item.tagline||"").trim(); setText($("#taglineInline"), tg); show($("#taglineInline"), !!tg);
  setText($("#year"), item.year ? `Year: ${item.year}` : "");
  const run=item.runtime?`${item.runtime} min`:""; setText($("#runChip"), run); show($("#runChip"), !!run);
  const c=item.chaos; if (typeof c==="number"){ setText($("#chaosChip"), `Chaos: ${c}`); show($("#chaosChip"),true);} else show($("#chaosChip"),false);
  links($("#linksRow"), item);
  show($("#presetLock"), ACTIVE_PRESET!=="none");
  if (ACTIVE_PRESET!=="none") $("#presetLock").textContent = (ACTIVE_PRESET==="midnight"?"Cult midnight":ACTIVE_PRESET==="cozy"?"Cozy offbeat":"Folk dread") + " 🔒";

  // Prefetch next 3 posters quietly
  prefetchNextPosters(3);
}

/* ====== PREFETCH ====== */
async function prefetchNextPosters(n=3){
  const peek = DECK.slice(-n);
  for (const idx of peek){
    const m = MOVIES[idx];
    if (m && !m.poster) { ensurePoster(m); }
  }
}

/* ====== PICKING ====== */
function safeDealIndex(){
  if (!DECK.length) rebuildDeck();
  let idx = DECK.pop();
  if (idx==null || idx===undefined || isNaN(idx)){ idx = Math.floor(Math.random()*(MOVIES.length||1)); }
  return idx;
}
function dealOne(){
  if (!MOVIES.length){ setUIError("Data not loaded yet."); return; }
  const idx = safeDealIndex(); lastPickIndex = idx; dealtOnce = true;
  $("#left").textContent = Math.max(0, DECK.length);
  render(MOVIES[idx]);
  updateResetVisibility();
  setUIError("");
  haptics("light");
}
function rerollNearby(){
  if (lastPickIndex==null){ dealOne(); return; }
  const curr=MOVIES[lastPickIndex], c=typeof curr.chaos==="number"?curr.chaos:50;
  let pool=[];
  for (let i=0;i<MOVIES.length;i++){
    if (i===lastPickIndex) continue;
    const m=MOVIES[i];
    if (!presetPass(m) || !themePass(m) || !contentPass(m)) continue;
    const cc=typeof m.chaos==="number"?m.chaos:50;
    if (Math.abs(cc-c)<=8) pool.push(i); // tighter band for vibe-consistent reroll
  }
  if (!pool.length){ pool = MOVIES.map((m,i)=>i).filter(i=>i!==lastPickIndex && presetPass(MOVIES[i]) && themePass(MOVIES[i]) && contentPass(MOVIES[i])); }
  if (!pool.length){ pool = MOVIES.map((_,i)=>i).filter(i=>i!==lastPickIndex); }
  const idx = pool[Math.floor(Math.random()*pool.length)];
  lastPickIndex = idx; render(MOVIES[idx]); haptics("mid");
}

/* ====== BANISH (long press 250ms on info column) ====== */
let lpTimer=null;
const infoLP = document.getElementById("longPressArea");
["touchstart","mousedown"].forEach(ev=>infoLP.addEventListener(ev, ()=>{ lpTimer=setTimeout(banishCurrent, 250); }, {passive:true}));
["touchend","touchcancel","mouseup","mouseleave"].forEach(ev=>infoLP.addEventListener(ev, ()=>clearTimeout(lpTimer)));
function banishCurrent(){
  if (lastPickIndex==null) return;
  const it = MOVIES[lastPickIndex];
  const key = idFor(it);
  if (banished.date !== todayKey()) banished = { date: todayKey(), ids: [] };
  if (!banished.ids.includes(key)) banished.ids.push(key);
  saveBanished();
  showToast("Banished for today — Undo");
  rebuildDeck(); dealOne(); haptics("heavy");
}
function undoBanish(){
  if (banished.date !== todayKey() || !banished.ids.length) return;
  banished.ids.pop(); saveBanished(); showToast("Undo ✓"); rebuildDeck();
}
function showToast(text){
  const t=$("#toast"); t.textContent=text; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 3000);
}

/* ====== SHARE CARD ====== */
async function shareCurrent(){
  if (lastPickIndex==null) return;
  const m = MOVIES[lastPickIndex];
  const posterPath = await ensurePoster(m);
  const posterUrl = posterURL(posterPath || "", "w500");

  // Build canvas
  const c = document.createElement("canvas");
  const W = 900, H = 1350; // 2:3 postcard
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  // bg
  ctx.fillStyle = "#0d0d0d"; ctx.fillRect(0,0,W,H);

  // poster
  try{
    const img = await loadImage(posterUrl);
    const pw = W-120, ph = Math.round((pw*3)/2), px = 60, py = 60;
    roundRect(ctx, px, py, pw, ph, 24); ctx.save(); ctx.clip();
    ctx.drawImage(img, px, py, pw, ph); ctx.restore();
  }catch{ /* ignore, poster fallback is fine */ }

  // title
  ctx.fillStyle="#eafff3"; ctx.font="bold 44px system-ui, -apple-system, Segoe UI, Inter";
  wrapText(ctx, m.title || "Untitled", 60, 990, W-120, 52);

  // tagline
  ctx.fillStyle="#cfe8dc"; ctx.font="400 28px system-ui, -apple-system, Segoe UI, Inter";
  wrapText(ctx, (m.tagline||"").trim(), 60, 1050, W-120, 36);

  // chip row
  const preset = (ACTIVE_PRESET==="midnight"?"Cult midnight":ACTIVE_PRESET==="cozy"?"Cozy offbeat":ACTIVE_PRESET==="folk"?"Folk dread":"Any");
  drawChip(ctx, `Chaos: ${typeof m.chaos==="number"?m.chaos:"—"}`, 60, 1150);
  drawChip(ctx, preset, 230, 1150);

  // footer
  ctx.fillStyle="#8fb8a5"; ctx.font="500 22px system-ui,-apple-system,Segoe UI,Inter";
  ctx.fillText("movie-roulette", 60, 1290);

  // blob
  const blob = await new Promise(res=> c.toBlob(b=>res(b),"image/png",0.92));
  const file = new File([blob], `${(m.title||"movie").replace(/\W+/g,'_')}.png`, {type:"image/png"});

  if (navigator.canShare && navigator.canShare({files:[file]})) {
    try{ await navigator.share({files:[file], text:`${m.title} — ${m.tagline||""}`}); return; }catch{}
  }
  // fallback: open image in new tab
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

// helpers for share
function loadImage(url){ return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=url; }); }
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function drawChip(ctx, text, x, y){
  ctx.save();
  ctx.font="bold 26px system-ui,-apple-system,Segoe UI,Inter";
  const padX=16, padY=10;
  const w = ctx.measureText(text).width + padX*2;
  ctx.fillStyle="#18291f"; ctx.strokeStyle="#284832"; ctx.lineWidth=2;
  roundRect(ctx, x, y-28, w, 42, 18); ctx.fill(); ctx.stroke();
  ctx.fillStyle="#bff7cf"; ctx.fillText(text, x+padX, y);
  ctx.restore();
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = (text||"").split(/\s+/); let line=""; let dy=0;
  for (let n=0;n<words.length;n++){
    const test = line + words[n] + " ";
    if (ctx.measureText(test).width > maxWidth && n>0){ ctx.fillText(line, x, y+dy); line=words[n]+" "; dy+=lineHeight; }
    else line=test;
  }
  ctx.fillText(line, x, y+dy);
}

/* ====== WIRES ====== */
$("#deal").onclick = ()=>{ dealOne(); };
$("#reroll").onclick = ()=>{ rerollNearby(); };
$("#shareCard").onclick = ()=>{ shareCurrent(); };

const dlg=$("#filtersDlg");
$("#openFilters").onclick = ()=>dlg.showModal();
$("#closeFilters").onclick = ()=>dlg.close();
$("#resetAll").onclick = ()=>{
  MODE="mix"; VARIETY="T"; THEME="all"; FILTERS={noGore:false,noSV:false,noKids:false}; ACTIVE_PRESET="none";
  [...$("#modeSegTop").children].forEach(b=>b.classList.remove("active")); $("#modeSegTop").children[1].classList.add("active");
  [...$("#biasSegTop").children].forEach(b=>b.classList.remove("active")); $("#biasSegTop").children[0].classList.add("active");
  ["thAll","thWitch","thBody","thFolk","thFound","thNeon"].forEach(id=>$("#"+id).classList.remove("active")); $("#thAll").classList.add("active");
  ["fNoGore","fNoSV","fNoKids"].forEach(id=>$("#"+id).classList.remove("active"));
  rebuildDeck(); dlg.close(); haptics("light");
};

/* mode & bias */
$("#modeSegTop").addEventListener("click",(e)=>{ if(e.target.tagName!=="BUTTON")return;
  MODE=e.target.dataset.mode; [...$("#modeSegTop").children].forEach(b=>b.classList.toggle("active",b===e.target)); rebuildDeck(); haptics("light"); });

$("#biasSegTop").addEventListener("click",(e)=>{ if(e.target.tagName!=="BUTTON")return;
  VARIETY=e.target.dataset.bias; [...$("#biasSegTop").children].forEach(b=>b.classList.toggle("active",b===e.target)); rebuildDeck(); haptics("light"); });

/* themes */
function setTheme(w){ THEME=w; ["thAll","thWitch","thBody","thFolk","thFound","thNeon"].forEach(id=>$("#"+id).classList.remove("active"));
  const map={all:"thAll",witch:"thWitch",body:"thBody",folk:"thFolk",found:"thFound",neon:"thNeon"}; $("#"+map[w]).classList.add("active"); rebuildDeck(); haptics("light"); }
$("#thAll").onclick=()=>setTheme("all"); $("#thWitch").onclick=()=>setTheme("witch"); $("#thBody").onclick=()=>setTheme("body");
$("#thFolk").onclick=()=>setTheme("folk"); $("#thFound").onclick=()=>setTheme("found"); $("#thNeon").onclick=()=>setTheme("neon");

/* content */
$("#fNoGore").onclick =()=>{ FILTERS.noGore=!FILTERS.noGore; $("#fNoGore").classList.toggle("active",FILTERS.noGore); rebuildDeck(); haptics("light"); };
$("#fNoSV").onclick   =()=>{ FILTERS.noSV=!FILTERS.noSV; $("#fNoSV").classList.toggle("active",FILTERS.noSV); rebuildDeck(); haptics("light"); };
$("#fNoKids").onclick =()=>{ FILTERS.noKids=!FILTERS.noKids; $("#fNoKids").classList.toggle("active",FILTERS.noKids); rebuildDeck(); haptics("light"); };

/* presets */
$("#presets").addEventListener("click",(e)=>{
  const b = e.target.closest(".preset"); if(!b) return;
  ACTIVE_PRESET = b.dataset.preset; // none | cozy | midnight | folk
  $("#presetLock").style.display = "inline-block";
  $("#presetLock").textContent = (ACTIVE_PRESET==="midnight"?"Cult midnight":ACTIVE_PRESET==="cozy"?"Cozy offbeat":"Folk dread")+" 🔒";
  rebuildDeck(); haptics("mid");
});
$("#presetLock").onclick = ()=>{ ACTIVE_PRESET="none"; $("#presetLock").style.display="none"; rebuildDeck(); };

/* reset deck */
function resetDeck(){ rebuildDeck(); $("#left").textContent = DECK.length; dealtOnce=false; updateResetVisibility(); haptics("mid"); }
function updateResetVisibility(){ show($("#resetDeck"), dealtOnce); }
$("#resetDeck").onclick = resetDeck;

/* undo */
$("#undo").onclick = ()=>{ undoBanish(); haptics("mid"); };

/* START */
loadData();
