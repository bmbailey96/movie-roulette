// scripts/process.js
// Build movies.json from enriched CSV + TMDb. Uses CSV Chaos & tags directly.
// ENV: TMDB_KEY (v3), optional TMDB_REGION (default "US")

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) { console.error("Missing TMDB_KEY"); process.exit(1); }

const REGION = process.env.TMDB_REGION || "US";
const ROOT = process.cwd();
const CSV_IN  = path.join(ROOT, "data", "watchlist.csv"); // enriched
const OUT_JSON = path.join(ROOT, "movies.json");

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function detectDelimiter(txt){
  const h=(txt.split(/\r?\n/)[0]||"");
  const cands=["\t",",",";","|"]; let best=[",",0];
  for (const d of cands){ const c=(h.match(new RegExp(escapeRe(d),"g"))||[]).length; if (c>best[1]) best=[d,c]; }
  return best[1]?best[0]:",";
}
function parseYear(s){ const m=String(s||"").match(/\d{4}/); return m?Number(m[0]):undefined; }
function uniqBy(arr,keyf){ const seen=new Set(); const out=[]; for (const x of arr){ const k=keyf(x); if(seen.has(k)) continue; seen.add(k); out.push(x);} return out; }

async function tmdbSearch(title, year){
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("query", title);
  if (year) url.searchParams.set("year", String(year));
  url.searchParams.set("include_adult", "true");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("api_key", TMDB_KEY);
  const r = await fetch(url);
  if(!r.ok) throw new Error(`TMDb search ${r.status}`);
  return r.json();
}
function chooseBest(results, title, year){
  if(!results?.length) return null;
  const norm = s => (s||"").toLowerCase().normalize("NFKD").replace(/[\s'".:;!?()-]+/g,"");
  const tN = norm(title);
  let exact = results.find(r => norm(r.title)===tN && (!year || (r.release_date||"").startsWith(String(year))));
  if (exact) return exact;
  exact = results.find(r => norm(r.title)===tN);
  if (exact) return exact;
  if (year){
    const dec = Math.floor(Number(year)/10);
    const same = results.filter(r=>{
      const y=(r.release_date||"").slice(0,4);
      return y && Math.floor(Number(y)/10)===dec;
    });
    if (same.length) return same.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
  }
  return results.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
}
async function tmdbDetails(id){
  const url = `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=release_dates,keywords`;
  const r = await fetch(url);
  if(!r.ok) throw new Error(`TMDb details ${r.status}`);
  return r.json();
}
async function tmdbProviders(id){
  const url = `https://api.themoviedb.org/3/movie/${id}/watch/providers?api_key=${TMDB_KEY}`;
  const r = await fetch(url);
  if(!r.ok) return { link:"", providers:[] };
  const data = await r.json();
  const entry = data?.results?.[REGION] || {};
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

function bool(x){ return (String(x||"").trim()==="1" || String(x||"").toLowerCase().trim()==="true") ? 1 : 0; }

async function main(){
  const raw = await fs.readFile(CSV_IN, "utf8");
  const rows = parse(raw, { columns:true, skip_empty_lines:true, relax_column_count:true, delimiter:detectDelimiter(raw), trim:true });

  const list = uniqBy(rows.map(r => ({
    title: (r.Name||r.Title||"").trim(),
    year: parseYear(r.Year),
    link: (r["Letterboxd URI"]||r.URI||"").trim(),
    tagline: (r.Tagline||"").toString().trim(),
    // CSV-driven chaos & flags:
    chaos: r.Chaos!==undefined && r.Chaos!=="" ? Number(r.Chaos) : null,
    flags_csv: {
      extreme_gore:        bool(r.Gore),
      sexual_violence:     bool(r.SexualViolence),
      kids_in_peril:       bool(r.KidsInPeril),
      theme_witchy:        bool(r.Witchy),
      theme_body_horror:   bool(r.Body),
      theme_folk:          bool(r.Folk),
      theme_found_footage: bool(r.Found),
      theme_neon:          bool(r.Neon)
    }
  })).filter(f => f.title), f => (f.title+"|"+(f.year||"")).toLowerCase());

  const limit = pLimit(4);
  const enriched = await Promise.all(list.map(f => limit(async ()=>{
    try{
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year){ res = await tmdbSearch(f.title); best = chooseBest(res.results, f.title); }

      if (!best){
        return { ...f, tmdbId:null, poster_path:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[],
                 decade: f.year? Math.floor(f.year/10)*10 : null, chaos:f.chaos, chaos_reason:"", flags:f.flags_csv, unreleased_error:null };
      }

      const det = await tmdbDetails(best.id);
      const { link:justwatch, providers } = await tmdbProviders(best.id);

      const status = (det.status||"").toLowerCase();
      const unreleased_error = (status && status!=="released") ? `Not released (TMDb status: ${det.status})` : null;

      return {
        ...f,
        tmdbId: det.id,
        poster_path: det.poster_path || best.poster_path || "",
        providers, justwatch,
        runtime: det.runtime || null,
        genres: (det.genres||[]).map(g=>g.name),
        keywords: (det.keywords?.keywords || det.keywords || []).map(k=>k.name),
        countries: (det.production_countries||[]).map(c=>c.iso_3166_1),
        decade: f.year? Math.floor(f.year/10)*10 : null,
        chaos: f.chaos,               // use CSV value
        chaos_reason: "",             // optional: keep blank for now
        flags: f.flags_csv,
        unreleased_error
      };
    }catch(e){
      return { ...f, tmdbId:null, poster_path:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[],
               decade: f.year? Math.floor(f.year/10)*10 : null, chaos:f.chaos, chaos_reason:"", flags:f.flags_csv, unreleased_error:null };
    }
  })));

  await fs.writeFile(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`Wrote ${OUT_JSON}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
