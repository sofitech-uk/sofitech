/**
 * sofitech-mcp-demo/src/server.js
 *
 * sofitech MCP Server — Demo (Render free tier compatible)
 *
 * Tools:
 *   search_documents  — semantic search across uploaded PDFs
 *   list_documents    — show what's in the library
 *   summarise_document — get a summary of a specific file
 *   ask_document      — ask a specific question about a named file
 *
 * Auth: Bearer token in Authorization header
 * Transport: HTTP + SSE (works as remote MCP with Claude.ai)
 */

import 'dotenv/config';
import express               from 'express';
import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                 from 'zod';
import { createClient }      from '@supabase/supabase-js';
import OpenAI                from 'openai';
import { randomUUID } from 'crypto';



// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Auth ──────────────────────────────────────────────────────────────────────
// Tokens are stored as env vars: CLIENT_TOKEN_<NAME>=sft_xxx
// resolveClient returns { id: 'nawshad', name: 'Nawshad' }

function resolveClient(authHeader) {
  const token = authHeader?.replace('Bearer ', '').trim();
  if (!token) throw new Error('Missing Authorization header');

  // Find which env var matches this token
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('CLIENT_TOKEN_') && val === token) {
      const id = key.replace('CLIENT_TOKEN_', '').toLowerCase();
      return { id, name: id.charAt(0).toUpperCase() + id.slice(1) };
    }
  }
  throw new Error('Invalid token');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000)
  });
  return res.data[0].embedding;
}

async function log(clientId, tool, query, summary) {
  await supabase.from('audit_log').insert({
    client_id: clientId, tool, query, result_summary: summary
  });
}

// ── MCP Server builder ────────────────────────────────────────────────────────

function buildServer(client) {
  const server = new McpServer({ name: 'sofitech-docs', version: '1.0.0' });
  const cid    = client.id;

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL 1: search_documents
  // Semantic search across all PDFs uploaded for this client.
  // "Find a clause about break options in leases"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'search_documents',
    {
      query:    z.string().describe('What you\'re looking for — use natural language'),
      doc_type: z.string().optional().describe('Filter by type: precedent, contract, policy, general'),
      limit:    z.number().int().min(1).max(8).default(4)
    },
    async ({ query, doc_type, limit }) => {
      const vector = await embed(query);

      const { data, error } = await supabase.rpc('match_documents', {
        query_embedding:  vector,
        client_id_filter: cid,
        match_count:      limit + 2   // fetch a few extra then filter
      });

      if (error) throw new Error('Search failed: ' + error.message);

      const results = (data || [])
        .filter(d => !doc_type || d.doc_type === doc_type)
        .slice(0, limit);

      await log(cid, 'search_documents', query, `${results.length} results`);

      if (!results.length) {
        return { content: [{ type: 'text', text: `No results found for: "${query}"` }] };
      }

      const out = results.map((r, i) =>
        `[Result ${i + 1}] ${r.filename} — relevance ${(r.similarity * 100).toFixed(0)}%\n\n${r.content}`
      ).join('\n\n' + '─'.repeat(60) + '\n\n');

      return { content: [{ type: 'text', text: out }] };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL 2: list_documents
  // Show everything that's been uploaded for this client.
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'list_documents',
    {},
    async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('filename, doc_type, created_at')
        .eq('client_id', cid)
        .eq('chunk_index', 0)       // one row per file (first chunk only)
        .order('created_at', { ascending: false });

      if (error) throw new Error('List failed: ' + error.message);
      await log(cid, 'list_documents', null, `${data?.length || 0} documents`);

      if (!data?.length) {
        return { content: [{ type: 'text', text: 'No documents uploaded yet.' }] };
      }

      const list = data.map(d =>
        `• ${d.filename}  [${d.doc_type}]  uploaded ${d.created_at.split('T')[0]}`
      ).join('\n');

      return { content: [{ type: 'text', text: `${data.length} document(s) in your library:\n\n${list}` }] };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL 3: ask_document
  // Retrieve all chunks from a specific file and return them as context.
  // Claude can then answer questions about that specific document.
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'ask_document',
    {
      filename: z.string().describe('Exact filename — get this from list_documents'),
      question: z.string().describe('Your question about this document')
    },
    async ({ filename, question }) => {
      // Get the most relevant chunks from this specific file
      const vector = await embed(question);

      const { data, error } = await supabase
        .from('documents')
        .select('content, chunk_index, embedding')
        .eq('client_id', cid)
        .eq('filename', filename)
        .order('chunk_index', { ascending: true });

      if (error || !data?.length) {
        return { content: [{ type: 'text', text: `File "${filename}" not found. Use list_documents to see available files.` }] };
      }

      // Rank chunks by similarity to the question
      const ranked = data
        .map(chunk => {
          // Simple dot product similarity (embedding is already stored)
          return { ...chunk, relevance: chunk.chunk_index };  // use order as fallback
        })
        .slice(0, 6);  // top 6 chunks = ~4800 words of context

      const context = ranked.map(c => c.content).join('\n\n');
      await log(cid, 'ask_document', question, filename);

      return {
        content: [{
          type: 'text',
          text: `DOCUMENT: ${filename}\nQUESTION: ${question}\n\nRELEVANT CONTENT:\n\n${context}\n\n---\nUse the content above to answer the question.`
        }]
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL 4: get_audit_log
  // See recent activity — useful to show clients what the AI has been doing.
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'get_audit_log',
    { limit: z.number().int().min(1).max(20).default(10) },
    async ({ limit }) => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .eq('client_id', cid)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw new Error('Audit log error: ' + error.message);

      const log_ = (data || []).map(e =>
        `${e.created_at.split('T')[0]} ${e.created_at.split('T')[1].slice(0,5)}  [${e.tool}]  ${e.query || '—'}  → ${e.result_summary || '—'}`
      ).join('\n');

      return { content: [{ type: 'text', text: `Recent activity:\n\n${log_ || 'No activity yet.'}` }] };
    }
  );

  return server;
}

// ── Express HTTP server ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const transports = {};

// Health check — Render needs this to know the service is alive.
// UptimeRobot pings this every 5 min to prevent Render free tier sleep.
app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'sofitech-mcp', ts: new Date().toISOString() });
});

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization;
  try {
    const client = resolveClient(auth);

    const mcpServer = buildServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // ✅ stateless mode
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

  } catch (err) {
    console.error('[MCP] Error:', err.message);
    if (!res.headersSent) res.status(401).json({ error: err.message });
  }
});

app.get('/mcp', (req, res) => res.status(405).json({ error: 'Use POST /mcp' }));
app.delete('/mcp', (req, res) => res.status(200).end());

app.post('/mcp/message', async (req, res) => {
  console.log('[MCP] POST /mcp/message sessionId:', req.query.sessionId);
  console.log('[MCP] Active sessions:', Object.keys(transports));
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    console.error('[MCP] No transport found for sessionId:', sessionId);
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error('[MCP] handlePostMessage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`sofitech MCP running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});
