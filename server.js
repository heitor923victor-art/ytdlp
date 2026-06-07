/**
 * YTGrabPro — Express Backend
 * Serves the frontend and provides the download API
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { cleanupOldFiles } = require('./utils/cleanup');

const infoRouter = require('./routes/info');
const downloadRouter = require('./routes/download');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Ensure downloads directory exists ────────────────────────────────────────
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',  // In production, restrict to your domain
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '1kb' })); // Tiny limit — we only accept URLs

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Global rate limiter ──────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
  skip: (req) => req.path === '/api/health', // Don't rate-limit health checks
});
app.use('/api/', globalLimiter);

// ─── Serve static frontend ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/info', infoRouter);
app.use('/api/download', downloadRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  const { execSync } = require('child_process');
  let ytdlpVersion = null;
  let ffmpegVersion = null;

  try {
    ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { ytdlpVersion = null; }

  try {
    const ffOut = execSync('ffmpeg -version 2>&1', { encoding: 'utf8', timeout: 3000 });
    ffmpegVersion = ffOut.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0];
  } catch { ffmpegVersion = null; }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    dependencies: {
      ytdlp:  ytdlpVersion  ? { ok: true, version: ytdlpVersion }  : { ok: false },
      ffmpeg: ffmpegVersion ? { ok: true, version: ffmpegVersion } : { ok: false },
    },
  });
});

// ─── Catch-all: serve frontend ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ─── Periodic cleanup (every 10 minutes) ─────────────────────────────────────
setInterval(() => {
  const { removed } = cleanupOldFiles();
  if (removed > 0) console.log(`[cleanup] Removed ${removed} stale file(s).`);
}, 10 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════╗');
  console.log('  ║   🎬  YTGrabPro  — Backend     ║');
  console.log(`  ║   http://localhost:${PORT}        ║`);
  console.log('  ╚════════════════════════════════╝');
  console.log('');
});

module.exports = app;
