#!/usr/bin/env node
/**
 * God AI / BibleVoice — Canon assembler (Tier 1b: KJV Apocrypha / deuterocanon)
 *
 * Source: HelloAO "Free Use Bible API" — translation `eng_kja` (King James Version
 * + Apocrypha, public domain). Extracts ONLY the 14 deuterocanonical books and
 * normalizes them into our schema, after the 66 protocanon books (orders 67..80).
 *
 * Output: data/bible/kja/<BOOKID>.json + data/bible/kja/index.json
 * (canon.ts merges every data/bible/<dir> at boot; testament "AP".)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "data/bible/kja");
const SRC = "https://bible.helloao.org/api/eng_kja/complete.json";

// Traditional 1611 KJV Apocrypha order, placed after Revelation (order 66).
const APOCRYPHA = ["1ES", "2ES", "TOB", "JDT", "ESG", "WIS", "SIR", "BAR", "S3Y", "SUS", "BEL", "MAN", "1MA", "2MA"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log("Fetching", SRC);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error("Fetch failed: " + res.status);
  const data = await res.json();
  const byId = new Map((data.books || []).map((b) => [b.id, b]));
  console.log("Source books:", byId.size, "| translation:", data.translation?.name || "eng_kja");

  const index = [];
  let totalVerses = 0;

  for (let i = 0; i < APOCRYPHA.length; i++) {
    const id = APOCRYPHA[i];
    const b = byId.get(id);
    if (!b) { console.warn("MISSING in source:", id); continue; }
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
          // "before" = the next verse number, so the reader inserts it correctly.
          headings.push({ before: verses.length + 1, text: (item.content || []).join(" ") });
        }
      }
      bookVerses += verses.length;
      chapters.push({ number: ch.number, verses, headings, audio: null });
    }
    totalVerses += bookVerses;
    const book = {
      id,
      name: b.commonName || b.name,
      title: b.title || b.commonName || b.name,
      order: 67 + i,
      testament: "AP",
      canonGroup: "deuterocanon",
      numberOfChapters: chapters.length,
      totalNumberOfVerses: bookVerses,
      translation: { id: "KJA", name: "King James Version + Apocrypha", license: "Public Domain", source: "helloao" },
      chapters,
    };
    writeFileSync(resolve(OUT, id + ".json"), JSON.stringify(book));
    index.push({ id, name: book.name, order: book.order, testament: "AP", canonGroup: "deuterocanon", numberOfChapters: book.numberOfChapters, totalNumberOfVerses: bookVerses });
    console.log(`  ${id} — ${book.name}: ${chapters.length} ch, ${bookVerses} verses`);
  }

  writeFileSync(resolve(OUT, "index.json"), JSON.stringify({ translation: "KJA", license: "Public Domain", source: "https://bible.helloao.org", canonGroup: "deuterocanon", bookCount: index.length, books: index }, null, 2));
  console.log(`Done. ${index.length} books, ${totalVerses} verses.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
