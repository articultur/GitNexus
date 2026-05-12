import { getRuntimeCapabilities, getRuntimeFingerprint } from '../core/platform/capabilities.js';
import { resolveEmbeddingConfig } from '../core/embeddings/config.js';
import { isHttpMode } from '../core/embeddings/http-client.js';
import { checkFTSHealth } from '../core/search/bm25-index.js';

export const doctorCommand = async () => {
  const fingerprint = getRuntimeFingerprint();
  const capabilities = getRuntimeCapabilities();
  const embeddingConfig = resolveEmbeddingConfig();

  console.log('GitNexus Doctor\n');
  console.log('Runtime');
  console.log(`  OS:        ${fingerprint.platform}/${fingerprint.arch}`);
  console.log(`  Node:      ${fingerprint.node}`);
  console.log(`  GitNexus:  ${fingerprint.gitnexus}`);
  console.log(`  LadybugDB: ${fingerprint.ladybugdb ?? 'unknown'}`);
  console.log(`  ONNX:      ${fingerprint.onnxruntime ?? 'unknown'}`);
  console.log('');
  console.log('Capabilities');
  console.log(`  Graph store:     ${capabilities.graph}`);
  console.log(`  Full-text search:${capabilities.fts.padStart(10)}`);
  console.log(`  VECTOR index:    ${capabilities.vector}`);
  console.log(`  Semantic mode:   ${capabilities.semanticMode}`);
  console.log(`  Exact scan limit:${String(capabilities.exactScanLimit).padStart(9)} chunks`);
  if (capabilities.reason) console.log(`  Note:            ${capabilities.reason}`);

  // Probe actual FTS index health (not just platform capability)
  try {
    const ftsHealth = await checkFTSHealth();
    if (!ftsHealth.available) {
      console.log('');
      console.log('FTS Index Health');
      console.log('  ⚠  No FTS indexes found — keyword search is unavailable.');
      console.log('     Run: gitnexus analyze --force');
    } else if (!ftsHealth.complete) {
      console.log('');
      console.log('FTS Index Health');
      console.log(`  ⚠  Partial: ${ftsHealth.missingIndexes.length} index(es) missing`);
      for (const idx of ftsHealth.missingIndexes) {
        console.log(`     - ${idx}`);
      }
      console.log('     Run: gitnexus analyze --force');
    } else {
      console.log(`  FTS indexes:     all ${ftsHealth.indexStatus.length} OK`);
    }
  } catch {
    // Non-fatal: doctor should still work without a database
  }

  console.log('');
  console.log('Embeddings');
  console.log(`  Backend:   ${isHttpMode() ? 'http' : 'local'}`);
  console.log(`  Device:    ${embeddingConfig.device}`);
  console.log(`  Threads:   ${embeddingConfig.threads}`);
  console.log(`  Batch:     ${embeddingConfig.batchSize} nodes`);
  console.log(`  Sub-batch: ${embeddingConfig.subBatchSize} chunks`);
};
