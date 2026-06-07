/**
 * YTGrabPro — Frontend Application
 * ─────────────────────────────────
 * Handles: URL input, clipboard paste, drag&drop, video info fetch,
 *          format/quality selection, SSE download progress, history, toasts
 */

'use strict';

/* ─── Config ──────────────────────────────────────────────────────────────── */
const API_BASE     = 'http://localhost:3001/api';
const HISTORY_KEY  = 'ytgrabpro_history';
const MAX_HISTORY  = 20;
const POLL_HEALTH  = 30_000; // ms between health checks

/* ─── State ───────────────────────────────────────────────────────────────── */
const state = {
  currentVideo:    null,   // Video info from /api/info
  selectedFormat:  'mp3',
  selectedQuality: '320',  // kbps for MP3
  selectedRes:     null,   // height for MP4 (auto-set to best)
  sessionId:       null,   // Active download session
  sseSource:       null,   // EventSource instance
  isLoading:       false,
  isDownloading:   false,
};

/* ─── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const dom = {
  urlInput:       $('urlInput'),
  searchBtn:      $('searchBtn'),
  searchBtnText:  $('searchBtnText'),
  searchLoader:   $('searchLoader'),
  pasteBtn:       $('pasteBtn'),
  searchBox:      $('searchBox'),
  dropOverlay:    $('dropOverlay'),

  resultSection:  $('resultSection'),
  videoThumb:     $('videoThumb'),
  videoDuration:  $('videoDuration'),
  videoChannel:   $('videoChannel'),
  videoTitle:     $('videoTitle'),
  videoMeta:      $('videoMeta'),

  tabMp3:         $('tabMp3'),
  tabMp4:         $('tabMp4'),
  mp3Options:     $('mp3Options'),
  mp4Options:     $('mp4Options'),
  audioQualityGrid: $('audioQualityGrid'),
  resolutionGrid:  $('resolutionGrid'),

  downloadBtn:    $('downloadBtn'),
  downloadBtnText: $('downloadBtnText'),

  progressCard:   $('progressCard'),
  progressLabel:  $('progressLabel'),
  progressStats:  $('progressStats'),
  progressBar:    $('progressBar'),
  progressPercent: $('progressPercent'),
  cancelBtn:      $('cancelBtn'),

  historySection: $('historySection'),
  historyList:    $('historyList'),
  clearHistoryBtn: $('clearHistoryBtn'),

  serverBadge:    $('serverBadge'),
  serverDot:      $('serverDot'),
  serverLabel:    $('serverLabel'),

  toastContainer: $('toastContainer'),
};

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
function init() {
  bindEvents();
  checkServerHealth();
  setInterval(checkServerHealth, POLL_HEALTH);
  renderHistory();
  initClipboardDetection();
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVENT BINDING
   ═══════════════════════════════════════════════════════════════════════════ */
