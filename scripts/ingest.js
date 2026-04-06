/**
 * sofitech-mcp-demo/scripts/ingest.js
 *
 * Uploads PDF or text files into Supabase + pgvector.
 * Run this locally before deploying — your docs go into the cloud DB.
 *
 * Usage:
 *   node scripts/ingest.js --client nawshad --file ./my-document.pdf
 *   node scripts/ingest.js --client nawshad --dir ./my-docs-folder
 *   node scripts/ingest.js --client nawshad --file ./contract.pdf --type contract
 *
 * Types: precedent | contract | policy | general (default: general)
 */

import 'dotenv/config';
import fs               from 'fs';
import path             from 'path';
import { createClient } from '@supabase/supabase-js';
import OpenAI           from 'openai';
import pdfParse         from 'pdf-parse';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── CLI args ──────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };

const clientId = getArg('--client');
const docFile  = getArg('--file');
const docDir   = getArg('--dir');
const docType  = getArg('--type') || 'general';

if (!clientId) {
  console.error('\nUsage:\n  node scripts/ingest.js --client nawshad --file ./doc.pdf\n  node scripts/ingest.js --client nawshad --dir ./docs-folder\n');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Split text into overlapping chunks for better search results
function chunkText(text, size = 600, overlap = 100) {
  const words  = text.replace(/\s+/g, ' ').trim().split(' ');
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim().length > 50) chunks.push(chunk);  // skip tiny chunks
    i += size - overlap;
  }
  return chunks;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const buf    = fs.readFileSync(filePath);
    const result = await pdfParse(buf);
    return result.text;
  }
  return fs.readFileSync(filePath, 'utf8');  // .txt, .md etc.
}

async function embed(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000)
  });
  return res.data[0].embedding;
}

// ── Main ingest function ──────────────────────────────────────────────────────

async function ingestFile(filePath, type) {
  const filename = path.basename(filePath);
  console.log(`\n📄 ${filename}`);

  // Extract text
  let text;
  try {
    text = await extractText(filePath);
    console.log(`   Extracted ${text.split(' ').length.toLocaleString()} words`);
  } catch (err) {
    console.error(`   ✗ Failed to extract text: ${err.message}`);
    return;
  }

  const chunks = chunkText(text);
  console.log(`   Split into ${chunks.length} chunks`);

  // Delete old version if re-ingesting
  await supabase.from('documents')
    .delete()
    .eq('client_id', clientId)
    .eq('filename', filename);

  // Embed and insert each chunk
  let done = 0;
  for (const [i, chunk] of chunks.entries()) {
    try {
      const embedding = await embed(chunk);
      await supabase.from('documents').insert({
        client_id:   clientId,
        filename,
        doc_type:    type,
        chunk_index: i,
        content:     chunk,
        embedding
      });
      done++;
      process.stdout.write(`\r   Ingested ${done}/${chunks.length} chunks`);
    } catch (err) {
      console.error(`\n   ✗ Chunk ${i} failed: ${err.message}`);
    }
  }

  console.log(`\n   ✓ Done — ${done}/${chunks.length} chunks stored`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\nsofitech MCP — Document Ingestion`);
console.log(`Client: ${clientId}  |  Type: ${docType}\n`);

if (docFile) {
  if (!fs.existsSync(docFile)) { console.error(`File not found: ${docFile}`); process.exit(1); }
  await ingestFile(docFile, docType);

} else if (docDir) {
  if (!fs.existsSync(docDir)) { console.error(`Directory not found: ${docDir}`); process.exit(1); }

  const files = fs.readdirSync(docDir)
    .filter(f => ['.pdf', '.txt', '.md'].includes(path.extname(f).toLowerCase()))
    .map(f => path.join(docDir, f));

  if (!files.length) { console.error(`No PDF/txt/md files found in ${docDir}`); process.exit(1); }

  console.log(`Found ${files.length} file(s)\n`);
  for (const f of files) await ingestFile(f, docType);

} else {
  console.error('Provide --file or --dir');
  process.exit(1);
}

console.log('\n✓ Ingestion complete. Your documents are now searchable via MCP.\n');
