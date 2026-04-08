/**
 * sofitech-mcp-demo/src/server.js
 */

import 'dotenv/config';
import express               from 'express';
import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                 from 'zod';
import { createClient }      from '@supabase/supabase-js';
import OpenAI                from 'openai';
import { randomUUID }        from 'crypto';

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Auth ──────────────────────────────────────────────────────────────────────

function resolveClient(authHeader) {
  const token = authHeader?.replace('Bearer ', '').trim();
  if (!token) throw new Error('Missing Authorization header');
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

// ── Condition scoring helper ──────────────────────────────────────────────────

const CONDITION_SCORE = { excellent: 4, good: 3, fair: 2, poor: 1 };

function overallCondition(rooms) {
  if (!rooms.length) return 'fair';
  const avg = rooms.reduce((s, r) => s + (CONDITION_SCORE[r.condition] ?? 2), 0) / rooms.length;
  return avg >= 3.5 ? 'excellent' : avg >= 2.5 ? 'good' : avg >= 1.5 ? 'fair' : 'poor';
}

// ── MCP Server builder ────────────────────────────────────────────────────────

function buildServer(client) {
  const server = new McpServer({ name: 'sofitech', version: '1.1.0' });
  const cid = client.id;

  // ==================== ORIGINAL TOOLS ====================

  // TOOL 1: search_documents
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
        match_count:      limit + 2
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

  // TOOL 2: list_documents
  server.tool(
    'list_documents',
    {},
    async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('filename, doc_type, created_at')
        .eq('client_id', cid)
        .eq('chunk_index', 0)
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

  // TOOL 3: ask_document
  server.tool(
    'ask_document',
    {
      filename: z.string().describe('Exact filename — get this from list_documents'),
      question: z.string().describe('Your question about this document')
    },
    async ({ filename, question }) => {
      const { data, error } = await supabase
        .from('documents')
        .select('content, chunk_index')
        .eq('client_id', cid)
        .eq('filename', filename)
        .order('chunk_index', { ascending: true });

      if (error || !data?.length) {
        return { content: [{ type: 'text', text: `File "${filename}" not found. Use list_documents to see available files.` }] };
      }

      const context = data.slice(0, 6).map(c => c.content).join('\n\n');
      await log(cid, 'ask_document', question, filename);

      return {
        content: [{
          type: 'text',
          text: `DOCUMENT: ${filename}\nQUESTION: ${question}\n\nRELEVANT CONTENT:\n\n${context}\n\n---\nUse the content above to answer the question.`
        }]
      };
    }
  );

  // TOOL 4: get_audit_log
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

      const lines = (data || []).map(e =>
        `${e.created_at.split('T')[0]} ${e.created_at.split('T')[1].slice(0, 5)}  [${e.tool}]  ${e.query || '—'}  → ${e.result_summary || '—'}`
      ).join('\n');

      return { content: [{ type: 'text', text: `Recent activity:\n\n${lines || 'No activity yet.'}` }] };
    }
  );

  // ==================== NEW LISTING TOOLS ====================

  // TOOL 5: search_listings
  server.tool(
    'search_listings',
    {
      query: z.string().describe('What are you looking for? e.g. "3 bed houses in Battersea under 600k"'),
      limit: z.number().int().min(1).max(10).default(5)
    },
    async ({ query, limit }) => {
      const vector = await embed(query);

      const { data, error } = await supabase.rpc('match_listings', {
        query_embedding: vector,
        client_id_filter: cid,
        match_count: limit
      });

      if (error) throw new Error('Search failed: ' + error.message);

      await log(cid, 'search_listings', query, `${data?.length || 0} results`);

      if (!data || data.length === 0) {
        return { content: [{ type: 'text', text: `No listings found for: "${query}"` }] };
      }

      const results = data.map((l, i) => 
        `[${i+1}] ${l.property_type} • ${l.bedrooms} bed • £${l.price.toLocaleString()} • ${l.area}\n` +
        `${l.description?.substring(0, 280)}...\n`
      ).join('\n\n');

      return { 
        content: [{ 
          type: 'text', 
          text: `Found ${data.length} matching listings:\n\n${results}` 
        }] 
      };
    }
  );

  // TOOL 6: get_listing_details
  server.tool(
    'get_listing_details',
    {
      listing_id: z.string().describe('Listing ID, e.g. L001')
    },
    async ({ listing_id }) => {
      const { data, error } = await supabase
        .from('listings')
        .select('*')
        .eq('client_id', cid)
        .eq('listing_id', listing_id)
        .single();

      if (error || !data) {
        return { content: [{ type: 'text', text: `Listing ${listing_id} not found.` }] };
      }

      await log(cid, 'get_listing_details', listing_id, data.area);

      return {
        content: [{
          type: 'text',
          text: `Listing ${listing_id}\n\n` +
                `Type: ${data.property_type}\n` +
                `Price: £${data.price.toLocaleString()} (${data.price_type})\n` +
                `Bedrooms: ${data.bedrooms} | Bathrooms: ${data.bathrooms}\n` +
                `Area: ${data.area} (${data.postcode})\n\n` +
                `Description:\n${data.description}`
        }]
      };
    }
  );

  // TOOL 7: add_listing
server.tool(
  'add_listing',
  {
    address:        z.string().describe('Full address of the property'),
    postcode:       z.string().describe('Postcode e.g. L7 0ED'),
    area:           z.string().optional().describe('Area or neighbourhood e.g. Liverpool City Centre'),
    property_type:  z.string().optional().describe('e.g. flat, terraced, semi-detached, detached'),
    bedrooms:       z.number().int().optional(),
    bathrooms:      z.number().int().optional(),
    price:          z.number().optional().describe('Price in GBP'),
    price_type:     z.enum(['sale', 'rent']).optional(),
    description:    z.string().optional(),
    epc_rating:     z.string().optional().describe('e.g. A, B, C, D, E, F, G'),
    tenure:         z.string().optional().describe('e.g. freehold, leasehold'),
    floor_area_sqm: z.number().optional(),
    status:         z.string().optional().describe('e.g. available, under offer, sold, let'),
  },
  async (fields) => {
    const listing_id = 'L' + randomUUID().slice(0, 6).toUpperCase();

    // Build embedding text from key fields
    const embeddingText = [
      fields.address,
      fields.postcode,
      fields.area,
      fields.property_type,
      fields.bedrooms ? `${fields.bedrooms} bedrooms` : null,
      fields.description,
    ].filter(Boolean).join(', ');

    const embedding = await embed(embeddingText);

    const { error } = await supabase.from('listings').insert({
      client_id:      cid,
      listing_id,
      listing_date:   new Date().toISOString().split('T')[0],
      status:         fields.status ?? 'available',
      embedding,
      ...fields,
    });

    if (error) throw new Error('Failed to add listing: ' + error.message);
    await log(cid, 'add_listing', fields.address, listing_id);

    return {
      content: [{
        type: 'text',
        text: `Listing added successfully. ID: ${listing_id}\nAddress: ${fields.address}, ${fields.postcode}`
      }]
    };
  }
);

// TOOL 10: filter_listings
server.registerTool(
  'filter_listings',
  {
    description: 'Filter listings by price, type, bedrooms or status',
    inputSchema: {
      price_type:  z.enum(['sale', 'rent']).optional(),
      min_price:   z.number().optional().describe('Minimum price in GBP'),
      max_price:   z.number().optional().describe('Maximum price in GBP'),
      bedrooms:    z.number().int().optional(),
      status:      z.string().optional().describe('e.g. available, under offer, sold, let'),
      limit:       z.number().int().min(1).max(50).default(20)
    }
  },
  async ({ price_type, min_price, max_price, bedrooms, status, limit }) => {
    let query = supabase
      .from('listings')
      .select('listing_id, address, postcode, property_type, bedrooms, price, price_type, status, area')
      .eq('client_id', cid)
      .order('price', { ascending: true })
      .limit(limit);

    if (price_type)      query = query.eq('price_type', price_type);
    if (min_price)       query = query.gte('price', min_price);
    if (max_price)       query = query.lte('price', max_price);
    if (bedrooms)        query = query.eq('bedrooms', bedrooms);
    if (status)          query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error('Filter failed: ' + error.message);

    if (!data?.length) {
      return { content: [{ type: 'text', text: 'No listings match those criteria.' }] };
    }

    const list = data.map(l =>
      `• [${l.listing_id}] ${l.address}, ${l.postcode} — ${l.property_type}, ${l.bedrooms || '?'} bed — £${l.price?.toLocaleString()}/${price_type === 'rent' ? 'mo' : ''} [${l.status}]`
    ).join('\n');

    return { content: [{ type: 'text', text: `${data.length} listing(s):\n\n${list}` }] };
  }
);

// TOOL 9: list_listings
server.registerTool(
  'list_listings',
  {
    description: 'List all property listings',
    inputSchema: {
      status: z.string().optional().describe('Filter by status e.g. available, under offer, sold, let'),
      limit:  z.number().int().min(1).max(50).default(20)
    }
  },
  async ({ status, limit }) => {
    let query = supabase
      .from('listings')
      .select('listing_id, address, postcode, property_type, bedrooms, price, price_type, status, area')
      .eq('client_id', cid)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) throw new Error('Failed to list listings: ' + error.message);
    await log(cid, 'list_listings', status || 'all', `${data?.length || 0} listings`);

    if (!data?.length) {
      return { content: [{ type: 'text', text: 'No listings found.' }] };
    }

    const list = data.map(l =>
      `• [${l.listing_id}] ${l.address}, ${l.postcode} — ${l.property_type || 'Property'}, ${l.bedrooms || '?'} bed — £${l.price?.toLocaleString() || '?'} (${l.price_type || '?'}) [${l.status}]`
    ).join('\n');

    return { content: [{ type: 'text', text: `${data.length} listing(s):\n\n${list}` }] };
  }
);
  return server;
}

// ── Express HTTP server ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const transports = {};

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'sofitech-mcp', ts: new Date().toISOString() });
});

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization;
  try {
    const client    = resolveClient(auth);
    const mcpServer = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Error:', err.message);
    if (!res.headersSent) res.status(401).json({ error: err.message });
  }
});

app.get('/mcp',    (_, res) => res.status(405).json({ error: 'Use POST /mcp' }));
app.delete('/mcp', (_, res) => res.status(200).end());

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`sofitech MCP running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});
