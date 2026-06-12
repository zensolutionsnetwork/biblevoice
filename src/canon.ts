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
export interface Book { id: string; name: string; title: string; order: number; testament: "OT" | "NT" | "AP" | "ET"; canonGroup: string; numberOfChapters: number; totalNumberOfVerses: number; translation: { id: string; name: string; license: string; source: string }; chapters: Chapter[]; }

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
    // Council 2026-06-11 meeting #2 (silent-swallow audit): distinguish "no index.json"
    // (not a canon dir — skip is correct) from "index.json EXISTS but won't parse" (a
    // corrupt canon dir — silently skipping would drop a whole translation without a
    // word). Data ships in the image, so a parse failure means a bad build: fail the
    // boot loudly and let the platform keep the previous deploy serving. A Scripture
    // site that silently loses a canon is worse than one that refuses a bad build.
    try { idx = JSON.parse(readFileSync(resolve(DATA_ROOT, dir, "index.json"), "utf8")); }
    catch (e: any) {
      if (e?.code === "ENOENT") continue; // not a canon dir
      console.error(`[canon] CORRUPT index.json in data/bible/${dir} — refusing to boot without it:`, e?.message || e);
      throw e;
    }
    const lang = (idx.language || "en") as Lang;
    if (!sets.has(lang)) sets.set(lang, { books: new Map(), index: { language: lang, translations: [], bookCount: 0, books: [] }, nameToId: new Map() });
    const set = sets.get(lang)!;
    set.index.translations.push(idx.translation || dir);
    for (const f of readdirSync(resolve(DATA_ROOT, dir))) {
      if (f === "index.json" || !f.endsWith(".json")) continue;
      // A corrupt book file already failed the boot (unhandled throw) — keep the hard
      // stop, but name the file so the bad build is diagnosable from the log.
      let b: Book;
      try { b = JSON.parse(readFileSync(resolve(DATA_ROOT, dir, f), "utf8")) as Book; }
      catch (e: any) {
        console.error(`[canon] CORRUPT book file data/bible/${dir}/${f} — refusing to boot:`, e?.message || e);
        throw e;
      }
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
const missingLangWarned = new Set<string>();
function setOf(lang: Lang = "en"): CanonSet {
  const s = sets.get(lang);
  if (s) return s;
  // Early-return sweep 2026-06-12: serving English for a missing language set is a deliberate
  // graceful fallback, but it must be visible — a whole language silently disappearing from
  // the site is the same failure class as the silent canon loss caught at meeting #2.
  if (lang !== "en" && !missingLangWarned.has(lang)) {
    missingLangWarned.add(lang);
    console.warn(`[canon] no canon set loaded for lang="${lang}" — falling back to English (warned once)`);
  }
  return sets.get("en")!;
}

/**
 * Lookup failure reason codes v1 (council meeting #3 homework, adopted 2026-06-12).
 * STABLE CONTRACT: Arke's edge probes wire against these exact strings — never rename
 * or remove a code without a version bump announced to the council.
 *  - ref_parse_fail:      the reference itself is malformed (bad chapter number, unparseable ref)
 *  - book_not_in_corpus:  the book name/id parsed but is not in this language's loaded canon
 *  - range_invalid:       book exists but the chapter is out of range, or verseEnd < verseStart
 *  - verse_not_found:     book + chapter valid but the requested verse range matched nothing
 */
export const LOOKUP_FAIL_REASONS = ["verse_not_found", "ref_parse_fail", "book_not_in_corpus", "range_invalid"] as const;
export type LookupFailReason = (typeof LOOKUP_FAIL_REASONS)[number];
export type LookupFail = { ok: false; reason: LookupFailReason };

/** Structured chapter lookup: same data as getChapter, with a machine-readable failure reason. */
export function resolveChapter(bookId: string, chapter: number, lang: Lang = "en"):
  | { ok: true; chapter: NonNullable<ReturnType<typeof getChapter>> }
  | LookupFail {
  if (!Number.isInteger(chapter) || chapter < 1) return { ok: false, reason: "ref_parse_fail" };
  const b = setOf(lang).books.get(String(bookId || "").toUpperCase());
  if (!b) return { ok: false, reason: "book_not_in_corpus" };
  const c = getChapter(b.id, chapter, lang);
  if (!c) return { ok: false, reason: "range_invalid" };
  return { ok: true, chapter: c };
}

/** Structured verse-range lookup (chat grounding + probes): reasons instead of a bare []. */
export function resolveVerses(bookId: string, chapter: number, start?: number, end?: number, lang: Lang = "en"):
  | { ok: true; verses: SearchHit[] }
  | LookupFail {
  if (start !== undefined && end !== undefined && end < start) return { ok: false, reason: "range_invalid" };
  const ch = resolveChapter(bookId, chapter, lang);
  if (!ch.ok) return ch;
  const verses = getVerses(bookId, chapter, start, end, lang);
  if (!verses.length) return { ok: false, reason: "verse_not_found" };
  return { ok: true, verses };
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
  const name = m[1].toLowerCase().replace(/\s+/g, " ").trim();
  const id = setOf(lang).nameToId.get(name);
  // Reference-SHAPED input whose book name isn't in the corpus: callers degrade to keyword
  // search, so name the miss (book_not_in_corpus class — the 66-vs-82 coverage-gap signal).
  if (!id) { console.warn(`[canon] parseReference: "${name}" looks like a book ref but is not in the ${lang} corpus (book_not_in_corpus)`); return null; }
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
  if (!p) { console.error(`[canon] verseOfTheDay: curated ref "${ref}" failed to parse — VOD list has a data bug`); return null; }
  const v = getVerses(p.bookId, p.chapter, p.verseStart, p.verseEnd, lang)[0] || null;
  if (!v) console.error(`[canon] verseOfTheDay: curated ref "${ref}" resolved to no verses (lang=${lang})`);
  return v;
}
