// scripts/process.js
// Build movies.json via TMDb + heuristics (no AI) + manual overrides.
// ENV: TMDB_KEY (v3), optional TMDB_REGION (default "US")

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) { console.error("Missing TMDB_KEY"); process.exit(1); }

const REGION = process.env.TMDB_REGION || "US";
const ROOT = process.cwd();
const CSV_IN  = path.join(ROOT, "data", "watchlist.csv"); // may include optional ChaosOverride, ChaosNote
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
function norm(s){ return (s||"").toLowerCase().replace(/[\s'".:;!?()-]+/g,"").normalize("NFKD"); }
function uniqBy(arr, keyf){ const seen=new Set(); const out=[]; for (const x of arr){ const k=keyf(x); if(seen.has(k)) continue; seen.add(k); out.push(x);} return out; }

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

/* ---------- YOUR TASTE: quick per-title nudges ---------- */
const titleBias = new Map(Object.entries({
  // Lower safe sequels:
  "fridaythe13thpartviiijasontakesmanhattan": -18,
  "tremors": -6,
  "thelaststarfighter": -8,

  // Boost psychedelic/experimental/animated oddities:
  "belladonnaofsadness": +18,
  "catsoup": +16,
  "angelsegg": +18,
  "thewolfhouse": +24,
  "964pinocchio": +18,
  "liquidsky": +16,
  "valerieandherweekofwonders": +16,
  "fantasticplanet": +14,
  "begotten": +26,
  "finalflesh": +22,
  "things": +22
}));

/* ---------- Heuristic flags ---------- */
function bagText({ title, overview, tagline, genres, keywords }){
  return [
    title||"", overview||"", tagline||"",
    (genres||[]).join(" "), (keywords||[]).join(" ")
  ].join(" ").toLowerCase();
}
const RE = {
  gore: [/gore|gory|viscera|entrails|dismember|splatter|guignol|torture/],
  sexV: [/\brape\b|sexual\s+assault|molest|incest\b|sexual\s+violence/],
  kids: [/\bchild\b.*(peril|harm|abduct|murder|die|death)|children.*(peril|harm|violence)|kids?[-\s]?in[-\s]?peril/],
  found:[/found\s*footage|mockumentary|pov\b/],
  witch:[/\bwitch|\bcoven\b|occult|sabbath|pagan/],
  body: [/body\s*horror|mutation|metamorph|transformation|tumor|parasite|skin.*(peel|rot|rip)/],
  folk: [/folk\s*horror|ritual|pagan|rural|harvest|solstice/],
  neon: [/\bneon\b|cyberpunk|club|disco|city.*night|sleaze/],
  slasher: [/\bslasher\b|machete|hockey\s*mask|camp\s*crystal|freddy|jason\b/],
  sequelish: [/\bpart\s*[ivxlcdm]+\b|\bpart\s*\d+\b|\bchapter\s*\d+\b|\bsequel\b|episode\s*\d+/],
  psychAnim: [/rotoscope|cut[-\s]?out|stop[-\s]?motion|sand\s*animation|paint\s*on\s*glass|psychedelic|trippy|surreal|avant[-\s]?garde|experimental/],
};
const any = (arr, text) => arr.some(re => re.test(text));

function classifyFlags({ title, overview, tagline, genres, keywords }){
  const bag = bagText({ title, overview, tagline, genres, keywords });
  return {
    extreme_gore: any(RE.gore, bag)?1:0,
    sexual_violence: any(RE.sexV, bag)?1:0,
    kids_in_peril: any(RE.kids, bag)?1:0,
    theme_found_footage: any(RE.found, bag)?1:0,
    theme_witchy: any(RE.witch, bag)?1:0,
    theme_body_horror: any(RE.body, bag)?1:0,
    theme_folk: any(RE.folk, bag)?1:0,
    theme_neon: any(RE.neon, bag)?1:0,
    hint_slasher: any(RE.slasher, bag)?1:0,
    hint_sequelish: any(RE.sequelish, bag)?1:0,
    hint_psych_anim: any(RE.psychAnim, bag)?1:0,
  };
}

/* ---------- Chaos scoring tuned to you ---------- */
function chaosFromFeatures({ title, year, genres, keywords, overview, runtime, flags, popularity=0, vote_count=0 }){
  let c = 18; const notes = [];
  const gset = new Set((genres||[]).map(s=>s.toLowerCase()));
  const kset = new Set((keywords||[]).map(s=>s.toLowerCase()));
  const tN = norm(title||"");

  const add = (pts, why) => { c+=pts; notes.push(why); };

  // Core boosts
  if (gset.has("horror")) add(18,"horror core");
  if (gset.has("science fiction") || gset.has("sci-fi")) add(6,"sci-fi oddity");
  if (gset.has("fantasy")) add(4,"fantasy tilt");
  if (gset.has("animation")) add(3,"animation");

  // Psychedelic/experimental/“how did they make this”
  if (flags.hint_psych_anim) add(18,"psychedelic/experimental animation");
  const hwKeywords = ["surreal","experimental","avant-garde","stop motion","rotoscope","dream","hallucination"];
  for (const k of hwKeywords){ if (Array.from(kset).some(s=>s.includes(k))) add(5,k); }

  // Body/witch/folk/found/gore etc.
  if (flags.extreme_gore) add(16,"extreme gore");
  if (flags.sexual_violence) add(12,"sexual violence");
  if (flags.kids_in_peril) add(6,"kids-in-peril");
  if (flags.theme_body_horror) add(11,"body horror");
  if (flags.theme_witchy) add(7,"witch/occult");
  if (flags.theme_folk) add(6,"folk dread");
  if (flags.theme_found_footage) add(6,"found-footage");
  if (flags.theme_neon) add(3,"neon grime");

  // Era spice
  if (year){
    if (year <= 1975) add(6,"old weird");
    else if (year <= 1990) add(5,"80s cult patina");
  }

  // Runtime spice
  if (runtime && runtime >= 150) add(3,"marathon");

  // Franchise/Sequel/Safe slasher dampeners
  if (flags.hint_slasher) c -= 10;
  if (flags.hint_sequelish) c -= 8;

  // Mainstream romcom/family dampeners
  const isRomCom = (gset.has("romance") && gset.has("comedy"));
  const isFamilyish = gset.has("family");
  if (isRomCom && !gset.has("horror")) c -= 30;
  if (isFamilyish && !gset.has("horror")) c -= 28;

  // Popularity dampener if not spooky at all
  const spooky = (gset.has("horror") || flags.extreme_gore || flags.theme_body_horror || flags.theme_witchy || flags.theme_folk || flags.theme_found_footage || flags.hint_psych_anim);
  if (!spooky && vote_count>=10000 && popularity>=15) c -= 14;

  // Per-title bias
  if (titleBias.has(tN)) c += titleBias.get(tN);

  c = Math.max(0, Math.min(100, Math.round(c)));
  const pri = ["psychedelic/experimental animation","extreme gore","body horror","witch/occult","folk dread","found-footage","surreal","experimental","avant-garde","80s cult patina","old weird","sci-fi oddity"];
  const reason = pri.filter(p => notes.includes(p)).slice(0,4).join(" · ")
    || (isRomCom ? "mainstream romcom comfort" : "tame/mainstream tilt");
  return { score: c, reason };
}

/* ---------- CSV helpers ---------- */
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
    tagline: (r.Tagline||"").toString().trim(),
    chaosOverride: r.ChaosOverride !== undefined && r.ChaosOverride !== "" ? Number(r.ChaosOverride) : null,
    chaosNote: (r.ChaosNote||"").toString().trim()
  })).filter(f => f.title), f => (f.title+"|"+(f.year||"")).toLowerCase());

  const limit = pLimit(4);
  const enriched = await Promise.all(list.map(f => limit(async ()=>{
    try{
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year){ res = await tmdbSearch(f.title); best = chooseBest(res.results, f.title); }

      if (!best){
        const flags = classifyFlags({ title:f.title, overview:"", tagline:f.tagline, genres:[], keywords:[] });
        const { score, reason } = chaosFromFeatures({ title:f.title, year:f.year, genres:[], keywords:[], overview:"", runtime:null, flags });
        const chaos = f.chaosOverride!=null ? Math.max(0, Math.min(100, Math.round(f.chaosOverride))) : score;
        return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade: f.year? Math.floor(f.year/10)*10 : null,
          chaos, chaos_reason: f.chaosNote || reason, flags, unreleased_error: null, popularity:0, vote_count:0 };
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

      const popularity = Number(det.popularity||0);
      const vote_count = Number(det.vote_count||0);

      const overview = det.overview || "";
      const flags = classifyFlags({ title:f.title, overview, tagline:f.tagline, genres, keywords });
      const { score, reason } = chaosFromFeatures({
        title:f.title, year:f.year || Number(releaseYear)||undefined, genres, keywords, overview, runtime, flags, popularity, vote_count
      });

      // --- Poster normalization (always ensure leading /) ---
      const rawPoster = det.poster_path || best.poster_path || "";
      const poster = rawPoster ? (rawPoster.startsWith("/") ? rawPoster : "/"+rawPoster) : "";

      const chaos = f.chaosOverride!=null ? Math.max(0, Math.min(100, Math.round(f.chaosOverride))) : score;

      return {
        ...f,
        tmdbId: det.id,
        poster, providers, justwatch,
        runtime, genres, keywords, countries, decade,
        chaos, chaos_reason: f.chaosNote || reason,
        flags, unreleased_error,
        popularity, vote_count
      };
    }catch(e){
      const flags = classifyFlags({ title:f.title, overview:"", tagline:f.tagline, genres:[], keywords:[] });
      const { score, reason } = chaosFromFeatures({ title:f.title, year:f.year, genres:[], keywords:[], overview:"", runtime:null, flags });
      const chaos = f.chaosOverride!=null ? Math.max(0, Math.min(100, Math.round(f.chaosOverride))) : score;
      return { ...f, tmdbId:null, poster:"", providers:[], justwatch:"", runtime:null, genres:[], keywords:[], countries:[], decade: f.year? Math.floor(f.year/10)*10 : null,
        chaos, chaos_reason: f.chaosNote || reason, flags, unreleased_error: null, popularity:0, vote_count:0 };
    }
  })));

  await fs.writeFile(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`Wrote ${OUT_JSON}`);

  // scored CSV for inspection
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
      Hint_Slasher: x.flags?.hint_slasher?1:0,
      Hint_Sequelish: x.flags?.hint_sequelish?1:0,
      Hint_PsychAnim: x.flags?.hint_psych_anim?1:0,
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
