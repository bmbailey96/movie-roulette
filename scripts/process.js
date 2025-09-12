// scripts/process.js
// Build movies.json from data/watchlist.csv
// - Looks up TMDb id, poster_path, runtime
// - Fetches US watch providers
// - Hardens poster handling (no null/undefined; always https; leading slash fixed)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CSV_PATH = path.join(ROOT, "data", "watchlist.csv");
const OUT_PATH = path.join(ROOT, "movies.json");
const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;

if (!TMDB_KEY) {
  console.error("❌ TMDB_KEY env var missing. Example:\n  export TMDB_KEY=YOUR_TMDB_V3_KEY");
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fetchJson = async (url) => {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

function parseCSV(text) {
  // Minimal CSV parser that handles quoted fields with commas and newlines
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    // trim BOM on first cell if present
    if (rows.length === 0 && row.length) {
      row[0] = row[0].replace(/^\uFEFF/, "");
    }
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { pushField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushField(); pushRow(); i++; continue; }
    field += ch; i++;
  }
  // last field/row
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) pushRow();

  // header + records
  const header = rows[0] || [];
  const recs = rows.slice(1).map((r, idx) => {
    const obj = {};
    header.forEach((h, j) => obj[h.trim()] = (r[j] ?? "").trim());
    obj.__row = idx + 2; // for diagnostics (1-based w/ header)
    return obj;
  });
  return { header, recs };
}

function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTitleMatch(q, cand) {
  const nq = normalizeTitle(q);
  const nc = normalizeTitle(cand);
  if (!nq || !nc) return 0;
  if (nq === nc) return 1.0;
  if (nc.includes(nq)) return 0.9;
  // token overlap
  const tq = new Set(nq.split(" "));
  const tc = new Set(nc.split(" "));
  let hit = 0;
  for (const t of tq) if (tc.has(t)) hit++;
  return hit / Math.max(1, tq.size);
}

function cleanPosterPath(p) {
  if (!p) return "";
  const s = String(p).trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return "";
  if (s.startsWith("http://")) return s.replace("http://", "https://");
  if (s.startsWith("https://")) return s;
  return s.startsWith("/") ? s : "/" + s;
}

async function tmdbSearch(title, year) {
  const q = encodeURIComponent(title);
  const y = year ? `&year=${encodeURIComponent(year)}` : "";
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&include_adult=false&query=${q}${y}`;
  const data = await fetchJson(url);
  return Array.isArray(data.results) ? data.results : [];
}

async function tmdbDetails(id) {
  return fetchJson(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
}

async function tmdbProviders(id) {
  const d = await fetchJson(`https://api.themoviedb.org/3/movie/${id}/watch/providers?api_key=${TMDB_KEY}`);
  const us = d.results?.US || d.results?.US || {};
  // Flatten flatrate + ads + free into simple list of names/icons
  const buckets = ["flatrate","ads","free","rent","buy"];
  const out = [];
  for (const b of buckets) {
    const arr = us[b] || [];
    for (const p of arr) out.push({ name: p.provider_name, logo: p.logo_path ? cleanPosterPath(p.logo_path) : "" });
  }
  // de-dup
  const seen = new Set();
  return out.filter(p => {
    const k = p.name;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

async function enrichOne(row) {
  const title = row["Name"] || row["Title"] || "";
  const year  = row["Year"] || "";
  const link  = row["Letterboxd URI"] || row["Letterboxd"] || row["Link"] || "";
  const tagline = row["Tagline"] || "";
  const chaos = row["Chaos"] !== "" ? Number(row["Chaos"]) : null;

  // flags (CSV uses 0/1)
  const flags = {
    theme_witchy: Number(row["Witchy"]||0) === 1,
    theme_body_horror: Number(row["Body"]||0) === 1,
    theme_folk: Number(row["Folk"]||0) === 1,
    theme_found_footage: Number(row["Found"]||0) === 1,
    theme_neon: Number(row["Neon"]||0) === 1,
    extreme_gore: Number(row["Gore"]||0) === 1,
    sexual_violence: Number(row["SexualViolence"]||0) === 1,
    kids_in_peril: Number(row["KidsInPeril"]||0) === 1
  };

  const base = {
    title, year: year ? Number(year) : undefined, link, tagline,
    chaos, flags,
  };

  // unreleased rows: leave placeholders but try search anyway (in case TMDb has posters)
  let results = [];
  try {
    results = await tmdbSearch(title, year ? Number(year) : undefined);
    await sleep(110); // be gentle
  } catch (e) {
    return { ...base, unreleased_error: `Search failed: ${e.message}` };
  }
  if (!results.length) {
    return { ...base, unreleased_error: "Not found on TMDb" };
  }

  // choose best candidate
  let best = null, bestScore = -1;
  for (const r of results) {
    let s = scoreTitleMatch(title, r.title || r.original_title || "");
    if (year && r.release_date) {
      const ry = Number(String(r.release_date).slice(0,4));
      if (ry && Math.abs(ry - Number(year)) <= 1) s += 0.08;
    }
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (!best) {
    return { ...base, unreleased_error: "No acceptable match" };
  }

  // details
  let details = {};
  try {
    details = await tmdbDetails(best.id);
    await sleep(110);
  } catch (e) { /* ignore, keep going */ }

  // providers
  let providers = [];
  try {
    providers = await tmdbProviders(best.id);
    await sleep(110);
  } catch (e) { /* ignore */ }

  const poster_path = cleanPosterPath(best.poster_path || details.poster_path || "");
  const runtime = Number(details.runtime) || undefined;

  return {
    ...base,
    tmdb_id: best.id,
    poster_path,
    poster: poster_path, // index.html prefers "poster" but we keep both
    runtime,
    providers
  };
}

async function main() {
  const csv = await fs.readFile(CSV_PATH, "utf8");
  const { header, recs } = parseCSV(csv);

  const REQUIRED = ["Name","Year","Letterboxd URI","Tagline","Chaos","Witchy","Body","Folk","Found","Neon","Gore","SexualViolence","KidsInPeril"];
  const missing = REQUIRED.filter(h => !header.includes(h));
  if (missing.length) {
    console.error("❌ CSV header missing columns:", missing.join(", "));
    process.exit(1);
  }

  console.log(`🟢 Rows: ${recs.length}. Enriching via TMDb…`);
  const out = [];
  for (let i=0;i<recs.length;i++){
    const row = recs[i];
    try {
      const item = await enrichOne(row);
      out.push(item);
      console.log(`  · ${i+1}/${recs.length} ${item.title} ${item.year||""} — ${item.poster_path ? "poster✓" : "no poster"}`);
    } catch (e) {
      console.log(`  · ${i+1}/${recs.length} ERROR: ${e.message}`);
      out.push({ title: row["Name"], year: row["Year"]?Number(row["Year"]):undefined, link: row["Letterboxd URI"], tagline: row["Tagline"]||"", chaos: row["Chaos"]!==""?Number(row["Chaos"]):null, flags:{
        theme_witchy:false, theme_body_horror:false, theme_folk:false, theme_found_footage:false, theme_neon:false, extreme_gore:false, sexual_violence:false, kids_in_peril:false
      }, unreleased_error: e.message });
    }
  }

  // write movies.json
  const json = JSON.stringify(out, null, 2);
  await fs.writeFile(OUT_PATH, json, "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.length} entries)`);
}

main().catch(e => { console.error("❌ Build failed:", e); process.exit(1); });
