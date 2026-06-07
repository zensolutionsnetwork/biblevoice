#!/usr/bin/env node
/**
 * God AI / BibleVoice — Generic translation assembler (protocanon, 66 books).
 *
 * Pulls a public-domain translation from the HelloAO Free Use Bible API and
 * normalizes it into our schema, tagged with a language code so canon.ts can
 * serve language-specific canon sets.
 *
 * Usage: node scripts/assemble_translation.mjs <helloaoId> <outDir> <translationId> <translationName> <language>
 *   e.g. node scripts/assemble_translation.mjs fra_lsg lsg LSG "Louis Segond 1910" fr
 *        node scripts/assemble_translation.mjs spa_r09 rv09 RV09 "Reina Valera 1909" es
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [helloaoId, outDirName, trId, trName, language] = process.argv.slice(2);
if (!helloaoId || !outDirName || !trId || !trName || !language) {
  console.error("Usage: assemble_translation.mjs <helloaoId> <outDir> <translationId> <translationName> <language>");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data/bible", outDirName);
const SRC = `https://bible.helloao.org/api/${helloaoId}/complete.json`;

const OT = new Set(["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO","ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL"]);
const NT = new Set(["MAT","MRK","LUK","JHN","ACT","ROM","1CO","2CO","GAL","EPH","PHP","COL","1TH","2TH","1TI","2TI","TIT","PHM","HEB","JAS","1PE","2PE","1JN","2JN","3JN","JUD","REV"]);

// Some sources ship ALL-CAPS book names (e.g. LSG "JEAN", "CANTIQUE DES CANTIQUES").
// Normalize to title case, keeping French/Spanish connective words lowercase.
const SMALL = new Set(["de", "des", "du", "la", "le", "les", "et", "d'", "a", "los", "las", "el", "y"]);
function fixName(name) {
  if (name !== name.toUpperCase()) return name; // already mixed case
  return name
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log("Fetching", SRC);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error("Fetch failed: " + res.status);
  const data = await res.json();
  const books = (data.books || []).filter((b) => OT.has(b.id) || NT.has(b.id));
  console.log("Protocanon books in source:", books.length);
  if (books.length !== 66) console.warn("WARNING: expected 66 protocanon books, got", books.length);

  const index = [];
  let totalVerses = 0;
  for (const b of books) {
    const chapters = [];
    let bookVerses = 0;
    for (const cw of b.chapters || []) {
      const ch = cw.chapter || cw;
      const content = ch.content || [];
      const verses = [];
      const headings = [];
      for (const item of content) {
        if (item.type === "verse") {
          const text = (item.content || [])
            .map((x) => (typeof x === "string" ? x : x?.text || ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) verses.push({ number: item.number, text });
        } else if (item.type === "heading") {
          headings.push({ before: verses.length + 1, text: (item.content || []).join(" ") });
        }
      }
      bookVerses += verses.length;
      const audio = cw.thisChapterAudioLinks || ch.thisChapterAudioLinks || null;
      chapters.push({ number: ch.number, verses, headings, audio: audio && Object.keys(audio).length ? audio : null });
    }
    totalVerses += bookVerses;
    const niceName = fixName(b.commonName || b.name);
    const book = {
      id: b.id,
      name: niceName,
      title: fixName(b.title || b.commonName || b.name),
      order: b.order,
      testament: OT.has(b.id) ? "OT" : "NT",
      canonGroup: "protocanon",
      numberOfChapters: chapters.length,
      totalNumberOfVerses: bookVerses,
      translation: { id: trId, name: trName, license: "Public Domain", source: "helloao" },
      chapters,
    };
    writeFileSync(resolve(OUT, b.id + ".json"), JSON.stringify(book));
    index.push({ id: b.id, name: book.name, order: book.order, testament: book.testament, canonGroup: "protocanon", numberOfChapters: book.numberOfChapters, totalNumberOfVerses: bookVerses });
  }
  index.sort((a, z) => a.order - z.order);
  writeFileSync(resolve(OUT, "index.json"), JSON.stringify({ translation: trId, translationName: trName, language, license: "Public Domain", source: "https://bible.helloao.org", canonGroup: "protocanon", bookCount: index.length, books: index }, null, 2));
  console.log(`Done: ${trId} (${language}) — ${index.length} books, ${totalVerses} verses.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
