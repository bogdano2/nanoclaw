/**
 * Vault MCP Stdio Server — hybrid semantic+lexical search over the Obsidian vault.
 *
 * Ports /Users/Shared/vault-search/src/search.ts (Bun + sqlite-vec) to a
 * node-runnable container MCP server. Reads the same SQLite database produced
 * by the host's nightly indexer (run_all_syncs.sh wave 3 → bun run src/index-vault.ts).
 *
 * Algorithm (unchanged from upstream):
 *   - Query embedded via Ollama nomic-embed-text
 *   - Vector side: sqlite-vec MATCH against vec_chunks, top 4×limit
 *   - Lexical side: FTS5 BM25, AND-tokens first, fall back to OR if AND empty
 *   - Reciprocal rank fusion with FTS_WEIGHT=2.0, VEC_WEIGHT=1.0 (FTS wins on
 *     proper-noun queries where nomic-embed-text is noisy)
 *   - Dedup by path: best chunk per file
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';

const log = (msg: string) =>
  process.stderr.write(`[vault-mcp] ${msg}\n`);

const DB_PATH =
  process.env.VAULT_INDEX_DB ||
  '/workspace/extra/vault-search-data/vault-index.db';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

if (!fs.existsSync(DB_PATH)) {
  log(`Vault index not found at ${DB_PATH} — server cannot start`);
  log(`Build it on the host: cd /Users/Shared/vault-search && bun run src/index-vault.ts`);
  process.exit(1);
}

const db = new Database(DB_PATH);
sqliteVec.load(db);
const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
log(`Loaded ${chunkCount} chunks from ${DB_PATH}`);

const RRF_K = 60;
const POOL_MULTIPLIER = 4;
const VEC_WEIGHT = 1.0;
const FTS_WEIGHT = 2.0;

interface Hit {
  path: string;
  heading: string | null;
  content: string;
  chunk_index: number;
  score: number;
  vec_rank: number | null;
  fts_rank: number | null;
}

async function ollamaFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${OLLAMA_HOST}${path}`;
  try {
    return await fetch(url, init);
  } catch (err) {
    if (OLLAMA_HOST.includes('host.docker.internal')) {
      const fallback = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallback, init);
    }
    throw err;
  }
}

async function getQueryEmbedding(text: string): Promise<Float32Array | null> {
  // Mirror the host indexer's 2200-char cap; nomic-embed-text's 2048 token
  // window overflows on entity-dense strings beyond that.
  const safe = text.length > 2200 ? text.slice(0, 2200) : text;
  try {
    const resp = await ollamaFetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: safe,
        truncate: true,
      }),
    });
    if (!resp.ok) {
      log(`embed error ${resp.status}: ${await resp.text()}`);
      return null;
    }
    const data = (await resp.json()) as { embeddings?: number[][] };
    const emb = data.embeddings?.[0];
    return emb ? Float32Array.from(emb) : null;
  } catch (err) {
    log(`embed fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function ftsTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

interface VecRow {
  id: number;
  path: string;
  heading: string | null;
  content: string;
  chunk_index: number;
  distance: number;
}

interface FtsRow {
  id: number;
  path: string;
  heading: string | null;
  content: string;
  chunk_index: number;
  rank: number;
}

const vecStmt = db.prepare(`
  SELECT c.id, c.path, c.heading, c.content, c.chunk_index, v.distance
  FROM vec_chunks v
  JOIN chunks c ON c.id = v.rowid
  WHERE v.embedding MATCH ? AND k = ?
  ORDER BY v.distance
`);

const ftsStmt = db.prepare(`
  SELECT c.id, c.path, c.heading, c.content, c.chunk_index, bm25(fts_chunks) AS rank
  FROM fts_chunks
  JOIN chunks c ON c.id = fts_chunks.rowid
  WHERE fts_chunks MATCH ?
  ORDER BY rank
  LIMIT ?
`);

async function search(query: string, limit: number): Promise<Hit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const pool = limit * POOL_MULTIPLIER;

  // Vector side
  const qvec = await getQueryEmbedding(trimmed);
  // sqlite-vec on better-sqlite3 wants a Node Buffer of float32 LE.
  // Using Buffer.from(qvec.buffer) without offsets is the form sqlite-vec
  // documents for node; an explicit copy guarantees no shared-buffer aliasing.
  let vecBlob: Buffer | null = null;
  if (qvec) {
    vecBlob = Buffer.alloc(qvec.length * 4);
    for (let i = 0; i < qvec.length; i++) {
      vecBlob.writeFloatLE(qvec[i], i * 4);
    }
  }
  const vecRows = vecBlob
    ? (vecStmt.all(vecBlob, pool) as VecRow[])
    : [];

  // Lexical side: AND first, fall back to OR if zero hits and >1 token
  const tokens = ftsTokens(trimmed);
  let ftsRows: FtsRow[] = [];
  if (tokens.length > 0) {
    const quoted = tokens.map((t) => `"${t}"`);
    const andExpr = quoted.join(' AND ');
    ftsRows = ftsStmt.all(andExpr, pool) as FtsRow[];
    if (ftsRows.length === 0 && tokens.length > 1) {
      const orExpr = quoted.join(' OR ');
      ftsRows = ftsStmt.all(orExpr, pool) as FtsRow[];
    }
  }

  // Weighted reciprocal rank fusion
  const fused = new Map<number, Hit>();
  vecRows.forEach((r, i) => {
    fused.set(r.id, {
      path: r.path,
      heading: r.heading,
      content: r.content,
      chunk_index: r.chunk_index,
      score: VEC_WEIGHT / (RRF_K + i + 1),
      vec_rank: i + 1,
      fts_rank: null,
    });
  });
  ftsRows.forEach((r, i) => {
    const existing = fused.get(r.id);
    if (existing) {
      existing.score += FTS_WEIGHT / (RRF_K + i + 1);
      existing.fts_rank = i + 1;
    } else {
      fused.set(r.id, {
        path: r.path,
        heading: r.heading,
        content: r.content,
        chunk_index: r.chunk_index,
        score: FTS_WEIGHT / (RRF_K + i + 1),
        vec_rank: null,
        fts_rank: i + 1,
      });
    }
  });

  // Dedup by path: best-scoring chunk per file
  const sorted = [...fused.values()].sort((a, b) => b.score - a.score);
  const byPath = new Map<string, Hit>();
  for (const h of sorted) {
    if (!byPath.has(h.path)) byPath.set(h.path, h);
    if (byPath.size >= limit) break;
  }
  return [...byPath.values()];
}

const server = new McpServer({ name: 'vault', version: '1.0.0' });

server.tool(
  'vault_search',
  'Hybrid semantic + lexical search over the Obsidian vault (~3k notes synced from Gmail, WhatsApp, Telegram, Slack, Signal, Plaud, Clarify). Combines sqlite-vec cosine similarity (nomic-embed-text) with FTS5 BM25 via reciprocal rank fusion. FTS is weighted higher than vector — names and exact phrases match well, paraphrased concepts also work. Returns one ranked excerpt per file with absolute paths; read the full note via the Read tool when an excerpt looks relevant. Use for "what do I know about X", "find anywhere <person> mentioned <topic>", "last time I discussed Y". For structured entity queries ("status with Acme", "all open deals over $50k") prefer brain_query.py — semantic search may surface tangential matches when no exact answer exists.',
  {
    query: z.string().describe('Natural-language query'),
    limit: z.number().int().min(1).max(32).default(8).describe('Number of results (default 8, max 32)'),
  },
  async ({ query, limit }) => {
    const started = Date.now();
    const hits = await search(query, limit);
    const elapsed = Date.now() - started;
    log(`search "${query.slice(0, 60)}" → ${hits.length} results in ${elapsed}ms`);

    if (hits.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `# vault_search: ${query}\n(0 results, ${elapsed}ms over ${chunkCount} chunks)\n\nNo matches. Try broader phrasing.`,
          },
        ],
      };
    }

    const lines: string[] = [];
    lines.push(`# vault_search: ${query}`);
    lines.push(`(${hits.length} results, ${elapsed}ms over ${chunkCount} chunks)`);
    lines.push('');
    hits.forEach((h, i) => {
      const head = h.heading ? `\n  ## ${h.heading}` : '';
      const snippet = h.content.length > 600 ? h.content.slice(0, 600) + '…' : h.content;
      const ranks = `v=${h.vec_rank ?? '-'} f=${h.fts_rank ?? '-'}`;
      lines.push(`[${i + 1}] (score=${h.score.toFixed(4)} ${ranks}) ${h.path}${head}`);
      lines.push(`  ${snippet.replace(/\n/g, '\n  ')}`);
      lines.push('');
    });
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.tool(
  'vault_search_stats',
  'Show the vault-search index size. Use to sanity-check coverage before running queries.',
  {},
  async () => {
    const totalChunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    const totalFiles = (db.prepare('SELECT COUNT(DISTINCT path) AS n FROM chunks').get() as { n: number }).n;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `# vault-search index\n` +
            `db: ${DB_PATH}\n` +
            `embed model: ${EMBED_MODEL}\n` +
            `files indexed: ${totalFiles}\n` +
            `chunks: ${totalChunks}\n`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('Vault MCP server connected');
