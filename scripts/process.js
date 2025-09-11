// scripts/process.js
// Build movies.json from watchlist.csv, baking poster/providers/justwatch + AI "chaos" score (0..100).
// ENV REQ: TMDB_KEY (v3), OPENAI_API_KEY
// Optional: TMDB_REGION (default US)
// Inputs:
//   data/watchlist.csv  (Date,Name,Year,Letterboxd URI[,Tagline])
//   data/chaos-overrides.csv  (Title,Year,Chaos)  [optional]
//   data/chaos-overrides.json (array of {tmdbId?, title?, year?, chaos}) [optional]
// Outputs:
//   movies.json
//   data/watchlist_scored.csv (sorted by chaos desc)

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";

const TMDB_KEY = process.env.TMDB_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!TMDB_KEY) { console.error("Missing TMDB_KEY"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const REGION = process.env.TMDB_REGION || "US";
const ROOT = process.cwd();
const CSV_IN  = path.join(ROOT, "data", "watchlist.csv");
const CSV_OUT = path.join(ROOT, "data", "watchlist_scored.csv");
const OUT_JSON = path.join(ROOT, "movies.json");
const OVERRIDES_CSV = path.join(ROOT, "data", "chaos-overrides.csv");
const OVERRIDES_JSON = path.join(ROOT, "data", "chaos-overrides.json");
const CACHE_DIR = path.join(ROOT, ".cache");
await fs.mkdir(CACHE_DIR, { recursive: true });

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function detectDelimiter(txt){ const h=(txt.split(/\r?\n/)[0]||""); const cands=["\t",",",";","|"]; let best=[",",0];
  for (const d of cands){ const c=(h.match(new RegExp(escapeRe(d),"g"))||[]).length; if (c>best[1]) best=[d,c]; }
  return best[1]?best[0]:","; }
function parseYear(s){ const m=String(s||"").match(/\d{4}/); return m?Number(m[0]):undefined; }
function norm(s){ return (s||"").toLowerCase().replace(/[\s'".:;-]+/g,"").normalize("NFKD"); }
function uniqBy(arr, keyf){ const seen=new Set(); const out=[]; for (const x of arr){ const k=keyf(x); if(seen.has(k)) continue; seen.add(k); out.push(x);} return out; }

// TMDb
async function tmdbSearch(title, year){
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("query", title); if (year) url.searchParams.set("year", String(year));
  url.searchParams.set("include_adult", "false"); url.searchParams.set("api_key", TMDB_KEY);
  const r = await fetch(url); if(!r.ok) throw new Error(`TMDb search ${r.status}`); return r.json();
}
function chooseBest(results, title, year){
  if(!results?.length) return null;
  const tN = norm(title);
  let exact = results.find(r => norm(r.title)===tN && (!year || (r.release_date||"").startsWith(String(year))));
  if (exact) return exact;
  exact = results.find(r => norm(r.title)===tN); if (exact) return exact;
  if (year){
    const dec = Math.floor(Number(year)/10);
    const same = results.filter(r=>{ const y=(r.release_date||"").slice(0,4); return y && Math.floor(Number(y)/10)===dec; });
    if (same.length) return same.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
  }
  return results.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
}
async function tmdbDetails(id){
  const url = `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=keywords`;
  const r = await fetch(url); if(!r.ok) throw new Error(`TMDb details ${r.status}`); return r.json();
}
async function tmdbProviders(id){
  const url = `https://api.themoviedb.org/3/movie/${id}/watch/providers?api_key=${TMDB_KEY}`;
  const r = await fetch(url); if(!r.ok) return { link:"", providers:[] };
  const data = await r.json(); const entry = data?.results?.[REGION] || {};
  const buckets = [["flatrate","sub"],["rent","rent"],["buy","buy"],["free","free"],["ads","ads"]];
  const seen=new Set(); const providers=[];
  for (const [k, kind] of buckets){
    for (const p of (entry[k]||[])){
      if (seen.has(p.provider_id)) continue; seen.add(p.provider_id);
      providers.push({ id:p.provider_id, name:p.provider_name, logo_path:p.logo_path, kind });
    }
  }
  return { link: entry.link || "", providers };
}

// LLM call (OpenAI)
async function scoreChaosLLM(payload){
  // cache hit?
  const key = payload.cacheKey;
  const file = path.join(CACHE_DIR, `chaos-${key}.json`);
  try { const j = JSON.parse(await fs.readFile(file, "utf8")); return j; } catch {}

  const system = `You are rating how "chaotic" a film is on a 0–100 scale.
0 = clean, conventional, tame, mainstream tone.
100 = transgressive, grotesque, surreal/experimental, extreme horror, cult chaos.
Consider: subject matter (violence/body horror/taboo/absurdity), form (surreal/experimental), cultural vibe (cult, midnight, exploitation), age can add weirdness if it signals dated/odd aesthetics.
Do not inflate scores just for popularity. Be strict.`;

  const user = {
    title: payload.title,
    year: payload.year,
    tagline: payload.tagline || null,
    tmdb_overview: payload.overview || null,
    tmdb_genres: payload.genres || [],
    tmdb_keywords: payload.keywords || [],
    hints: "Return JSON with keys: chaos (int 0..100), reason (short string, 10-20 words)."
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role:"system", content: system },
        { role:"user", content: JSON.stringify(user) }
      ]
    })
  });
  if (!r.ok) throw new Error(`LLM ${r.status}`);
  const data = await r.json();
  let parsed;
  try { parsed = JSON.parse(data.choices[0].message.content); }
  catch { parsed = { chaos: 50, reason: "Defaulted: parse error." }; }

  // sanitize
  const chaos = Math.max(0, Math.min(100, Math.round(Number(parsed.chaos) || 50)));
  const reason = String(parsed.reason || "").slice(0,240);

  const out = { chaos, reason };
  await fs.writeFile(file, JSON.stringify(out, null, 2), "utf8");
  return out;
}

