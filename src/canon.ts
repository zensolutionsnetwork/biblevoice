/**
 * Canon access layer. Loads the assembled BSB protocanon (data/bible/bsb) into
 * memory and provides chapter lookup, keyword search, reference parsing, and a
 * deterministic verse-of-the-day. Tier 1b / Tier 3 books (deuterocanon, Enoch,
 * Jubilees, Meqabyan, ...) attach here later under additional canonGroups.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../data/bible");

export interface Verse { number: number; text: string; }
export interface Chapter { number: number; verses: Verse[]; headings: { before: number; text: string }[]; audio: Record<string, string> | null; }
export interface Book { id: string; name: string; title: string; order: number; testament: "OT" | "NT" | "AP"; canonGroup: string; numberOfChapters: number; totalNumberOfVerses: number; translation: { id: string; name: string; license: string; source: string }; chapters: Chapter[]; }

export type Lang = "en" | "fr" | "es";
export const LANGS: Lang[] = ["en", "fr", "es"];
interface CanonSet { books: Map<string, Book>; index: any; nameToId: Map<string, string> }
const sets = new Map<Lang, CanonSet>();

/**
 * Load every translation directory under data/bible into language-specific canon
 * sets. Each dir's index.json may declare `language` (default "en"); dirs of the
 * same language merge (en = BSB protocanon + KJA deuterocanon). Default language
 * "en" keeps the original single-canon behavior exactly.
 */
function load() {
  for (const dir of readdirSync(DATA_ROOT)) {
    let idx: any;
    try { idx = JSON.parse(readFileSync(resolve(DATA_ROOT, dir, "index.json"), "utf8")); }
    catch { continue; } // not a canon dir
    const lang = (idx.language || "en") as Lang;
    if (!sets.has(lang)) sets.set(lang, { books: new Map(), index: { language: lang, translations: [], bookCount: 0, books: [] }, nameToId: new Map() });
    const set = sets.get(lang)!;
    set.index.translations.push(idx.translation || dir);
    for (const f of readdirSync(resolve(DATA_ROOT, dir))) {
      if (f === "index.json" || !f.endsWith(".json")) continue;
      const b = JSON.parse(readFileSync(resolve(DATA_ROOT, dir, f), "utf8")) as Book;
      set.books.set(b.id, b);
    }
    set.index.books.push(...(idx.books || []));
  }
  for (const [lang, set] of sets) {
    set.index.books.sort((a: any, z: any) => a.order - z.order);
    set.index.bookCount = set.index.books.length;
    for (const b of set.index.books) {
      set.nameToId.set(b.name.toLowerCase(), b.id);
      set.nameToId.set(b.id.toLowerCase(), b.id);
    }
    console.log(`[canon] ${lang}: ${set.books.size} books (${set.index.translations.join(" + ")})`);
  }
  // English aliases (used by reference parsing in chat/search).
  const en = sets.get("en");
  if (en) Object.entries<string>({ psalm: "PSA", psalms: "PSA", songs: "SNG", "song of solomon": "SNG", revelations: "REV", ecclesiasticus: "SIR", "wisdom of solomon": "WIS", "prayer of manasseh": "MAN", "bel and the dragon": "BEL", "greek esther": "ESG" }).forEach(([k, v]) => en.nameToId.set(k, v));
}
load();

/** Normalize an arbitrary lang string to a supported language (default en). */
export function pickLang(raw?: string): Lang {
  const l = String(raw || "").toLowerCase().slice(0, 2);
  return (LANGS as string[]).includes(l) ? (l as Lang) : "en";
}
function setOf(lang: Lang = "en"): CanonSet {
  return sets.get(lang) || sets.get("en")!;
}

export function getIndex(lang: Lang = "en") { return setOf(lang).index; }
export function getBook(id: string, lang: Lang = "en") { return setOf(lang).books.get(id.toUpperCase()); }
export function getChapter(bookId: string, chapter: number, lang: Lang = "en") {
  const b = setOf(lang).books.get(bookId.toUpperCase());
  if (!b) return null;
  const c = b.chapters.find((c) => c.number === chapter);
  if (!c) return null;
  return { book: { id: b.id, name: b.name }, translation: b.translation, ...c };
}

