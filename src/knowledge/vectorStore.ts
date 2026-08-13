import { getDb } from "../db/database.js";

function serializeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function deserializeEmbedding(buf: Buffer): number[] {
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function deleteChunksBySourcePrefix(prefix: string): void {
  const db = getDb();
  db.prepare("DELETE FROM knowledge_chunks WHERE source LIKE ?").run(`${prefix}%`);
}

export function insertChunk(source: string, content: string, embedding: number[]): void {
  const db = getDb();
  db.prepare("INSERT INTO knowledge_chunks (source, content, embedding) VALUES (?, ?, ?)").run(
    source,
    content,
    serializeEmbedding(embedding)
  );
}

export function insertChunksBatch(
  items: Array<{ source: string; content: string; embedding: number[] }>
): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO knowledge_chunks (source, content, embedding) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const it of items) stmt.run(it.source, it.content, serializeEmbedding(it.embedding));
  });
  tx();
}

export function searchSimilarChunks(
  queryEmbedding: number[],
  topK: number
): Array<{ source: string; content: string; score: number }> {
  const db = getDb();
  const rows = db
    .prepare("SELECT source, content, embedding FROM knowledge_chunks")
    .all() as Array<{ source: string; content: string; embedding: Buffer }>;

  const scored = rows.map((r) => ({
    source: r.source,
    content: r.content,
    score: cosineSimilarity(queryEmbedding, deserializeEmbedding(r.embedding)),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function listChunksSummary(): Array<{ id: number; source: string; preview: string }> {
  const db = getDb();
  return db
    .prepare("SELECT id, source, substr(content, 1, 120) as preview FROM knowledge_chunks ORDER BY id")
    .all() as Array<{ id: number; source: string; preview: string }>;
}

export function deleteChunkById(id: number): void {
  const db = getDb();
  db.prepare("DELETE FROM knowledge_chunks WHERE id = ?").run(id);
}

export function countChunks(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM knowledge_chunks").get() as { c: number };
  return row.c;
}
