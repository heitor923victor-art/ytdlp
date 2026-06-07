/**
 * Download Route — yt-dlp integration with SSE progress streaming
 *
 *  POST /api/download/start       → { sessionId }
 *  GET  /api/download/progress/:id → SSE stream
 *  GET  /api/download/file/:id    → serve the finished file
 *  DELETE /api/download/cancel/:id → kill the process
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { validateURL, sanitizeFilename } = require('../utils/validator');
const { deleteFile } = require('../utils/cleanup');

const router = express.Router();
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

// ─── Session store ────────────────────────────────────────────────────────────
// Map<sessionId, Session>
// Session: { process, status, filepath, filename, client, bufferedEvents }
const sessions = new Map();

const MAX_CONCURRENT = 5; // Max simultaneous downloads

// ─── Rate limit for downloads ─────────────────────────────────────────────────
const downloadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 minutes
  max: 10,
  message: { error: 'Muitos downloads. Aguarde alguns minutos.' },
});

// ─── POST /api/download/start ─────────────────────────────────────────────────
router.post('/start', downloadLimiter, (req, res) => {
  const { url, format, quality, resolution } = req.body;

  const validation = validateURL(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  // Check valid format
  if (!['mp3', 'mp4'].includes(format)) {
    return res.status(400).json({ error: 'Formato inválido. Use mp3 ou mp4.' });
  }

  // Validate quality/resolution values (whitelist)
  if (format === 'mp3') {
    const validQualities = ['64', '128', '192', '320'];
    if (!validQualities.includes(String(quality))) {
      return res.status(400).json({ error: 'Qualidade de áudio inválida.' });
    }
  } else {
    const validResolutions = ['144', '240', '360', '480', '720', '1080', '1440', '2160'];
    if (!validResolutions.includes(String(resolution))) {
      return res.status(400).json({ error: 'Resolução inválida.' });
    }
  }

  // Check concurrent limit
  const active = [...sessions.values()].filter((s) => s.status === 'downloading').length;
  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Servidor ocupado. Tente novamente em instantes.' });
  }

  const sessionId = uuidv4();

  // Initialize session before spawning so progress events can be buffered
  sessions.set(sessionId, {
    process: null,
    status: 'starting',
    filepath: null,
    filename: null,
    client: null,
    bufferedEvents: [],
    startedAt: Date.now(),
  });

  // Kick off download (async)
  setImmediate(() => startDownload(sessionId, url.trim(), format, quality, resolution));

  // Cleanup session after 30 min regardless
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s) {
      if (s.filepath) deleteFile(s.filepath);
      sessions.delete(sessionId);
    }
  }, 30 * 60 * 1000);

  res.json({ sessionId });
});

// ─── GET /api/download/progress/:sessionId — SSE ─────────────────────────────
router.get('/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Sessão não encontrada.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const session = sessions.get(sessionId);
  session.client = res;

  // Flush any buffered events that arrived before the client connected
  if (session.bufferedEvents.length > 0) {
    session.bufferedEvents.forEach((msg) => res.write(msg));
    session.bufferedEvents = [];
  }

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const s = sessions.get(sessionId);
    if (s) s.client = null;
  });
});

// ─── GET /api/download/file/:sessionId — serve finished file ──────────────────
router.get('/file/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session || session.status !== 'complete' || !session.filepath) {
    return res.status(404).json({ error: 'Arquivo não disponível.' });
  }

  if (!fs.existsSync(session.filepath)) {
    return res.status(404).json({ error: 'Arquivo expirado.' });
  }

  const encodedName = encodeURIComponent(session.filename);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(session.filepath);
  stream.pipe(res);

  stream.on('end', () => {
    // Clean up after delivery
    setTimeout(() => {
      deleteFile(session.filepath);
      sessions.delete(sessionId);
    }, 5000);
  });

  stream.on('error', () => {
    res.status(500).json({ error: 'Erro ao enviar arquivo.' });
  });
});

// ─── DELETE /api/download/cancel/:sessionId ───────────────────────────────────
router.delete('/cancel/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada.' });
  }

  // Kill the yt-dlp process
  if (session.process && !session.process.killed) {
    session.process.kill('SIGTERM');
  }

  // Delete partial file if it exists
  if (session.filepath) deleteFile(session.filepath);

  sessions.delete(sessionId);
  sendSSE(sessionId, 'cancelled', { message: 'Download cancelado.' });

  res.json({ success: true });
});

// ─── Core download logic ──────────────────────────────────────────────────────
function startDownload(sessionId, url, format, quality, resolution) {
  const args = buildYtdlpArgs(url, format, quality, resolution, sessionId);

  let proc;
  try {
const YTDLP_PATH = '/opt/render/project/src/.venv/bin/yt-dlp';

proc = spawn(YTDLP_PATH, args);
  } catch (err) {
    updateSession(sessionId, { status: 'error' });
    sendSSE(sessionId, 'error', { message: 'yt-dlp não encontrado. Verifique a instalação.' });
    return;
  }

  updateSession(sessionId, { process: proc, status: 'downloading' });

  let stdoutBuffer = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      handleYtdlpLine(sessionId, line.trim());
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    // Log stderr for debugging but don't expose raw output
    console.error(`[download:${sessionId.slice(0, 8)}] stderr:`, text.slice(0, 200));
  });

  proc.on('close', (code) => {
    if (code === 0) {
      // Find the output file
      const outputFile = findOutputFile(sessionId);
      if (outputFile) {
        const stats = fs.statSync(outputFile);
        updateSession(sessionId, {
          status: 'complete',
          filepath: outputFile,
          filename: path.basename(outputFile),
        });
        sendSSE(sessionId, 'complete', {
          downloadUrl: `/api/download/file/${sessionId}`,
          filename: path.basename(outputFile),
          filesize: stats.size,
        });
      } else {
        updateSession(sessionId, { status: 'error' });
        sendSSE(sessionId, 'error', { message: 'Arquivo de saída não encontrado.' });
      }
    } else if (code !== null) {
      // code === null means killed (cancelled)
      updateSession(sessionId, { status: 'error' });
      sendSSE(sessionId, 'error', { message: 'Erro no download. Verifique o link e tente novamente.' });
    }
  });

  proc.on('error', (err) => {
    updateSession(sessionId, { status: 'error' });
    if (err.code === 'ENOENT') {
      sendSSE(sessionId, 'error', { message: 'yt-dlp não instalado. Siga o README.' });
    } else {
      sendSSE(sessionId, 'error', { message: 'Erro ao iniciar download.' });
    }
  });
}

/**
 * Build the yt-dlp argument array based on format and quality
 * Uses whitelisted values only — no shell injection possible
 */
