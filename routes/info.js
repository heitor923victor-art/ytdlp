/**
 * Info Route — GET video metadata via yt-dlp
 * POST /api/info  { url: string }
 */

const express = require('express');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const { validateURL } = require('../utils/validator');
const { formatBytes } = require('../utils/cleanup');

const router = express.Router();

// Strict rate limit for info requests (avoid YouTube bans)
const infoLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute window
  max: 15,                  // 15 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas buscas. Aguarde um momento.' },
});

router.post('/', infoLimiter, async (req, res) => {
  const { url } = req.body;

  const validation = validateURL(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  try {
    const info = await getVideoInfo(url.trim());
    res.json(info);
  } catch (err) {
    console.error('[info] Error:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao buscar informações do vídeo.' });
  }
});

/**
 * Spawn yt-dlp --dump-json and parse the output
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      url,
    ];

    const proc = spawn('yt-dlp', args, { timeout: 0 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // 30 second timeout
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timeout: vídeo demorou demais para responder.'));
    }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        if (stderr.includes('Video unavailable') || stderr.includes('is not available')) {
          return reject(new Error('Vídeo indisponível ou privado.'));
        }
        if (stderr.includes('Sign in')) {
          return reject(new Error('Este vídeo requer login.'));
        }
        return reject(new Error('Não foi possível buscar o vídeo. Verifique o link.'));
      }

      try {
        // yt-dlp may output multiple JSON objects for playlists; take the first
        const firstJson = stdout.trim().split('\n')[0];
        const data = JSON.parse(firstJson);
        resolve(parseVideoData(data));
      } catch {
        reject(new Error('Erro ao processar dados do vídeo.'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp não encontrado. Instale-o conforme o README.'));
      } else {
        reject(new Error('Erro interno ao processar o vídeo.'));
      }
    });
  });
}

/**
 * Extract only what the frontend needs from the raw yt-dlp JSON
 */
function parseVideoData(data) {
  const formats = data.formats || [];

  // Collect unique video heights (resolutions) — MP4 streams only
  const resolutionSet = new Set();
  formats.forEach((f) => {
    if (f.vcodec && f.vcodec !== 'none' && f.height && f.height >= 144) {
      resolutionSet.add(f.height);
    }
  });

  // Sort descending (best first)
  const availableResolutions = [...resolutionSet].sort((a, b) => b - a);

  // Best thumbnail
  const thumbnail = chooseBestThumbnail(data.thumbnails, data.thumbnail);

  // Estimated filesize of the best format
  const bestFormat = formats.find((f) => f.format_id === data.format_id) || formats[formats.length - 1];
  const estimatedSize = bestFormat?.filesize
    ? formatBytes(bestFormat.filesize)
    : estimateSize(data.duration);

  return {
    id:                   data.id,
    title:                data.title,
    thumbnail,
    duration:             formatDuration(data.duration),
    durationSeconds:      data.duration,
    channel:              data.uploader || data.channel || data.creator || 'Desconhecido',
    channelUrl:           data.uploader_url || data.channel_url,
    viewCount:            data.view_count ? formatViews(data.view_count) : null,
    uploadDate:           formatDate(data.upload_date),
    description:          data.description ? data.description.slice(0, 250) : '',
    availableResolutions,
    estimatedSize,
    isLive:               !!data.is_live,
    webpage_url:          data.webpage_url,
  };
}

function chooseBestThumbnail(thumbnails, fallback) {
  if (!thumbnails || !thumbnails.length) return fallback;
  // Prefer maxresdefault or hqdefault style thumbnails
  const sorted = [...thumbnails].sort((a, b) => {
    const wa = a.width || 0;
    const wb = b.width || 0;
    return wb - wa;
  });
  // Cap at something reasonable for web display
  const best = sorted.find((t) => t.width && t.width <= 1280) || sorted[0];
  return best?.url || fallback;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViews(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  return `${d}/${m}/${y}`;
}

function estimateSize(durationSeconds) {
  if (!durationSeconds) return 'N/A';
  // Rough estimate: 720p ≈ 1.5 Mbps
  const bytes = durationSeconds * 1.5 * 1024 * 1024 / 8;
  return `~${formatBytes(bytes)}`;
}

module.exports = router;