function bindEvents() {
  // Search
  dom.searchBtn.addEventListener('click', handleSearch);
  dom.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });
  dom.urlInput.addEventListener('input', onInputChange);
  dom.urlInput.addEventListener('paste', onPaste);

  // Paste button
  dom.pasteBtn.addEventListener('click', pasteFromClipboard);

  // Format tabs
  dom.tabMp3.addEventListener('click', () => selectFormat('mp3'));
  dom.tabMp4.addEventListener('click', () => selectFormat('mp4'));

  // Audio quality cards
  dom.audioQualityGrid.addEventListener('click', onQualityClick);

  // Download
  dom.downloadBtn.addEventListener('click', handleDownload);

  // Cancel
  dom.cancelBtn.addEventListener('click', handleCancel);

  // History clear
  dom.clearHistoryBtn.addEventListener('click', clearHistory);

  // Drag & drop on the page
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  // Visibility change — reconnect SSE if needed
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.sessionId && !state.sseSource) {
      connectSSE(state.sessionId);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SERVER HEALTH
   ═══════════════════════════════════════════════════════════════════════════ */
async function checkServerHealth() {
  setServerStatus('checking', 'Verificando…');
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/health`, {}, 5000);
    if (!resp.ok) throw new Error('not ok');
    const data = await resp.json();

    const ytdlpOk  = data.dependencies?.ytdlp?.ok;
    const ffmpegOk = data.dependencies?.ffmpeg?.ok;

    if (ytdlpOk && ffmpegOk) {
      const ver = data.dependencies.ytdlp.version || '';
      setServerStatus('online', `Online · yt-dlp ${ver}`);
    } else {
      const missing = [!ytdlpOk && 'yt-dlp', !ffmpegOk && 'ffmpeg'].filter(Boolean).join(', ');
      setServerStatus('offline', `Falta: ${missing}`);
    }
  } catch {
    setServerStatus('offline', 'Servidor offline');
  }
}

function setServerStatus(status, label) {
  dom.serverBadge.className = `server-badge is-${status}`;
  dom.serverLabel.textContent = label;
}

/* ═══════════════════════════════════════════════════════════════════════════
   URL INPUT HANDLING
   ═══════════════════════════════════════════════════════════════════════════ */
function onInputChange() {
  const url = dom.urlInput.value.trim();
  dom.searchBtn.disabled = !url;
}

function onPaste(e) {
  // Let the paste happen, then auto-search if it looks like a YT URL
  setTimeout(() => {
    const url = dom.urlInput.value.trim();
    if (isYouTubeURL(url)) handleSearch();
  }, 50);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      dom.urlInput.value = text.trim();
      dom.urlInput.dispatchEvent(new Event('input'));
      if (isYouTubeURL(text.trim())) {
        showToast('info', 'URL colada', 'Buscando vídeo…');
        handleSearch();
      } else {
        showToast('warning', 'Área de transferência', 'Isso não parece um link do YouTube.');
      }
    }
  } catch {
    showToast('error', 'Sem permissão', 'Não foi possível acessar a área de transferência.');
  }
}

/* ─── Auto-clipboard detection on focus ─────────────────────────────────── */
function initClipboardDetection() {
  window.addEventListener('focus', async () => {
    if (dom.urlInput.value.trim()) return; // Don't overwrite user input
    try {
      const text = await navigator.clipboard.readText();
      if (text && isYouTubeURL(text.trim())) {
        dom.urlInput.value = text.trim();
        dom.urlInput.style.setProperty('box-shadow', '0 0 0 2px rgba(255,204,0,0.4)');
        setTimeout(() => dom.urlInput.style.removeProperty('box-shadow'), 1500);
        showToast('info', 'Link detectado', 'Clique em Buscar ou pressione Enter.');
      }
    } catch {
      // Clipboard permission not granted — silent
    }
  }, { once: false });
}

/* ═══════════════════════════════════════════════════════════════════════════
   DRAG & DROP
   ═══════════════════════════════════════════════════════════════════════════ */
function onDragOver(e) {
  e.preventDefault();
  const types = e.dataTransfer?.types || [];
  if (types.includes('text/uri-list') || types.includes('text/plain')) {
    dom.dropOverlay.classList.add('visible');
    dom.searchBox.classList.add('is-drag-over');
  }
}

function onDragLeave(e) {
  if (!document.body.contains(e.relatedTarget)) {
    dom.dropOverlay.classList.remove('visible');
    dom.searchBox.classList.remove('is-drag-over');
  }
}

async function onDrop(e) {
  e.preventDefault();
  dom.dropOverlay.classList.remove('visible');
  dom.searchBox.classList.remove('is-drag-over');

  const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
  if (url.trim()) {
    dom.urlInput.value = url.trim();
    if (isYouTubeURL(url.trim())) {
      showToast('info', 'Link recebido', 'Buscando…');
      handleSearch();
    } else {
      showToast('warning', 'Link inválido', 'Apenas links do YouTube são suportados.');
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIDEO INFO FETCH
   ═══════════════════════════════════════════════════════════════════════════ */
async function handleSearch() {
  const url = dom.urlInput.value.trim();
  if (!url) return;
  if (state.isLoading) return;

  if (!isYouTubeURL(url)) {
    showToast('error', 'URL inválida', 'Cole um link do YouTube válido.');
    dom.urlInput.focus();
    return;
  }

  setSearchLoading(true);

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }, 35_000);

    const data = await resp.json();

    if (!resp.ok) {
      showToast('error', 'Erro', data.error || 'Não foi possível buscar o vídeo.');
      return;
    }

    state.currentVideo = data;
    renderVideoInfo(data);
    showToast('success', 'Vídeo encontrado', truncate(data.title, 50));
  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('error', 'Timeout', 'O servidor demorou muito. Tente novamente.');
    } else {
      showToast('error', 'Sem conexão', 'Verifique se o servidor está rodando.');
    }
  } finally {
    setSearchLoading(false);
  }
}

function setSearchLoading(loading) {
  state.isLoading = loading;
  dom.searchBtnText.hidden = loading;
  dom.searchLoader.hidden = !loading;
  dom.searchBtn.disabled = loading;
  dom.urlInput.disabled = loading;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDER VIDEO INFO
   ═══════════════════════════════════════════════════════════════════════════ */
function renderVideoInfo(video) {
  // Thumbnail
  dom.videoThumb.src = video.thumbnail || '';
  dom.videoThumb.alt = video.title || '';
  dom.videoDuration.textContent = video.duration || '';

  // Info
  dom.videoChannel.textContent = video.channel || '';
  dom.videoTitle.textContent = video.title || '';

  // Meta row
  const metaParts = [];
  if (video.viewCount) metaParts.push(metaItem('👁', video.viewCount + ' views'));
  if (video.uploadDate) metaParts.push(metaItem('📅', video.uploadDate));
  if (video.estimatedSize) metaParts.push(metaItem('💾', video.estimatedSize));
  dom.videoMeta.innerHTML = metaParts.join('');

  // Resolutions
  renderResolutions(video.availableResolutions || []);

  // Show the section
  dom.resultSection.hidden = false;
  dom.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Reset progress
  dom.progressCard.hidden = true;
  dom.downloadBtn.disabled = false;
  dom.downloadBtnText.textContent = 'Baixar Agora';
}

function metaItem(icon, text) {
  return `<span class="meta-item">${icon} ${text}</span>`;
}

function renderResolutions(available) {
  const ALL_RES = [
    { h: 2160, label: '4K', badge: '4K' },
    { h: 1440, label: '1440p', badge: '2K' },
    { h: 1080, label: '1080p', badge: 'FHD' },
    { h: 720,  label: '720p',  badge: 'HD' },
    { h: 480,  label: '480p',  badge: null },
    { h: 360,  label: '360p',  badge: null },
    { h: 240,  label: '240p',  badge: null },
    { h: 144,  label: '144p',  badge: null },
  ];

  // Default to best available resolution
  if (available.length > 0) {
    state.selectedRes = String(available[0]);
  } else {
    state.selectedRes = '720';
  }

  dom.resolutionGrid.innerHTML = ALL_RES.map(({ h, label, badge }) => {
    const isAvailable = available.length === 0 || available.includes(h);
    const isSelected  = String(h) === String(state.selectedRes);
    const badgeHtml   = badge ? `<span class="res-badge">${badge}</span>` : '';
    return `
      <button
        class="res-chip ${isSelected ? 'res-chip--selected' : ''} ${!isAvailable ? 'res-chip--unavailable' : ''}"
        data-res="${h}"
        ${!isAvailable ? 'disabled aria-disabled="true"' : ''}
        title="${!isAvailable ? 'Não disponível neste vídeo' : label}"
      >
        ${label} ${badgeHtml}
      </button>
    `;
  }).join('');

  // Bind click events
  dom.resolutionGrid.querySelectorAll('.res-chip:not(.res-chip--unavailable)').forEach((btn) => {
    btn.addEventListener('click', onResolutionClick);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FORMAT / QUALITY SELECTION
   ═══════════════════════════════════════════════════════════════════════════ */
function selectFormat(format) {
  state.selectedFormat = format;

  dom.tabMp3.classList.toggle('format-tab--active', format === 'mp3');
  dom.tabMp3.setAttribute('aria-selected', String(format === 'mp3'));
  dom.tabMp4.classList.toggle('format-tab--active', format === 'mp4');
  dom.tabMp4.setAttribute('aria-selected', String(format === 'mp4'));

  dom.mp3Options.hidden = format !== 'mp3';
  dom.mp4Options.hidden = format !== 'mp4';

  updateDownloadBtnLabel();
}

function onQualityClick(e) {
  const card = e.target.closest('.quality-card');
  if (!card) return;

  state.selectedQuality = card.dataset.value;

  // Update visual selection
  dom.audioQualityGrid.querySelectorAll('.quality-card').forEach((c) => {
    c.classList.toggle('quality-card--selected', c.dataset.value === state.selectedQuality);
  });
}

function onResolutionClick(e) {
  const btn = e.target.closest('.res-chip');
  if (!btn) return;

  state.selectedRes = btn.dataset.res;

  // Update visual selection
  dom.resolutionGrid.querySelectorAll('.res-chip').forEach((b) => {
    b.classList.toggle('res-chip--selected', b.dataset.res === state.selectedRes);
  });
}

function updateDownloadBtnLabel() {
  if (state.selectedFormat === 'mp3') {
    dom.downloadBtnText.textContent = `Baixar MP3 (${state.selectedQuality} kbps)`;
  } else {
    dom.downloadBtnText.textContent = `Baixar MP4 (${state.selectedRes}p)`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DOWNLOAD FLOW
   ═══════════════════════════════════════════════════════════════════════════ */
async function handleDownload() {
  if (state.isDownloading || !state.currentVideo) return;

  const url    = dom.urlInput.value.trim();
  const format = state.selectedFormat;
  const body   = format === 'mp3'
    ? { url, format, quality: state.selectedQuality }
    : { url, format, resolution: state.selectedRes };

  state.isDownloading = true;
  dom.downloadBtn.disabled = true;
  dom.downloadBtnText.textContent = 'Iniciando…';

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/download/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15_000);

    const data = await resp.json();

    if (!resp.ok) {
      showToast('error', 'Erro ao iniciar', data.error || 'Tente novamente.');
      resetDownloadState();
      return;
    }

    state.sessionId = data.sessionId;

    // Show progress UI
    dom.progressCard.hidden = false;
    dom.progressLabel.textContent = 'Conectando ao servidor…';
    dom.progressBar.style.width = '0%';
    dom.progressPercent.textContent = '0%';
    dom.progressStats.textContent = '';

    // Connect to SSE stream
    connectSSE(data.sessionId);

  } catch (err) {
    showToast('error', 'Erro de conexão', 'Verifique se o servidor está rodando.');
    resetDownloadState();
  }
}

function connectSSE(sessionId) {
  // Close any existing connection
  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }

  const evtSource = new EventSource(`${API_BASE}/download/progress/${sessionId}`);
  state.sseSource = evtSource;

  /* ── progress event ── */
  evtSource.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    const pct = Math.min(100, Math.max(0, d.percent || 0));

    dom.progressBar.style.width  = `${pct}%`;
    dom.progressPercent.textContent = `${pct.toFixed(1)}%`;
    dom.progressLabel.textContent = 'Baixando…';

    const stats = [];
    if (d.speed)     stats.push(d.speed);
    if (d.eta && d.eta !== 'Unknown') stats.push(`ETA ${d.eta}`);
    if (d.totalSize) stats.push(d.totalSize);
    dom.progressStats.textContent = stats.join('  ·  ');
  });

  /* ── status event ── */
  evtSource.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    dom.progressLabel.textContent = d.message || 'Processando…';
    if (d.percent) {
      dom.progressBar.style.width  = `${d.percent}%`;
      dom.progressPercent.textContent = `${d.percent}%`;
    }
  });

  /* ── complete event ── */
  evtSource.addEventListener('complete', (e) => {
    const d = JSON.parse(e.data);
    evtSource.close();
    state.sseSource = null;

    dom.progressBar.style.width  = '100%';
    dom.progressPercent.textContent = '100%';
    dom.progressLabel.textContent = '✅ Download concluído!';
    dom.progressStats.textContent = '';

    showToast('success', 'Pronto!', `${d.filename || 'Arquivo'} baixado com sucesso.`);

    // Trigger file download in browser
    triggerFileDownload(`${API_BASE}/download/file/${sessionId}`, d.filename);

    // Save to history
    addToHistory({
      title:     state.currentVideo?.title || 'Vídeo',
      thumbnail: state.currentVideo?.thumbnail || '',
      format:    state.selectedFormat,
      quality:   state.selectedFormat === 'mp3' ? `${state.selectedQuality} kbps` : `${state.selectedRes}p`,
      filename:  d.filename,
      url:       dom.urlInput.value.trim(),
      date:      new Date().toISOString(),
    });

    // Reset UI after 3 seconds
    setTimeout(resetDownloadState, 3000);
  });

  /* ── error event ── */
  evtSource.addEventListener('error', (e) => {
    let msg = 'Erro desconhecido.';
    try { msg = JSON.parse(e.data).message; } catch {}
    evtSource.close();
    state.sseSource = null;
    showToast('error', 'Erro no download', msg);
    dom.progressLabel.textContent = `❌ ${msg}`;
    resetDownloadState(false); // keep progress card visible on error
  });

  /* ── cancelled event ── */
  evtSource.addEventListener('cancelled', () => {
    evtSource.close();
    state.sseSource = null;
    showToast('info', 'Cancelado', 'Download cancelado.');
    resetDownloadState();
  });

  /* ── SSE connection error (network) ── */
  evtSource.onerror = () => {
    if (evtSource.readyState === EventSource.CLOSED) {
      state.sseSource = null;
    }
  };
}

function triggerFileDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

async function handleCancel() {
  if (!state.sessionId) return;

  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }

  try {
    await fetch(`${API_BASE}/download/cancel/${state.sessionId}`, { method: 'DELETE' });
  } catch {}

  showToast('info', 'Cancelado', 'Download cancelado.');
  resetDownloadState();
}

function resetDownloadState(hideProgress = true) {
  state.isDownloading = false;
  state.sessionId     = null;
  dom.downloadBtn.disabled = false;
  updateDownloadBtnLabel();
  if (hideProgress) dom.progressCard.hidden = true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */
function addToHistory(item) {
  const history = getHistory();
  history.unshift(item);
  // Keep only the most recent MAX_HISTORY items
  const trimmed = history.slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  renderHistory();
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch { return []; }
}

function renderHistory() {
  const history = getHistory();

  if (!history.length) {
    dom.historySection.hidden = true;
    return;
  }

  dom.historySection.hidden = false;

  dom.historyList.innerHTML = history.map((item, i) => `
    <div class="history-item" style="animation-delay:${i * 0.04}s">
      <img
        class="history-item__thumb"
        src="${escapeHtml(item.thumbnail)}"
        alt=""
        loading="lazy"
        onerror="this.style.display='none'"
      />
      <div class="history-item__info">
        <p class="history-item__title">${escapeHtml(item.title)}</p>
        <div class="history-item__meta">
          <span class="history-item__format history-item__format--${item.format}">${item.format.toUpperCase()}</span>
          <span>${escapeHtml(item.quality)}</span>
          <span>${formatRelativeTime(item.date)}</span>
        </div>
      </div>
      <button
        class="btn-ghost btn-ghost--sm"
        onclick="reFetch('${escapeHtml(item.url)}')"
        title="Baixar novamente"
        aria-label="Baixar novamente"
      >↩</button>
    </div>
  `).join('');
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  dom.historySection.hidden = true;
  showToast('info', 'Histórico', 'Histórico limpo.');
}

// Expose globally for inline handler
window.reFetch = function(url) {
  dom.urlInput.value = url;
  dom.urlInput.dispatchEvent(new Event('input'));
  handleSearch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

/* ═══════════════════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════════ */
function showToast(type, title, msg = '') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon" aria-hidden="true">${icons[type] || 'ℹ️'}</span>
    <div class="toast__body">
      <p class="toast__title">${escapeHtml(title)}</p>
      ${msg ? `<p class="toast__msg">${escapeHtml(msg)}</p>` : ''}
    </div>
  `;

  dom.toastContainer.appendChild(toast);

  // Auto-dismiss after 4.5s
  const timeout = setTimeout(() => dismissToast(toast), 4500);
  toast.addEventListener('click', () => { clearTimeout(timeout); dismissToast(toast); });
}

function dismissToast(toast) {
  toast.classList.add('is-hiding');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */
function isYouTubeURL(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const validHosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'];
    return validHosts.includes(host);
  } catch { return false; }
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const secs  = Math.floor(diff / 1000);
    const mins  = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const days  = Math.floor(hours / 24);
    if (days  > 0) return `${days}d atrás`;
    if (hours > 0) return `${hours}h atrás`;
    if (mins  > 0) return `${mins}min atrás`;
    return 'agora';
  } catch { return ''; }
}

/* ─── Bootstrap ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