function buildYtdlpArgs(url, format, quality, resolution, sessionId) {
  const outputTemplate = path.join(DOWNLOADS_DIR, `${sessionId}.%(ext)s`);

  const commonArgs = [
    '--no-playlist',
    '--newline',           // One progress line per stdout line
    '--no-warnings',
    '--ffmpeg-location', detectFFmpegPath(),
    '-o', outputTemplate,
  ];

  if (format === 'mp3') {
    // VBR quality: 0 = best (320kbps), 9 = worst (64kbps)
    const qualityMap = { '320': '0', '192': '2', '128': '5', '64': '8' };
    const audioQuality = qualityMap[String(quality)] || '5';

    return [
      ...commonArgs,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', audioQuality,
      '--embed-thumbnail',
      '--add-metadata',
      url,
    ];
  } else {
    // MP4 — pick best video+audio up to requested resolution
    const h = parseInt(resolution, 10);
const formatSelector =
  `bv*[height<=${h}][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/` +
  `b[ext=mp4][vcodec^=avc1]/` +
  `b[ext=mp4]`;

return [
  ...commonArgs,
  '-f', formatSelector,
  '--merge-output-format', 'mp4',
  url,
];
  }
}

/**
 * Parse a single line of yt-dlp output and emit SSE events
 */
function handleYtdlpLine(sessionId, line) {
  if (!line) return;

  // Progress line: [download]  23.5% of 50.23MiB at 2.00MiB/s ETA 00:09
  const progressMatch = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+(\S+)/i
  );
  if (progressMatch) {
    sendSSE(sessionId, 'progress', {
      percent:   parseFloat(progressMatch[1]),
      totalSize: progressMatch[2].trim(),
      speed:     progressMatch[3].trim(),
      eta:       progressMatch[4],
    });
    return;
  }

  // Merging/converting phase
  if (line.includes('[Merger]') || line.includes('Merging')) {
    sendSSE(sessionId, 'status', { message: 'Unindo streams de vídeo e áudio…', percent: 95 });
    return;
  }

  // FFmpeg conversion phase
  if (line.includes('[ExtractAudio]') || line.includes('Destination:')) {
    sendSSE(sessionId, 'status', { message: 'Convertendo áudio com FFmpeg…', percent: 90 });
    return;
  }

  // Already downloaded
  if (line.includes('has already been downloaded')) {
    sendSSE(sessionId, 'status', { message: 'Arquivo já baixado.', percent: 100 });
    return;
  }
}

/**
 * Find the output file that yt-dlp created for this session
 */
function findOutputFile(sessionId) {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(sessionId));
  if (!files.length) return null;
  // Prefer non-partial files
  const complete = files.filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
  return complete.length ? path.join(DOWNLOADS_DIR, complete[0]) : null;
}

/**
 * Detect ffmpeg path cross-platform
 */
function detectFFmpegPath() {
  const { execSync } = require('child_process');
  try {
    const which = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return execSync(which, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return 'ffmpeg'; // Fall back to PATH
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function updateSession(sessionId, updates) {
  const s = sessions.get(sessionId);
  if (s) sessions.set(sessionId, { ...s, ...updates });
}

function sendSSE(sessionId, event, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  if (session.client) {
    try {
      session.client.write(message);
    } catch {
      session.client = null;
    }
  } else {
    // Buffer until client connects (handles race condition)
    session.bufferedEvents.push(message);
    // Limit buffer size
    if (session.bufferedEvents.length > 100) {
      session.bufferedEvents = session.bufferedEvents.slice(-50);
    }
  }
}

module.exports = router;
