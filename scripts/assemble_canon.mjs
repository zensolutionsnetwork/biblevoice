#!/usr/bin/env node
/**
 * God AI / BibleVoice — Canon assembler (Tier 1a: 66-book protocanon)
 *
 * Source: HelloAO "Free Use Bible API" (https://bible.helloao.org) — Berean Standard
 * Bible (BSB), public domain. Downloads the complete translation once, normalizes it
 * into our schema, and writes one JSON file per book plus an index.
 *
 * Output: data/bible/bsb/<BOOKID>.json  +  data/bible/bsb/index.json
 *
 * Tier 1b (deuterocanon, Enoch, Jubilees, 4 Baruch, Didascalia) and Tier 3 books are
 * NOT in this API — see Canon-Manifest.md. Loaders for those are stubbed separately.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "data/bible/bsb");
const SRC = "https://bible.helloao.org/api/BSB/complete.json";

const OT = new Set(["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO","ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL"]);

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log("Fetching", SRC);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error("Fetch failed: " + res.status);
  const data = await res.json();
  const books = data.books || [];
  console.log("Books:", books.length, "| translation:", data.translation?.name || "BSB");

  const index = [];
  let totalVerses = 0, totalAudio = 0;

  for (const b of books) {
    const chapters = [];
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
          verses.push({ number: item.number, text });
        } else if (item.type === "heading") {
          headings.push({ before: (content.indexOf(item) + 1), text: (item.content || []).join(" ") });
        }
      }
      const audio = cw.thisChapterAudioLinks || ch.thisChapterAudioLinks || null;
      if (audio && Object.keys(audio).length) totalAudio++;
      totalVerses += verses.length;
      chapters.push({ number: ch.number, verses, headings, audio });
    }
    const book = {
      id: b.id,
      name: b.commonName || b.name,
      title: b.title || b.commonName || b.name,
      order: b.order,
      testament: OT.has(b.id) ? "OT" : "NT",
      canonGroup: "protocanon",
      numberOfChapters: b.numberOfChapters,
      totalNumberOfVerses: b.totalNumberOfVerses,
      translation: { id: "BSB", name: "Berean Standard Bible", license: "Public Domain", source: "helloao" },
      chapters,
    };
    writeFileSync(resolve(OUT, b.id + ".json"), JSON.stringify(book));
    index.push({ id: b.id, name: book.name, order: book.order, testament: book.testament, canonGroup: book.canonGroup, numberOfChapters: book.numberOfChapters, totalNumberOfVerses: book.totalNumberOfVerses });
  }

  index.sort((a, z) => a.order - z.order);
  writeFileSync(resolve(OUT, "index.json"), JSON.stringify({ translation: "BSB", license: "Public Domain", source: "https://bible.helloao.org", canonGroup: "protocanon", bookCount: index.length, books: index }, null, 2));

  console.log(`Done. ${index.length} books, ${totalVerses} verses, ${totalAudio} chapters with audio.`);
  console.log("Output:", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
