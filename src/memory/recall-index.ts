import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ObjectStore, Sha } from "../git-store/types.ts";
import {
  ABANDONED_REF_PREFIX,
  AGENT_REF_PREFIX,
  ARCHIVE_REF_PREFIX,
  MEMORY_REF,
  SESSION_REF_PREFIX,
  SessionStore,
} from "../session/session-store.ts";
import { MemoryStore } from "./memory-store.ts";
import type { RecallHit, RecallIndexStats, RecallQuery, RecallSourceKind } from "./types.ts";

export interface RecallIndexOptions {
  store: ObjectStore;
  sessions: SessionStore;
  memory?: MemoryStore;
  /** SQLite DB path (defaults to `":memory:"`; can be pointed at `.git/harness-cache/recall.db` and wiped anytime). */
  dbPath?: string;
}

function buildSafeFtsQuery(raw: string, mode: "AND" | "OR"): string | null {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replace(/"/g, "")}"`);
  return mode === "AND" ? quoted.join(" ") : quoted.join(" OR ");
}

/**
 * Disposable SQLite FTS5 cold-recall index (powered by Node 24's built-in `node:sqlite`).
 *
 * Indexes ALL commits reachable from `refs/harness/sessions/*` and `refs/harness/agents/*`
 * — including `parent2` raw history hidden behind compaction anchors and squash-merged
 * subagents — plus persistent files on `refs/harness/memory`.
 *
 * Can be deleted and deterministically rebuilt from Git objects at any time.
 */
export class RecallIndex {
  private readonly store: ObjectStore;
  private readonly sessions: SessionStore;
  private readonly memory: MemoryStore;
  private readonly dbPath: string;
  private db: DatabaseSync;
  private lastRefFingerprint: string | null = null;

  constructor(options: RecallIndexOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.memory = options.memory ?? new MemoryStore(options.store, MEMORY_REF);
    this.dbPath = options.dbPath ?? ":memory:";
    if (this.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private collectIndexedRefs() {
    return [
      ...this.store.listRefs(SESSION_REF_PREFIX),
      ...this.store.listRefs(AGENT_REF_PREFIX),
      ...this.store.listRefs(ARCHIVE_REF_PREFIX),
      ...this.store.listRefs(ABANDONED_REF_PREFIX),
    ];
  }

  private computeRefFingerprint(): string {
    const entries = this.collectIndexedRefs().map((e) => `${e.ref}:${e.sha}`);
    const memHead = this.store.readRef(this.memory.ref);
    if (memHead) entries.push(`${this.memory.ref}:${memHead}`);
    entries.sort();
    return entries.join("\n");
  }

  /**
   * Content-addressed freshness check: compares current Git ref SHAs against the
   * last indexed snapshot and rebuilds deterministically only when refs changed.
   * Returns `true` if a rebuild was performed, `false` if already fresh.
   */
  ensureFresh(): boolean {
    const fp = this.computeRefFingerprint();
    if (this.lastRefFingerprint === fp) return false;
    this.rebuild();
    return true;
  }

  /** Deterministically wipe and rebuild the entire FTS5 index from Git refs. */
  rebuild(): RecallIndexStats {
    this.db.exec("DELETE FROM docs_fts; DELETE FROM docs_meta;");

    const insertMeta = this.db.prepare(
      `INSERT INTO docs_meta (source, ref, sha, path, title, timestamp_sec)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)`,
    );

    let indexedCommits = 0;
    let indexedMemoryFiles = 0;

    // 1. BFS across ALL parents across active, archived, and abandoned harness refs.
    const seenCommits = new Set<Sha>();
    const refEntries = this.collectIndexedRefs();

    for (const entry of refEntries) {
      const queue: Sha[] = [entry.sha];
      while (queue.length > 0) {
        const sha = queue.shift()!;
        if (seenCommits.has(sha)) continue;
        seenCommits.add(sha);

        let rec;
        try {
          rec = this.sessions.readCommit(sha);
        } catch {
          continue;
        }
        for (const p of rec.parents) {
          if (!seenCommits.has(p)) queue.push(p);
        }

        const bodyParts: string[] = [];
        if (rec.summary) bodyParts.push(rec.summary);
        for (const ev of rec.events) {
          if (ev.type === "message") bodyParts.push(ev.message.content);
          else if (ev.type === "tool_call") bodyParts.push(`${ev.name}(${ev.arguments})`);
          else if (ev.type === "tool_result") bodyParts.push(`${ev.name}: ${ev.output}`);
          else if (ev.type === "thinking") bodyParts.push(ev.content);
          else if (ev.type === "note") bodyParts.push(ev.content);
        }
        const body = bodyParts.join("\n").trim();
        if (!body && !rec.title) continue;

        const info = insertMeta.run(
          "session",
          entry.ref,
          rec.sha,
          rec.kind === "compact" ? "summary.md" : "turn/events.jsonl",
          rec.title,
          rec.timestampSec,
        );
        insertFts.run(info.lastInsertRowid, rec.title, body);
        indexedCommits++;
      }
    }

    // 2. Index current persistent memory files from `refs/harness/memory`.
    const memHead = this.store.readRef(this.memory.ref);
    if (memHead) {
      const memCommit = this.store.readCommit(memHead);
      for (const filePath of this.memory.list()) {
        const content = this.memory.read(filePath);
        if (content === null) continue;
        const info = insertMeta.run(
          "memory",
          this.memory.ref,
          memHead,
          filePath,
          filePath,
          memCommit.timestampSec,
        );
        insertFts.run(info.lastInsertRowid, filePath, content);
        indexedMemoryFiles++;
      }
    }

    this.lastRefFingerprint = this.computeRefFingerprint();

    return {
      indexedCommits,
      indexedMemoryFiles,
      totalDocuments: indexedCommits + indexedMemoryFiles,
    };
  }

  /** BM25-ranked full-text search across archived sessions and persistent memory. */
  search(input: RecallQuery): RecallHit[] {
    const limit = input.limit ?? 5;
    const andQuery = buildSafeFtsQuery(input.query, "AND");
    if (!andQuery) return [];

    let rows = this.runQuery(andQuery, input.source, limit);
    if (rows.length === 0) {
      const orQuery = buildSafeFtsQuery(input.query, "OR");
      if (orQuery && orQuery !== andQuery) {
        rows = this.runQuery(orQuery, input.source, limit);
      }
    }
    return rows;
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        sha TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp_sec INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        title,
        body
      );
    `);
  }

  private runQuery(
    ftsExpr: string,
    source: RecallSourceKind | undefined,
    limit: number,
  ): RecallHit[] {
    const sql = source
      ? `SELECT m.source, m.ref, m.sha, m.path, m.title, m.timestamp_sec,
                snippet(docs_fts, 1, '[', ']', '...', 24) AS snippet,
                bm25(docs_fts) AS rank
         FROM docs_fts
         JOIN docs_meta m ON m.id = docs_fts.rowid
         WHERE docs_fts MATCH ? AND m.source = ?
         ORDER BY rank ASC
         LIMIT ?`
      : `SELECT m.source, m.ref, m.sha, m.path, m.title, m.timestamp_sec,
                snippet(docs_fts, 1, '[', ']', '...', 24) AS snippet,
                bm25(docs_fts) AS rank
         FROM docs_fts
         JOIN docs_meta m ON m.id = docs_fts.rowid
         WHERE docs_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`;

    const stmt = this.db.prepare(sql);
    const rawRows = (source ? stmt.all(ftsExpr, source, limit) : stmt.all(ftsExpr, limit)) as Array<{
      source: RecallSourceKind;
      ref: string;
      sha: string;
      path: string;
      title: string;
      timestamp_sec: number;
      snippet: string;
      rank: number;
    }>;

    return rawRows.map((r) => ({
      source: r.source,
      ref: r.ref,
      sha: r.sha,
      path: r.path,
      title: r.title,
      snippet: r.snippet,
      // Convert SQLite bm25 (lower/more-negative is better) into a positive relevance score.
      score: -Number(r.rank),
      timestampSec: Number(r.timestamp_sec),
    }));
  }
}
