/**
 * ingest_listing.js
 * Improved version - ingests estate agent property listings into Supabase
 * 
 * Features:
 * - Proper embedding generation
 * - Progress tracking
 * - Better error handling
 * - Skips duplicates using upsert
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fs from 'fs';
import csv from 'csv-parser';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

const CLIENT_ID = 'nawshad';   // ← Change this for each client

// ── Embed text using OpenAI ───────────────────────────────────────────────
async function embed(text) {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error('Embedding failed:', err.message);
    throw err;
  }
}

// ── Main ingestion function ───────────────────────────────────────────────
async function ingestListings(csvPath) {
  console.log(`\n🚀 Starting ingestion of listings from: ${csvPath}`);
  console.log(`Client ID: ${CLIENT_ID}\n`);

  const listings = [];
  let processed = 0;
  let skipped = 0;

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => {
      listings.push({
        client_id: CLIENT_ID,
        listing_id: row.listing_id?.trim(),
        property_type: row.property_type?.trim(),
        price: parseFloat(row.price) || null,
        price_type: row.price_type?.trim(),
        bedrooms: parseInt(row.bedrooms) || null,
        bathrooms: parseInt(row.bathrooms) || null,
        postcode: row.postcode?.trim(),
        area: row.area?.trim(),
        address: row.address?.trim() || null,
        description: row.description?.trim(),
        epc_rating: row.epc_rating?.trim() || null,
        tenure: row.tenure?.trim() || null,
        floor_area_sqm: row.floor_area_sqm ? parseFloat(row.floor_area_sqm) : null,
        listing_date: row.listing_date || null,
        status: row.status?.trim() || 'Available',
        raw_data: row
      });
    })
    .on('end', async () => {
      console.log(`✅ Parsed ${listings.length} listings. Starting upload...\n`);

      for (const listing of listings) {
        try {
          if (!listing.listing_id) {
            console.warn(`⚠️  Skipping row with no listing_id`);
            skipped++;
            continue;
          }

          // Create searchable text for embedding
          const fullText = `
            ${listing.property_type || ''} in ${listing.area || ''} (${listing.postcode || ''})
            ${listing.bedrooms || ''} bed, ${listing.bathrooms || ''} bath.
            Price: £${listing.price ? listing.price.toLocaleString() : ''} ${listing.price_type || ''}
            ${listing.description || ''}
          `.trim();

          const embedding = await embed(fullText);

          const { error } = await supabase
            .from('listings')
            .upsert({
              ...listing,
              embedding: embedding,
              updated_at: new Date().toISOString()
            }, { 
              onConflict: 'listing_id',
              ignoreDuplicates: false 
            });

          if (error) {
            console.error(`❌ Failed ${listing.listing_id}:`, error.message);
          } else {
            processed++;
            console.log(`✅ Ingested: ${listing.listing_id} | ${listing.area} | £${listing.price?.toLocaleString() || 'N/A'}`);
          }
        } catch (err) {
          console.error(`💥 Error processing ${listing.listing_id || 'unknown'}:`, err.message);
          skipped++;
        }
      }

      console.log(`\n🎉 Ingestion complete!`);
      console.log(`   Processed: ${processed}`);
      console.log(`   Skipped:   ${skipped}`);
      console.log(`   Total:     ${processed + skipped}`);
    })
    .on('error', (err) => {
      console.error('❌ CSV parsing error:', err.message);
    });
}

// ── Run the script ───────────────────────────────────────────────────────
const csvFile = process.argv[2] || 'past_listings.csv';

if (!fs.existsSync(csvFile)) {
  console.error(`❌ File not found: ${csvFile}`);
  console.error('Usage: node scripts/ingest_listing.js [path-to-csv]');
  process.exit(1);
}

ingestListings(csvFile);