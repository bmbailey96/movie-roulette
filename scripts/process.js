// scripts/process.js
// Build movies.json from watchlist.csv, baking poster/providers/justwatch + AI "chaos" (0..100) & reason,
// plus metadata: runtime, genres, keywords, countries, decade, and content flags.
// ENV: TMDB_KEY (v3), OPENAI_API_KEY, optional TMDB_REGION (default US)

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
const OUT_JSON = path.join(ROOT, "movies.json");
const CSV_OUT = path.join(ROOT, "data", "watchlist_scored.csv");
const CACHE_DIR = path.join(ROOT, ".cache");
await fs.mkdir(CACHE_DIR, { recursive: true });

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function detectDelimiter(txt){ const h=(txt.split(/\r?\n/)[0]||""); const cands=["\t",",",";","|"]; let best=[",",0];
  for (const d of cands){ const c=(h.match(new RegExp(escapeRe(d),"g"))||[]).length; if (c>best[1]) best=[d,c]; }
  return best[1]?best[0]:","; }
function parseYear(s){ const m=String(s||"").match(/\d{4}/); return m?Number(m[0]):undefined; }
function norm(s){ return (s||"").toLowerCase().replace(/[\s'".:;-]+/g,"").normalize("NFKD"); }
function uniqBy(arr, keyf){ const seen=new Set(); const out=[]; for (const x of arr){ const k=keyf(x); if(seen.has(k)) continue; seen.add(k); out.push(x);} return out; }

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

async function scoreChaosLLM(payload){
  const key = payload.cacheKey;
  const file = path.join(CACHE_DIR, `chaos-${key}.json`);
  try { const j = JSON.parse(await fs.readFile(file, "utf8")); return j; } catch {}

  const system = `You rate how "chaotic" a film is on 0–100.
0 = conventional/tame/mainstream. 100 = transgressive/grotesque/surreal/experimental/extreme horror/cult.
Consider tone, subject matter (taboo/violence/body horror), form (surreal/experimental), cult vibes.
Return concise JSON: {"chaos": int 0..100, "reason": "10-20 words"}.`;

  const user = {
    title: payload.title,
    year: payload.year,
    tagline: payload.tagline || null,
    tmdb_overview: payload.overview || null,
    tmdb_genres: payload.genres || [],
    tmdb_keywords: payload.keywords || [],
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
  let out = { chaos: 50, reason: "Defaulted." };
  try { out = JSON.parse(data.choices[0].message.content); } catch {}
  const chaos = Math.max(0, Math.min(100, Math.round(Number(out.chaos) || 50)));
  const reason = String(out.reason || "").slice(0,240);
  const res = { chaos, reason };
  await fs.writeFile(file, JSON.stringify(res, null, 2), "utf8");
  return res;
}

// heuristics for content flags / themes
function mkFlags({ title, tagline, overview, keywords, genres }){
  const text = [title, tagline, overview, (keywords||[]).join(" "), (genres||[]).join(" ")].join(" ").toLowerCase();

  const has = re => re.test(text);
  const any = arr => arr.some(re => re.test(text));

  const gore = any([/\bgore\b/,/\bgory\b/,/\bgorefest\b/,/\bguts?\b/,/\bviscera\b/,/\bdismember/,/\bdisembowel/,/\bgore\s?horror\b/,/\bguignol\b/,/\bextreme\b/]);
  const sexualViolence = any([/\brape\b/,/\bsexual\s+assault\b/,/\bmolest/,/\bviolen(t|ce)\s*sexual/,/\bincest\b/]);
  const kids = any([/\bchild\b/,/\bkid(s)?\b.*(peril|endanger|abduct|murder|die|death)/,/\bchildren.*(peril|harm|violence)/,/\bkidnapp?ing\b/]);

  const foundFootage = any([/\bfound\s*footage\b/,/\bpov\b/,/\bmockumentary\b/]);
  const witchy = any([/\bwitch(es|craft)?\b/,/\boccult\b/,/\bsabbath\b/,/\bcoven\b/]);
  const bodyHorror = any([/\bbody\s*horror\b/,/\bmutation\b/,/\bmetamorph/,/\btransformation\b/,/\btumor\b/,/\bparasite\b/,/\bskin\b.*(peel|rip|rot)/]);
  const folk = any([/\bfolk\s*horror\b/,/\bpagan\b/,/\brural\b/,/\britual\b/,/\bharvest\b/,/\bsolstice\b/]);
  const neon = any([/\bneon\b/,/\bcyberpunk\b/,/\bnitelife\b/,/\bclub\b/,/\bdisco\b/,/\bcity\b.*\bnight\b/]);

  return {
    extreme_gore: gore ? 1 : 0,
    sexual_violence: sexualViolence ? 1 : 0,
    kids_in_peril: kids ? 1 : 0,
    theme_found_footage: foundFootage ? 1 : 0,
    theme_witchy: witchy ? 1 : 0,
    theme_body_horror: bodyHorror ? 1 : 0,
    theme_folk: folk ? 1 : 0,
    theme_neon: neon ? 1 : 0
  };
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
        // minimal info path
        const { chaos, reason } = await scoreChaosLLM({ cacheKey: `none-${norm(f.title)}-${f.year||""}`, title:f.title, year:f.year, tagline:f.tagline });
        const flags = mkFlags({ title:f.title, tagline:f.tagline, overview:"", keywords:[], genres:[] });
        const decade = f.year ? Math.floor(f.year/10)*10 : null;
        return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade, chaos, chaos_reason:reason, flags };
      }
      const det = await tmdbDetails(best.id).catch(()=>({ id:best.id, poster_path:best.poster_path, overview:"", genres:[], runtime:null, production_countries:[] }));
      const kwr = await fetch(`https://api.themoviedb.org/3/movie/${best.id}/keywords?api_key=${TMDB_KEY}`).then(r=>r.ok?r.json():{keywords:[]}).catch(()=>({keywords:[]}));
      const kw = kwr.keywords||[];
      const { link:justwatch, providers } = await tmdbProviders(best.id);

      const genres = (det.genres||[]).map(g=>g.name);
      const keywords = kw.map(k=>k.name);
      const countries = (det.production_countries||[]).map(c=>c.iso_3166_1);
      const overview = det.overview || "";
      const runtime = det.runtime || null;
      const decade = f.year ? Math.floor(f.year/10)*10 : null;

      const { chaos, reason } = await scoreChaosLLM({
        cacheKey: `id-${best.id}`,
        title: f.title, year: f.year, tagline: f.tagline,
        overview, genres, keywords
      });

      const flags = mkFlags({ title:f.title, tagline:f.tagline, overview, keywords, genres });

      return {
        ...f,
        tmdbId: best.id,
        poster: det.poster_path || best.poster_path || "",
        providers, justwatch,
        runtime, genres, keywords, countries, decade,
        chaos, chaos_reason: reason,
        flags
      };
    } catch (e) {
      console.error("Error:", f.title, e.message);
      const decade = f.year ? Math.floor(f.year/10)*10 : null;
      const flags = mkFlags({ title:f.title, tagline:f.tagline, overview:"", keywords:[], genres:[] });
      return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade, chaos:50, chaos_reason:"Defaulted.", flags };
    }
  })));

  await fs.writeFile(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`Wrote ${OUT_JSON}`);

  // Also emit a scored CSV (chaos desc)
  const scoredRows = enriched
    .slice()
    .sort((a,b)=> (b.chaos??0) - (a.chaos??0))
    .map(x => ({
      Date: "",
      Name: x.title,
      Year: x.year||"",
      "Letterboxd URI": x.link||"",
      Tagline: x.tagline||"",
      Chaos: x.chaos,
      Reason: x.chaos_reason||"",
      Runtime: x.runtime||"",
      Genres: (x.genres||[]).join("|"),
      Keywords: (x.keywords||[]).join("|"),
      Countries: (x.countries||[]).join("|"),
      Decade: x.decade||""
    }));
  await fs.writeFile(CSV_OUT, toCsv(scoredRows), "utf8");
  console.log(`Wrote ${CSV_OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
