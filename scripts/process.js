// scripts/process.js
// Build movies.json via TMDb + heuristics (no AI).
// ENV: TMDB_KEY (v3), optional TMDB_REGION (default "US")

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) { console.error("Missing TMDB_KEY"); process.exit(1); }

const REGION = process.env.TMDB_REGION || "US";
const ROOT = process.cwd();
const CSV_IN  = path.join(ROOT, "data", "watchlist.csv");
const OUT_JSON = path.join(ROOT, "movies.json");
const CSV_OUT = path.join(ROOT, "data", "watchlist_scored.csv");

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function detectDelimiter(txt){
  const h=(txt.split(/\r?\n/)[0]||"");
  const cands=["\t",",",";","|"]; let best=[",",0];
  for (const d of cands){ const c=(h.match(new RegExp(escapeRe(d),"g"))||[]).length; if (c>best[1]) best=[d,c]; }
  return best[1]?best[0]:",";
}
function parseYear(s){ const m=String(s||"").match(/\d{4}/); return m?Number(m[0]):undefined; }
function norm(s){ return (s||"").toLowerCase().replace(/[\s'".:;!?-]+/g,"").normalize("NFKD"); }
function uniqBy(arr, keyf){ const seen=new Set(); const out=[]; for (const x of arr){ const k=keyf(x); if(seen.has(k)) continue; seen.add(k); out.push(x);} return out; }

async function tmdbSearch(title, year){
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("query", title);
  if (year) url.searchParams.set("year", String(year));
  url.searchParams.set("include_adult", "true");
  url.searchParams.set("api_key", TMDB_KEY);
  const r = await fetch(url);
  if(!r.ok) throw new Error(`TMDb search ${r.status}`);
  return r.json();
}
function chooseBest(results, title, year){
  if(!results?.length) return null;
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

/* ---------- heuristics ---------- */
const titleBoosts = new Map(Object.entries({
  "begotten": 20, "tetsuo:theironman": 18, "wearetheflesh": 18, "taxidermia": 18,
  "sweetmovie": 18, "visitorq": 16, "santasangre": 14, "valerieandherweekofwonders": 12,
  "belladonnaofsadness": 14, "possession": 14, "thewolfhouse": 20, "964pinocchio": 16,
  "theboxersomen": 18, "streettrash": 12, "things": 16, "finalflesh": 16, "thepizzagatemassacre": 10,
  "funkyforestthefirstcontact": 12, "liquidsky": 12, "phantomoftheparadise": 8, "zardoz": 12,
}));

function flagByText(s, re){ return re.test(s); }
function any(s, arr){ return arr.some(re => re.test(s)); }

function classifyFlags({ title, overview, tagline, genres, keywords }){
  const bag = [
    title||"", overview||"", tagline||"",
    (genres||[]).join(" "), (keywords||[]).join(" ")
  ].join(" ").toLowerCase();

  const gore = any(bag, [/gore|gory|viscera|entrails|dismember|guignol|splatter|extreme horror|torture/]);
  const sexV = any(bag, [/rape|sexual\s+assault|molest|incest\b|sexual\s+violence/]);
  const kids = any(bag, [/\bchild\b.*(peril|harm|abduct|murder|die|death)|children.*(peril|harm|violence)|kids?[-\s]?in[-\s]?peril/]);

  const found = any(bag, [/found\s*footage|mockumentary|pov\b/]);
  const witch = any(bag, [/witch|covens?|occult|sabbath|pagan/]);
  const body  = any(bag, [/body\s*horror|mutation|metamorph|transformation|tumor|parasite|skin.*(peel|rot|rip)/]);
  const folk  = any(bag, [/folk\s*horror|ritual|pagan|rural|harvest|solstice/]);
  const neon  = any(bag, [/neon|cyberpunk|club|disco|city.*night|sleaze/]);

  return {
    extreme_gore: gore?1:0,
    sexual_violence: sexV?1:0,
    kids_in_peril: kids?1:0,
    theme_found_footage: found?1:0,
    theme_witchy: witch?1:0,
    theme_body_horror: body?1:0,
    theme_folk: folk?1:0,
    theme_neon: neon?1:0
  };
}

// coarse chaos from features; returns {score, reasons[]}
function chaosFromFeatures({ title, year, genres, keywords, overview, countries, runtime, flags }){
  let c = 35; const reasons = [];

  const tN = norm(title||"");
  if (titleBoosts.has(tN)){ c += titleBoosts.get(tN); reasons.push("cult chaos pedigree"); }

  const gset = new Set((genres||[]).map(x=>x.toLowerCase()));
  const kset = new Set((keywords||[]).map(x=>x.toLowerCase()));

  const add = (pts, why)=>{ c+=pts; reasons.push(why); };

  if (gset.has("horror")) add(15, "horror core");
  if (gset.has("science fiction") || gset.has("sci-fi")) add(6, "sci-fi strangeness");
  if (gset.has("fantasy")) add(4, "fantasy tilt");
  if (gset.has("animation")) add(4, "animation surreal option");
  if (gset.has("music") || gset.has("musical")) add(3, "musical oddity");

  // vibe keywords
  const kwPlus = ["surrealism","experimental film","cult film","body horror","witchcraft","occult",
                  "vampire","zombie","demon","found footage","splatter","giallo","possession",
                  "dream","hallucination","stop motion","erotic horror","necrophilia"];
  for (const k of kwPlus){ if (Array.from(kset).some(s=>s.includes(k))) add(4, k); }

  // flags weight
  if (flags.extreme_gore) add(14,"extreme gore");
  if (flags.sexual_violence) add(10,"sexual violence");
  if (flags.kids_in_peril) add(6,"kids-in-peril");
  if (flags.theme_body_horror) add(8,"body horror");
  if (flags.theme_witchy) add(6,"witchy/occult");
  if (flags.theme_folk) add(5,"folk dread");
  if (flags.theme_found_footage) add(5,"found-footage texture");
  if (flags.theme_neon) add(3,"neon grime");

  // era factor: pre-1990 cult → add a bit; squeaky-clean family titles → subtract
  if (year){
    if (year <= 1975) add(6,"old weird");
    else if (year <= 1990) add(4,"80s cult patina");
    else if (year >= 2015) add(0,"modern polish");
  }

  // runtime punisher
  if (runtime){
    if (runtime >= 150) add(4, "marathon length");
    else if (runtime <= 80) add(0, "merciful runtime");
  }

  // gentle genres dampener
  if (gset.has("romance") && !gset.has("horror")) c -= 6;
  if (gset.has("family") && !gset.has("horror")) c -= 12;
  if (gset.has("animation") && (title.toLowerCase().includes("goofy") || title.toLowerCase().includes("disney"))) c -= 16;

  c = Math.max(0, Math.min(100, Math.round(c)));
  // build 10–20 word reason
  const reasonParts = [];
  const pri = ["extreme gore","body horror","witchy/occult","folk dread","found-footage texture","surrealism","experimental film",
               "cult chaos pedigree","80s cult patina","old weird","sci-fi strangeness","musical oddity","neon grime","sexual violence","kids-in-peril"];
  for (const p of pri){ if (reasons.includes(p)) reasonParts.push(p); if (reasonParts.length>=4) break; }
  let reason = reasonParts.join(" · ");
  if (!reason) reason = "genre tilt and cult energy";
  return { score: c, reason };
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

/* ---------- main ---------- */
async function main(){
  const raw = await fs.readFile(CSV_IN, "utf8");
  const rows = parse(raw, {
    columns: true, skip_empty_lines: true, relax_column_count: true,
    delimiter: detectDelimiter(raw), trim: true
  });

  const list = uniqBy(rows.map(r => ({
    title: (r.Name||r.Title||"").trim(),
    year: parseYear(r.Year),
    link: (r["Letterboxd URI"]||r.URI||"").trim(),
    tagline: (r.Tagline||"").toString().trim()
  })).filter(f => f.title), f => (f.title+"|"+(f.year||"")).toLowerCase());

  const limit = pLimit(4);
  const enriched = await Promise.all(list.map(f => limit(async ()=>{
    try{
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year){ res = await tmdbSearch(f.title); best = chooseBest(res.results, f.title); }

      // If no TMDb hit, fallback minimal record
      if (!best){
        const flags = classifyFlags({ title:f.title, overview:"", tagline:f.tagline, genres:[], keywords:[] });
        const { score, reason } = chaosFromFeatures({ title:f.title, year:f.year, genres:[], keywords:[], overview:"", countries:[], runtime:null, flags });
        return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade: f.year? Math.floor(f.year/10)*10 : null,
          chaos: score, chaos_reason: reason, flags, unreleased_error: null };
      }

      const det = await tmdbDetails(best.id);
      const { link:justwatch, providers } = await tmdbProviders(best.id);

      const genres = (det.genres||[]).map(g=>g.name);
      const keywords = (det.keywords?.keywords || det.keywords || []).map(k=>k.name);
      const countries = (det.production_countries||[]).map(c=>c.iso_3166_1);
      const runtime = det.runtime || null;
      const decade = f.year ? Math.floor(f.year/10)*10 : null;
      const status = (det.status||"").toLowerCase();
      const releaseYear = (det.release_date||"").slice(0,4);
      const unreleased_error = (status && status!=="released") ? `Not released (TMDb status: ${det.status})` : null;

      const overview = det.overview || "";
      const flags = classifyFlags({ title:f.title, overview, tagline:f.tagline, genres, keywords });
      const { score, reason } = chaosFromFeatures({
        title:f.title, year:f.year || Number(releaseYear)||undefined, genres, keywords, overview, countries, runtime, flags
      });

      return {
        ...f,
        tmdbId: det.id,
        poster: det.poster_path || best.poster_path || "",
        providers, justwatch,
        runtime, genres, keywords, countries, decade,
        chaos: score, chaos_reason: reason,
        flags, unreleased_error
      };
    }catch(e){
      const flags = classifyFlags({ title:f.title, overview:"", tagline:f.tagline, genres:[], keywords:[] });
      const { score, reason } = chaosFromFeatures({ title:f.title, year:f.year, genres:[], keywords:[], overview:"", countries:[], runtime:null, flags });
      return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade: f.year? Math.floor(f.year/10)*10 : null,
        chaos: score, chaos_reason: reason, flags, unreleased_error: null };
    }
  })));

  await fs.writeFile(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`Wrote ${OUT_JSON}`);

  // scored CSV for eyeballing
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
      ExtremeGore: x.flags?.extreme_gore?1:0,
      SexualViolence: x.flags?.sexual_violence?1:0,
      KidsInPeril: x.flags?.kids_in_peril?1:0,
      Theme_Witchy: x.flags?.theme_witchy?1:0,
      Theme_BodyHorror: x.flags?.theme_body_horror?1:0,
      Theme_Folk: x.flags?.theme_folk?1:0,
      Theme_FoundFootage: x.flags?.theme_found_footage?1:0,
      Theme_Neon: x.flags?.theme_neon?1:0,
      Runtime: x.runtime||"",
      Genres: (x.genres||[]).join("|"),
      Keywords: (x.keywords||[]).join("|"),
      Countries: (x.countries||[]).join("|"),
      Decade: x.decade||"",
      UnreleasedError: x.unreleased_error||""
    }));
  await fs.writeFile(CSV_OUT, toCsv(scoredRows), "utf8");
  console.log(`Wrote ${CSV_OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