// overrides loader
async function loadOverrides(){
  const map = new Map(); // key: "id:123" or "title|year" -> chaos
  try {
    const raw = await fs.readFile(OVERRIDES_JSON, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const o of arr){
        const k = o.tmdbId ? `id:${o.tmdbId}` : `${(o.title||"").toLowerCase()}|${o.year||""}`;
        if (typeof o.chaos === "number") map.set(k, Math.max(0, Math.min(100, Math.round(o.chaos))));
      }
    }
  } catch {}
  try {
    const csv = await fs.readFile(OVERRIDES_CSV, "utf8");
    const rows = parse(csv, { columns:true, skip_empty_lines:true, relax_column_count:true, trim:true, delimiter: detectDelimiter(csv) });
    for (const r of rows){
      const title = (r.Title||r.Name||"").toLowerCase(); const year = parseYear(r.Year||"");
      const chaos = Number(r.Chaos);
      if (title && !Number.isNaN(chaos)) map.set(`${title}|${year||""}`, Math.max(0, Math.min(100, Math.round(chaos))));
    }
  } catch {}
  return map;
}

function toCsv(rows){
  if(!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = v => {
    const s = (v===null||v===undefined) ? "" : String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

async function main(){
  const raw = await fs.readFile(CSV_IN, "utf8");
  const rows = parse(raw, { columns:true, skip_empty_lines:true, relax_column_count:true, delimiter: detectDelimiter(raw), trim:true });

  const films = rows.map(r => ({
    title: (r.Name||r.Title||"").trim(),
    year: parseYear(r.Year),
    link: (r["Letterboxd URI"]||r.URI||"").trim(),
    tagline: (r.Tagline||"").toString().trim()
  })).filter(f => f.title);

  const list = uniqBy(films, f => (f.title+"|"+(f.year||"")).toLowerCase());
  console.log(`Found ${list.length} unique titles.`);

  const limit = pLimit(4);

  const enriched = await Promise.all(list.map(f => limit(async ()=>{
    try {
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year){ res = await tmdbSearch(f.title); best = chooseBest(res.results, f.title); }
      if (!best) {
        // No TMDb hit — still ask LLM with minimal info
        const { chaos, reason } = await scoreChaosLLM({ cacheKey: `none-${norm(f.title)}-${f.year||""}`, title:f.title, year:f.year, tagline:f.tagline });
        return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", chaos, chaos_reason:reason };
      }
      const { id, poster_path, overview, genres=[] } = await tmdbDetails(best.id).catch(()=>({ id:best.id, poster_path:best.poster_path, overview:"", genres:[] }));
      const kw = (await fetch(`https://api.themoviedb.org/3/movie/${best.id}/keywords?api_key=${TMDB_KEY}`).then(r=>r.ok?r.json():{keywords:[]}).catch(()=>({keywords:[]}))).keywords||[];
      const { link:justwatch, providers } = await tmdbProviders(best.id);
      const { chaos, reason } = await scoreChaosLLM({
        cacheKey: `id-${best.id}`,
        title: f.title, year: f.year, tagline: f.tagline,
        overview, genres: genres.map(g=>g.name), keywords: kw.map(k=>k.name)
      });
      return { ...f, tmdbId:best.id, poster:poster_path||"", providers, justwatch, chaos, chaos_reason:reason };
    } catch (e) {
      console.error("Error:", f.title, e.message);
      return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", chaos:50, chaos_reason:"Defaulted." };
    }
  })));

  // apply overrides
  const overrides = await loadOverrides();
  for (const x of enriched){
    const byId = x.tmdbId ? `id:${x.tmdbId}` : null;
    const byTy = `${x.title.toLowerCase()}|${x.year||""}`;
    if (byId && overrides.has(byId)) x.chaos = overrides.get(byId);
    else if (overrides.has(byTy)) x.chaos = overrides.get(byTy);
  }

  // write movies.json
  await fs.writeFile(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`Wrote ${OUT_JSON}`);

  // write CSV sorted by chaos (desc)
  const scoredRows = enriched
    .slice()
    .sort((a,b)=> (b.chaos??0) - (a.chaos??0))
    .map(x => ({
      Date: "", // intentionally blank; sortable sheet can ignore or you can fill if you want
      Name: x.title,
      Year: x.year||"",
      "Letterboxd URI": x.link||"",
      Tagline: x.tagline||"",
      Chaos: x.chaos,
      Reason: x.chaos_reason||""
    }));
  await fs.writeFile(CSV_OUT, toCsv(scoredRows), "utf8");
  console.log(`Wrote ${CSV_OUT} (sorted by chaos desc)`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
