// Build movies.json from Letterboxd watchlist.csv using TMDb
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

const ROOT = path.resolve(process.cwd());
const CSV_PATH = path.join(ROOT, "data", "watchlist.csv");
const OUT_PATH = path.join(ROOT, "movies.json");

function norm(s) {
  return (s || "").toLowerCase().replace(/[\s'".:;-]+/g, "").normalize("NFKD");
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
  // exact title + year
  let exact = results.find(
    r => norm(r.title) === tNorm &&
      (!year || (r.release_date || "").startsWith(String(year)))
  );
  if (exact) return exact;
  // exact title any year
  exact = results.find(r => norm(r.title) === tNorm);
  if (exact) return exact;
  // same decade popularity
  if (year) {
    const decade = Math.floor(Number(year) / 10);
    const sameDecade = results.filter(r => {
      const y = (r.release_date || "").slice(0, 4);
      return y && Math.floor(Number(y) / 10) === decade;
    });
    if (sameDecade.length) return sameDecade.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  }
  // popularity fallback
  return results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
}

function parseYear(s) {
  const m = String(s || "").match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

async function main() {
  const csvRaw = await fs.readFile(CSV_PATH, "utf8");
  const rows = parse(csvRaw, { columns: true, skip_empty_lines: true });

  // Letterboxd watchlist.csv typically has Name, Year, Rating, Letterboxd URI, etc.
  const films = rows.map(r => ({
    title: (r.Name || r.Title || "").trim(),
    year: parseYear(r.Year),
    link: (r["Letterboxd URI"] || r.URI || "").trim()
  })).filter(f => f.title);

  // de-dupe
  const seen = new Set();
  const unique = [];
  for (const f of films) {
    const key = (f.title + "|" + (f.year || "")).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  console.log(`Found ${unique.length} films in watchlist.csv`);

  const limit = pLimit(10); // be polite
  const results = await Promise.all(unique.map(f => limit(async () => {
    try {
      let res = await tmdbSearch(f.title, f.year);
      let best = chooseBest(res.results, f.title, f.year);
      if (!best && f.year) {
        res = await tmdbSearch(f.title, undefined);
        best = chooseBest(res.results, f.title, undefined);
      }
      if (!best) {
        return { ...f, tmdbId: null, poster: "" };
      }
      return {
        ...f,
        tmdbId: best.id,
        poster: best.poster_path || ""
      };
    } catch {
      return { ...f, tmdbId: null, poster: "" };
    }
  })));

  await fs.writeFile(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
  console.log(`Wrote ${OUT_PATH} (${results.length} items)`);
}

main().catch(e => { console.error(e); process.exit(1); });
