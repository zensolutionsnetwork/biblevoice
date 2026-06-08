#!/usr/bin/env node
/**
 * God AI / BibleVoice — Ethiopian-canon assembler (Tier 1c).
 * Sources (verified public domain):
 * - 1 Enoch: R.H. Charles 1917, en.wikisource.org (108 chapter subpages of wikitext;
 *   parallel Ethiopic/Greek wikitables -> Ethiopic column; transposed verse numbers
 *   (e.g. ch 90) handled by collect-then-sort with bounded-gap validation).
 * - Jubilees: R.H. Charles 1913 (Clarendon Press), NNC etext at pseudepigrapha.com/jubilees/.
 * NOT included (no verified-legal English text): Meqabyan I-III, Josippon, Sinodos,
 * Ethiopic Clement, Book of the Cock; 4 Baruch (Harris 1889 OCR cleanup — future).
 * NOTE: the "EtheopianBible" section of pseudepigrapha.com is ripped from a pirated
 * commercial PDF (OceanofPDF watermark) — NEVER source from it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data/bible/eth");
const UA = { headers: { "User-Agent": "BibleVoice-canon-assembler/1.0 (public-domain Scripture; contact info@zen-ai.net)" } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanText(s) {
  return s
    .replace(/⌈⌈|⌉⌉|⌈|⌉|⌊⌊|⌋⌋|⌊|⌋|〈|〉|‡|†/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<ref[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;|&gt;/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&([A-Za-z])(circ|uml|grave|acute|tilde);/g, (_, l, a) => (l + ({circ:"\u0302",uml:"\u0308",grave:"\u0300",acute:"\u0301",tilde:"\u0303"})[a]).normalize("NFC"))
    .replace(/\s+/g, " ")
    .trim();
}
function splitVerses(text, where) {
  const verses = [];
  let starts = [];
  const seen = new Set();
  const re = /(^|[\s>—–\-(\["'’”])([0-9]{1,3})[ab]?\.\s+(?=[A-Z‘"“(⌈\[])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[2]);
    // First occurrence of each plausible verse number (Charles transposes some, e.g. Enoch 90).
    if (n >= 1 && n <= 150 && !seen.has(n)) { seen.add(n); starts.push({ n, at: m.index + m[1].length, after: re.lastIndex }); }
  }
  // Drop leading stray numbers until the chain starts at 1.
  while (starts.length && starts[0].n !== 1) starts.shift();
  if (!starts.length) return [{ number: 1, text: cleanText(text) }].filter((v) => v.text);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].after;
    const to = i + 1 < starts.length ? starts[i + 1].at : text.length;
    const t = cleanText(text.slice(from, to));
    if (t) verses.push({ number: starts[i].n, text: t });
  }
  verses.sort((a, z) => a.number - z.number);
  // Validate: bounded gaps between consecutive verse numbers (catches mis-captures).
  for (let i = 1; i < verses.length; i++) {
    const gap = verses[i].number - verses[i - 1].number;
    if (gap < 1 || gap > 5) throw new Error(`${where}: suspicious verse gap ${verses[i - 1].number}→${verses[i].number}`);
  }

  return verses;
}
async function fetchText(url) {
  for (let a = 1; a <= 5; a++) {
    try { const r = await fetch(url, UA); if (r.ok) return await r.text(); if (r.status === 404) throw new Error("404 " + url); }
    catch (e) { if (a === 5) throw e; }
    await sleep(1500 * a);
  }
  throw new Error("unreachable " + url);
}
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function assembleEnoch() {
  const nums = Array.from({ length: 108 }, (_, i) => i + 1);
  const chapters = await pool(nums, 3, async (c) => {
    const page = `The_Book_of_Enoch_(Charles)/Chapter_${String(c).padStart(2, "0")}`;
    const api = `https://en.wikisource.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2`;
    const j = JSON.parse(await fetchText(api));
    if (j.error) throw new Error(`Enoch ch ${c}: ${j.error.info}`);
    let w = j.parse.wikitext;
    w = w.replace(/\{\{header[\s\S]*?\n\}\}/i, "");
    // Parallel Ethiopic/Greek wikitables: keep only the Ethiopic (first) column.
    // Cells can span multiple lines; rows start with a single "|", columns split on "||".
    w = w.replace(/\{\|[\s\S]*?\|\}/g, (tbl) => {
      const body = tbl.split("\n")
        .filter((l) => !/^\{\||^\|\}|^\|-|^!/.test(l.trim()))
        .join("\n");
      const rows = ("\n" + body).split(/\n\|(?!\|)/).map((r) => r.trim()).filter(Boolean);
      return " " + rows.map((r) => r.split("||")[0].trim()).join(" ") + " ";
    });
    const headings = [];
    w = w.replace(/^=+\s*(.*?)\s*=+\s*$/gm, (_, h) => { const t = cleanText(h); if (t && !/^Section/i.test(t)) headings.push(t); return " "; });
    w = w.replace(/^\s*CHAPTER\s+[IVXLC]+\.?\s*$/gim, " ");
    w = w.replace(/^[:*#]+\s*/gm, "");
    const verses = splitVerses(w, `Enoch ${c}`);
    return { number: c, verses, headings: headings.length ? [{ before: 1, text: headings[headings.length - 1] }] : [], audio: null };
  });
  chapters.sort((a, z) => a.number - z.number);
  const total = chapters.reduce((s, ch) => s + ch.verses.length, 0);
  console.log(`1 Enoch: ${chapters.length} chapters, ${total} verses.`);
  return { id: "1EN", name: "1 Enoch", title: "The Book of Enoch", order: 81, chapters, totalNumberOfVerses: total,
    translation: { id: "CHARLES", name: "R.H. Charles (1917)", license: "Public Domain", source: "wikisource" } };
}
async function assembleJubilees() {
  const nums = Array.from({ length: 50 }, (_, i) => i + 1);
  const chapters = await pool(nums, 3, async (c) => {
    const h = await fetchText(`https://www.pseudepigrapha.com/jubilees/${c}.htm`);
    const em = h.match(/<blockquote>\s*<em>([\s\S]*?)<\/em>\s*<\/blockquote>/i);
    const heading = em ? cleanText(em[1]) : "";
    const afterEm = em ? h.slice(em.index + em[0].length) : h;
    const olAt = afterEm.search(/<ol>/i);
    const verses = [];
    // Optional opening blockquote BEFORE the first <ol> = verse 1.
    const pre = olAt >= 0 ? afterEm.slice(0, olAt) : afterEm;
    const b1 = pre.match(/<blockquote>([\s\S]*?)<\/blockquote>/i);
    if (b1) { const t = cleanText(b1[1]); if (t) verses.push({ number: 1, text: t }); }
    // All <li> items across every <ol> block, in order.
    const body = olAt >= 0 ? afterEm.slice(olAt) : "";
    for (const olm of body.matchAll(/<ol>([\s\S]*?)<\/ol>/gi)) {
      for (const it of olm[1].split(/<li[^>]*>/i).slice(1)) {
        const t = cleanText(it);
        if (t) verses.push({ number: verses.length + 1, text: t });
      }
    }
    if (verses.length < 5) console.warn(`  Jubilees ${c}: only ${verses.length} verse(s) — check`);
    return { number: c, verses, headings: heading ? [{ before: 1, text: heading }] : [], audio: null };
  });
  chapters.sort((a, z) => a.number - z.number);
  const total = chapters.reduce((s, ch) => s + ch.verses.length, 0);
  console.log(`Jubilees: ${chapters.length} chapters, ${total} verses.`);
  return { id: "JUB", name: "Jubilees", title: "The Book of Jubilees", order: 82, chapters, totalNumberOfVerses: total,
    translation: { id: "CHARLES", name: "R.H. Charles (1913)", license: "Public Domain", source: "pseudepigrapha.com (NNC etext)" } };
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const books = [];
  console.log("Assembling 1 Enoch (Wikisource)...");
  books.push(await assembleEnoch());
  console.log("Assembling Jubilees (Charles 1913)...");
  books.push(await assembleJubilees());
  const index = [];
  for (const b of books) {
    const book = { ...b, testament: "ET", canonGroup: "ethiopian", numberOfChapters: b.chapters.length };
    writeFileSync(resolve(OUT, b.id + ".json"), JSON.stringify(book));
    index.push({ id: b.id, name: b.name, order: b.order, testament: "ET", canonGroup: "ethiopian", numberOfChapters: book.numberOfChapters, totalNumberOfVerses: b.totalNumberOfVerses });
  }
  writeFileSync(resolve(OUT, "index.json"), JSON.stringify({ translation: "CHARLES", translationName: "R.H. Charles (public domain)", language: "en", license: "Public Domain", source: "wikisource + pseudepigrapha.com (NNC)", canonGroup: "ethiopian", bookCount: index.length, books: index }, null, 2));
  console.log(`Done. ${index.length} Ethiopian-canon books written.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
