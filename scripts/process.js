// scripts/process.js
// Build movies.json from Letterboxd CSV/TSV with Tagline column.
// Also bakes TMDb poster paths AND watch providers (so front-end needs no key).
import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import fetch from "node-fetch";
import pLimit from "p-limit";

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) {
  console.error("Missing TMDB_KEY env var");
  process.exit(1);
}

// Change region if you want (e.g., "GB", "CA")
const REGION = process.env.TMDB_REGION || "US";

const ROOT = path.resolve(process.cwd());
const CSV_PATH = path.join(ROOT, "data", "watchlist.csv");
const OUT_PATH = path.join(ROOT, "movies.json");

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function detectDelimiter(text) {
  const header = (text.split(/\r?\n/)[0] || "");
  const cands = ["\t", ",", ";", "|"];
  let best = {d:",", c:0};
  for (const d of cands) {
    const c = (header.match(new RegExp(escapeRegExp(d), "g")) || []).length;
    if (c > best.c) best = {d, c};
  }
  return best.c ? best.d : ",";
}
function norm(s) {
  return (s || "").toLowerCase().replace(/[\s'".:;-]+/g, "").normalize("NFKD");
}
function parseYear(s) {
  const m = String(s || "").match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

async function tmdbSearch(title, year) {
  const base = "https://api.themoviedb.org/3/search/movie";
  const params = new URLSearchParams({
    query: title,
    include_adult: "false",
    ...(year ? { year: String(year) } : {}),
    api_key: TMDB_KEY
  });
  const r = await fetch(`${base}?${params}`);
  if (!r.ok) throw new Error(`TMDb search ${r.status}`);
  return r.json();
}
function chooseBest(results, title, year) {
  if (!results?.length) return null;
  const tNorm = norm(title);

  let exact = results.find(
    r => norm(r.title) === tNorm &&
      (!year || (r.release_date || "").startsWith(String(year)))
  );
  if (exact) return exact;

  exact = results.find(r => norm(r.title) === tNorm);
  if (exact) return exact;

  if (year) {
    const decade = Math.floor(Number(year) / 10);
    const sameDecade = results.filter(r => {
      const y = (r.release_date || "").slice(0, 4);
      return y && Math.floor(Number(y) / 10) === decade;
    });
    if (sameDecade.length) {
      return sameDecade.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
    }
  }
  return results.sort((a,b)=>(b.popularity||0)-(a.popularity||0))[0];
}

async function tmdbProviders(movieId, region) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}/watch/providers?api_key=${TMDB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return { link: "", providers: [] };
  const data = await r.json();
  const entry = data?.results?.[region] || {};
  const buckets = [
    ["flatrate", "sub"],
    ["rent", "rent"],
    ["buy", "buy"],
    ["free", "free"],
    ["ads", "ads"]
  ];
  const seen = new Set();
  const providers = [];
  for (const [key, kind] of buckets) {
    for (const p of (entry[key] || [])) {
      if (seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      providers.push({
        id: p.provider_id,
        name: p.provider_name,
        logo_path: p.logo_path,
        kind
      });
    }
  }
  return { link: entry.link || "", providers };
}

function parseRows(csvRaw) {
  const delimiter = detectDelimiter(csvRaw);
  return parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    trim: true
  });
}

async function main() {
  const csvRaw = await fs.readFile(CSV_PATH, "utf8");
  const rows = parseRows(csvRaw);

  // Expect: Date, Name, Year, Letterboxd URI, Tagline (Tagline optional)
  const films = rows.map(r => {
    const title = (r.Name || r.Title || r.name || "").trim();
    const year = parseYear(r.Year || r.year);
    const link = (r["Letterboxd URI"] || r.URI || r.url || "").trim();
    const tagline = (r.Tagline || r.tagline || "").toString().trim();
    return { title, year, link, tagline };
  }).filter(f => f.title);

  // de-dupe by title+year
  const seen = new Set();
  const unique = [];
  for (const f of films) {
    const key = (f.title + "|" + (f.year || "")).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  console.log(`Found ${unique.length} films in watchlist.csv`);

  const limit = pLimit(6); // keep it polite
  const results = await Promise.all(unique.map(f => limit(async () => {
    try {
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year) {
        res = await tmdbSearch(f.title, undefined);
        best = chooseBest(res.results, f.title, undefined);
      }
      if (!best) {
        return { ...f, tmdbId: null, poster: "", providers: [], justwatch: "" };
      }
      const { id, poster_path } = best;
      // fetch providers for baked badges
      let jwLink = "", providers = [];
      try {
        const pv = await tmdbProviders(id, REGION);
        jwLink = pv.link; providers = pv.providers;
      } catch {}
      return {
        ...f,
        tmdbId: id,
        poster: poster_path || "",
        providers,
        justwatch: jwLink
      };
    } catch (e) {
      console.warn(`Miss: ${f.title} (${f.year || "?"})`);
      return { ...f, tmdbId: null, poster: "", providers: [], justwatch: "" };
    }
  })));

  await fs.writeFile(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
  console.log(`Wrote ${OUT_PATH} (${results.length} items)`);
}

main().catch(e => { console.error(e); process.exit(1); });
