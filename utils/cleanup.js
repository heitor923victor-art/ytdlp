/**
 * Cleanup Utility — Removes stale downloads from the temp folder
 * Run periodically or manually via `node utils/cleanup.js`
 */

const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Remove files older than MAX_AGE_MS from the downloads directory
 * @returns {{ removed: number, errors: number }}
 */
function cleanupOldFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    return { removed: 0, errors: 0 };
  }

  const files = fs.readdirSync(DOWNLOADS_DIR);
  const now = Date.now();
  let removed = 0;
  let errors = 0;

  for (const file of files) {
    if (file === '.gitkeep') continue;
    const filePath = path.join(DOWNLOADS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const age = now - stat.mtimeMs;
      if (age > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (err) {
      errors++;
    }
  }

  return { removed, errors };
}

/**
 * Delete a specific file safely
 * @param {string} filePath
 */
function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Silently ignore errors
  }
}

/**
 * Format bytes to a human-readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'N/A';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Allow running directly for manual cleanup
if (require.main === module) {
  console.log('🧹 Running cleanup...');
  const result = cleanupOldFiles();
  console.log(`✅ Removed ${result.removed} file(s), ${result.errors} error(s).`);
}

module.exports = { cleanupOldFiles, deleteFile, formatBytes };