/** Parse refs like "John 3:16", "Genesis 1", "ps 23:1-3". */
export function parseReference(q: string, lang: Lang = "en") {
  const m = q.trim().match(/^([1-3]?\s?[a-zà-ÿ .]+?)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/i);
  if (!m) return null;
  const id = setOf(lang).nameToId.get(m[1].toLowerCase().replace(/\s+/g, " ").trim());
  if (!id) return null;
  return { bookId: id, chapter: +m[2], verseStart: m[3] ? +m[3] : undefined, verseEnd: m[4] ? +m[4] : (m[3] ? +m[3] : undefined) };
}

/** Find a reference anywhere inside a natural sentence, e.g. "take me to Psalm 23". */
export function extractReference(text: string, lang: Lang = "en"): { bookId: string; chapter: number } | null {
  const t = " " + text.toLowerCase().replace(/\s+/g, " ") + " ";
  let best: { bookId: string; chapter: number; nameLen: number } | null = null;
  for (const [name, id] of setOf(lang).nameToId) {
    if (name.length < 3) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = t.match(new RegExp(`(?:^|[^a-z])${esc}\\s+(\\d+)`));
    if (m && (!best || name.length > best.nameLen)) best = { bookId: id, chapter: +m[1], nameLen: name.length };
  }
  return best ? { bookId: best.bookId, chapter: best.chapter } : null;
}

export interface SearchHit { ref: string; bookId: string; book: string; chapter: number; verse: number; text: string; }

/** Simple case-insensitive keyword/topic search across all loaded verses of a language set. */
export function search(query: string, limit = 20, lang: Lang = "en"): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const hits: { hit: SearchHit; score: number }[] = [];
  for (const b of setOf(lang).books.values()) {
    for (const c of b.chapters) {
      for (const v of c.verses) {
        const lt = v.text.toLowerCase();
        let score = 0;
        for (const t of terms) if (lt.includes(t)) score++;
        if (score > 0) hits.push({ score, hit: { ref: `${b.name} ${c.number}:${v.number}`, bookId: b.id, book: b.name, chapter: c.number, verse: v.number, text: v.text } });
      }
    }
  }
  hits.sort((a, z) => z.score - a.score || a.hit.text.length - z.hit.text.length);
  return hits.slice(0, limit).map((h) => h.hit);
}

/** Resolve a reference to verse objects (for chat grounding). */
export function getVerses(bookId: string, chapter: number, start?: number, end?: number, lang: Lang = "en"): SearchHit[] {
  const c = getChapter(bookId, chapter, lang);
  if (!c) return [];
  const b = setOf(lang).books.get(bookId.toUpperCase())!;
  return c.verses
    .filter((v) => (start ? v.number >= start : true) && (end ? v.number <= end : true))
    .map((v) => ({ ref: `${b.name} ${c.number}:${v.number}`, bookId: b.id, book: b.name, chapter: c.number, verse: v.number, text: v.text }));
}

// A small curated rotation for Verse of the Day (deterministic by date).
const VOD = ["John 3:16","Jeremiah 29:11","Philippians 4:6","Psalm 23:1","Proverbs 3:5","Isaiah 41:10","Romans 8:28","Matthew 11:28","Joshua 1:9","Philippians 4:13","Psalm 46:10","2 Corinthians 5:17","1 Peter 5:7","Galatians 5:22","John 14:27"];
export function verseOfTheDay(date = new Date(), lang: Lang = "en"): SearchHit | null {
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  const ref = VOD[day % VOD.length];
  const p = parseReference(ref); // curated refs are English; book IDs are shared across sets
  if (!p) return null;
  return getVerses(p.bookId, p.chapter, p.verseStart, p.verseEnd, lang)[0] || null;
}
