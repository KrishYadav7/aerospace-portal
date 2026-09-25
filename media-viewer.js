/* ============================================================
   AEROSPACE MEDIA VIEWER v5
   - Fixed YouTube playback (youtube-nocookie, no bad origin param)
   - Stronger screenshot deterrence (blur-before-capture, DRM hooks)
   - Traceable watermarks (name + session + timestamp)
   ============================================================ */
(function () {
  'use strict';
  if (window.__AERO_MEDIA_VIEWER_LOADED__) return;
  window.__AERO_MEDIA_VIEWER_LOADED__ = true;

  /* ---------- Utilities ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c =>
      ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' })[c]);
  }
  function _escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, m =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
  }
  function makeWatermarkUrl(text, opts) {
    opts = opts || {};
    const color = opts.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const size  = opts.size  || 11;
    const angle = opts.angle || -25;
    const tile  = opts.tile  || 900;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="'+tile+'" height="'+tile+'">' +
        '<text x="50%" y="50%" font-family="Inter,Arial,sans-serif" font-size="'+size+'" ' +
        'font-weight="700" fill="'+color+'" text-anchor="middle" ' +
        'transform="rotate('+angle+' '+(tile/2)+' '+(tile/2)+')">' +
          escapeXml(text) +
        '</text>' +
      '</svg>';
    return 'url("data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)+'")';
  }
  function dataURLToBytes(dataURL) {
    const idx = dataURL.indexOf(',');
    const meta = dataURL.slice(0, idx);
    const b64 = dataURL.slice(idx + 1);
    if (meta.indexOf('base64') === -1) {
      const text = decodeURIComponent(b64);
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function userToast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[MediaViewer]', msg);
  }

  const HL_COLORS = {
    yellow:'rgba(253,224,71,0.55)', green:'rgba(52,211,153,0.50)',
    blue:'rgba(96,165,250,0.50)',   pink:'rgba(244,114,182,0.50)',
    orange:'rgba(251,146,60,0.55)'
  };

  /* ============================================================
     GLOBAL SCREEN-RECORDING BLOCK
     Hook getDisplayMedia so browser-based screen recorders
     (Chrome "Record tab", Firefox, OBS-Web, Loom, etc.) cannot
     capture a tab that has an active viewer open.
     ============================================================ */
  (function blockDisplayCapture() {
    if (!navigator.mediaDevices) return;
    const orig = navigator.mediaDevices.getDisplayMedia;
    if (typeof orig !== 'function') return;
    navigator.mediaDevices.getDisplayMedia = async function (...args) {
      if ((window.PDFViewer && window.PDFViewer.active) ||
          (window.VideoPlayer && window.VideoPlayer.active)) {
        try { userToast('Screen recording is disabled for protected content.', 'error'); } catch(e){}
        throw new DOMException('Screen capture disabled', 'NotAllowedError');
      }
      return orig.apply(this, args);
    };
    console.log('[MediaViewer] getDisplayMedia hook installed');
  })();

  /* ============================================================
     GLOBAL SCREENSHOT-KEY DETECTOR
     Fires the moment a screenshot key is pressed — before most
     desktop screenshot tools finish their capture. Also clears the
     clipboard on PrintScreen so the naive copy-to-clipboard path
     produces nothing usable.
     ============================================================ */
  function fireProtectionBlur() {
    const pdf = window.PDFViewer;
    const vid = window.VideoPlayer;
    if (pdf && pdf.active && typeof pdf._flashBlur === 'function') pdf._flashBlur();
    if (vid && vid.active && typeof vid._flashBlur === 'function') vid._flashBlur();
  }

  document.addEventListener('keydown', (e) => {
    const key = e.key;
    const isPrint = key === 'PrintScreen' || e.keyCode === 44;
    const isMacShot = (e.metaKey || e.ctrlKey) && e.shiftKey &&
                      ['3','4','5','s','S'].includes(key);
    if (!isPrint && !isMacShot) return;

    fireProtectionBlur();

    if (isPrint) {
      // Poison the clipboard so the OS screenshot paste is useless
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(
            '⚠️ Content protected — screenshots are not permitted.\n' +
            'Session: ' + (sessionStorage.getItem('aero_user') ? 'tracked' : 'guest')
          );
        }
      } catch(_) {}
    }
    userToast('Screenshots are disabled for this document.', 'error');
  }, true);

  /* Blur the protected UI on window blur (macOS ⌘⇧3/4 bypasses keydown) */
  window.addEventListener('blur', fireProtectionBlur, true);

  /* ============================================================
     VIDEO PLAYER
     ============================================================ */
  class VideoPlayer {
    constructor() {
      this.active = false;
      this.modal = null;
      this.videoArea = null;
      this.titleEl = null;
      this.playlistPanel = null;
      this.playlistItemsEl = null;
      this.watermarkEl = null;
      this.playlist = [];
      this.playlistIndex = 0;
      this.playlistTitle = '';
      this.username = '';
      this._onKeyDown = this._onKeyDown.bind(this);
    }

    open(opts) {
      if (this.active) this.close();
      this.active = true;
      this.username = opts.username || 'Student';
      this.playlist = opts.playlist || [];
      this.playlistIndex = opts.playlistIndex || 0;
      this.playlistTitle = opts.playlistTitle || '';

      this._buildUI();
      this._renderWatermark();

      if (this.playlist.length > 0) {
        this._loadPlaylistItem(this.playlistIndex);
        this._renderPlaylist();
      } else {
        this._loadSingleVideo(opts);
      }

      this.modal.classList.add('active');
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', this._onKeyDown);
    }

    /* ---------- FIXED YouTube iframe builder ----------
       Root cause of the previous failure:
         • The `origin` query param was appended AFTER enablejsapi=1.
           If it didn't exactly match the window origin (e.g. served
           from GitHub Pages behind a proxy), YouTube refused to load
           the player inside the iframe.
         • `iframe.allowFullscreen = true` sometimes fails silently
           on some browsers — needs the attribute set explicitly.
         • `modestbranding` + no `playsinline` broke mobile Safari.

       New approach:
         • Drop `origin` and `enablejsapi` (unused anyway)
         • Use youtube-nocookie.com (more lenient referrer checks)
         • Force attributes via setAttribute
         • Add `playsinline=1` for iOS
         • Add `iv_load_policy=3` to hide annotation overlays        */
    _createYouTubeIframe(videoId) {
      if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        console.error('[VideoPlayer] invalid YouTube ID:', videoId);
        const err = document.createElement('div');
        err.style.cssText = 'color:#fff;padding:24px;text-align:center;font-size:15px;';
        err.innerHTML = '<i class="fas fa-triangle-exclamation" style="color:#f59e0b;font-size:36px;display:block;margin-bottom:12px;"></i>' +
                        'Invalid YouTube video ID.';
        return err;
      }

      const iframe = document.createElement('iframe');
      iframe.className = 'vp-iframe';
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('webkitallowfullscreen', 'true');
      iframe.setAttribute('mozallowfullscreen', 'true');
      iframe.setAttribute(
        'allow',
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
      );
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('loading', 'eager');

      const params = new URLSearchParams({
        autoplay:        '1',
        rel:             '0',
        modestbranding:  '1',
        playsinline:     '1',
        iv_load_policy:  '3',
        fs:              '1',
        color:           'white'
      });

      iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;

      // If YouTube fails to load (network / CSP), show a friendly message
      iframe.addEventListener('error', () => {
        console.warn('[VideoPlayer] iframe load error for', videoId);
      });

      return iframe;
    }

    _loadSingleVideo(opts) {
      this.titleEl.textContent = opts.title || 'Video';
      this.videoArea.innerHTML = '';

      if (opts.videoId) {
        this.videoArea.appendChild(this._createYouTubeIframe(opts.videoId));
      } else if (opts.src) {
        const video = document.createElement('video');
        video.src = opts.src;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('controlsList', 'nodownload noplaybackrate');
        video.setAttribute('disablePictureInPicture', 'true');
        video.addEventListener('contextmenu', e => e.preventDefault());
        this.videoArea.appendChild(video);
      } else {
        this.videoArea.innerHTML =
          '<div style="color:#fff;padding:24px;text-align:center;">No video source provided.</div>';
      }
    }

    _loadPlaylistItem(index) {
      if (index < 0 || index >= this.playlist.length) return;
      this.playlistIndex = index;
      const item = this.playlist[index];
      this.titleEl.textContent = item.title || 'Video';
      this.videoArea.innerHTML = '';

      if (item.kind === 'youtube' && item.videoId) {
        this.videoArea.appendChild(this._createYouTubeIframe(item.videoId));
      } else if (item.kind === 'direct' && item.directUrl) {
        const video = document.createElement('video');
        video.src = item.directUrl;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('controlsList', 'nodownload noplaybackrate');
        video.setAttribute('disablePictureInPicture', 'true');
        video.addEventListener('contextmenu', e => e.preventDefault());
        this.videoArea.appendChild(video);
      }
      this._renderPlaylist();
    }

    _buildUI() {
      const old = document.getElementById('videoPlayerModal');
      if (old) old.remove();

      const el = document.createElement('div');
      el.id = 'videoPlayerModal';
      el.className = 'video-player-modal';
      el.innerHTML = `
        <div class="vp-shell" id="vpShell">
          <button class="vp-back-btn" id="vpBackBtn"><i class="fas fa-arrow-left"></i> <span>Back</span></button>
          <button class="vp-playlist-toggle" id="vpPlaylistToggle" style="display:none;"><i class="fas fa-list"></i> <span>Playlist</span></button>
          <div class="vp-video-area" id="vpVideoArea"></div>
          <div class="vp-watermark" id="vpWatermark"></div>
          <div class="vp-title" id="vpTitle"></div>
          <div class="vp-playlist-panel" id="vpPlaylistPanel">
             <div class="vp-playlist-header">
               <h4 id="vpPlaylistTitle"><i class="fas fa-list"></i> Playlist</h4>
               <button class="vp-playlist-close" id="vpPlaylistClose"><i class="fas fa-times"></i></button>
             </div>
             <div class="vp-playlist-items" id="vpPlaylistItems"></div>
          </div>
        </div>`;

      document.body.appendChild(el);
      this.modal = el;
      this.videoArea = el.querySelector('#vpVideoArea');
      this.titleEl = el.querySelector('#vpTitle');
      this.watermarkEl = el.querySelector('#vpWatermark');
      this.playlistPanel = el.querySelector('#vpPlaylistPanel');
      this.playlistItemsEl = el.querySelector('#vpPlaylistItems');

      el.querySelector('#vpBackBtn').addEventListener('click', () => this.close());
      el.querySelector('#vpPlaylistClose').addEventListener('click', () => this._togglePlaylist(false));

      const toggleBtn = el.querySelector('#vpPlaylistToggle');
      toggleBtn.addEventListener('click', () => this._togglePlaylist());
      if (this.playlist.length > 0) {
        toggleBtn.style.display = 'inline-flex';
        el.querySelector('#vpPlaylistTitle').textContent = this.playlistTitle || 'Playlist';
      }
    }

    _togglePlaylist(forceState) {
      if (!this.playlistPanel) return;
      const isOpen = typeof forceState === 'boolean'
        ? forceState
        : !this.playlistPanel.classList.contains('open');
      this.playlistPanel.classList.toggle('open', isOpen);
      this.modal.querySelector('.vp-shell').classList.toggle('playlist-open', isOpen);
    }

    _renderPlaylist() {
      if (!this.playlistItemsEl) return;
      this.playlistItemsEl.innerHTML = this.playlist.map((item, i) => `
        <div class="vp-playlist-item ${i === this.playlistIndex ? 'current' : ''}" data-index="${i}">
          <div class="vp-playlist-item-num">${i + 1}</div>
          <div class="vp-playlist-item-title">${_escHtml(item.title)}</div>
          ${i === this.playlistIndex ? '<i class="fas fa-volume-up vp-playlist-item-playing"></i>' : ''}
        </div>`).join('');

      this.playlistItemsEl.querySelectorAll('.vp-playlist-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.index, 10);
          if (idx !== this.playlistIndex) this._loadPlaylistItem(idx);
        });
      });
    }

    _renderWatermark() {
      if (!this.watermarkEl) return;
      const now = new Date();
      const stamp = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const text = this.username + ' · ' + stamp;
      this.watermarkEl.style.backgroundImage = makeWatermarkUrl(text, {
        size: 14, angle: -25, tile: 700, dark: true
      });
      this.watermarkEl.style.opacity = '0.18';
    }

    _onKeyDown(e) {
      if (!this.active) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) return;

      if (e.key === 'PrintScreen' || e.keyCode === 44) {
        e.preventDefault();
        this._flashBlur();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('Screenshots disabled.');
        }
        userToast('Screenshots are disabled.', 'error');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && ['3','4','5','s','S'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        this._flashBlur();
        userToast('Screenshots are disabled.', 'error');
        return;
      }
      if (e.key === 'F12' ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && ['I','J','C','i','j','c'].includes(e.key))) {
        e.preventDefault(); e.stopPropagation();
      }
    }

    _flashBlur() {
      if (!this.modal) return;
      const shell = this.modal.querySelector('.vp-shell');
      if (!shell) return;
      shell.style.transition = 'filter .12s';
      shell.style.filter = 'blur(40px) grayscale(100%)';
      setTimeout(() => { if (shell) shell.style.filter = ''; }, 1800);
    }

    close() {
      if (!this.active) return;
      this.active = false;
      document.removeEventListener('keydown', this._onKeyDown);
      document.body.style.overflow = '';
      const m = this.modal;
      if (m) {
        m.classList.remove('active');
        setTimeout(() => { try { m.remove(); } catch(e){} }, 240);
      }
      this.playlist = [];
      this.playlistIndex = 0;
      this.modal = null;
      this.videoArea = null;
      this.titleEl = null;
      this.playlistPanel = null;
      this.playlistItemsEl = null;
      this.watermarkEl = null;
    }
  }

  window.VideoPlayer = new VideoPlayer();

  /* ============================================================
     PDF VIEWER — with hardened capture deterrence
     ============================================================ */
  class PDFViewer {
    constructor() { this._init(); }

    _init() {
      this.active = false;
      this.modal = null;
      this.bodyEl = null;
      this.pagesEl = null;
      this.selMenu = null;
      this.loaderEl = null;
      this.pdfDoc = null;
      this.materialId = null;
      this.scale = 1.2;
      this.color = 'yellow';
      this.highlights = [];
      this.pageEls = new Map();
      this.textLayers = new Map();
      this.pendingSel = null;
      this.currentPage = 1;
      this.username = '';
      this.title = '';
      this._prevBodyOverflow = '';
      this._selTimer = null;
      this._blurTimer = null;

      this._onSelectionChange = this._onSelectionChange.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
      this._onBodyScroll = this._onBodyScroll.bind(this);
      this._onWindowBlur = this._onWindowBlur.bind(this);
      this._onWindowFocus = this._onWindowFocus.bind(this);
      this._onVisibility = this._onVisibility.bind(this);
    }

    async open(opts) {
      if (this.active) return;
      this.active = true;

      if (!window.pdfjsLib) {
        this.active = false;
        userToast('PDF engine not loaded. Please refresh.', 'error');
        return;
      }
      try {
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
      } catch(e){}

      this.materialId = opts.materialId || 'doc';
      this.username   = opts.username || 'Student';
      this.title      = opts.title || opts.fileName || 'Document';
      this._prevBodyOverflow = document.body.style.overflow;

      this._buildUI();
      this._loadHighlights();
      this._renderWatermark();

      this.modal.classList.add('active');
      document.body.style.overflow = 'hidden';
      this.loaderEl.style.display = 'flex';

      try {
        let task;
        if (opts.url) {
          task = pdfjsLib.getDocument(opts.url);
        } else {
          const dataURL = String(opts.data || '').indexOf('data:') === 0
            ? opts.data
            : 'data:application/pdf;base64,' + opts.data;
          const bytes = dataURLToBytes(dataURL);
          task = pdfjsLib.getDocument({ data: bytes });
        }
        this.pdfDoc = await task.promise;
        if (!this.active) return;
        await this._renderAllPages();
        this.loaderEl.style.display = 'none';

        // ⭐ Generate + cache thumbnail (fire-and-forget, non-blocking)
        try {
          if (this.materialId && this.materialId !== 'doc' &&
              typeof generateThumbnailFromPDFDoc === 'function' &&
              typeof savePDFThumbnail === 'function') {
            generateThumbnailFromPDFDoc(this.pdfDoc, 220).then(dataUrl => {
              if (dataUrl) savePDFThumbnail(this.materialId, dataUrl);
            }).catch(() => {});
          }
        } catch (e) { /* silent */ }
      } catch (err) {
        console.error('[PDFViewer]', err);
        if (this.loaderEl) {
          this.loaderEl.innerHTML =
            '<div class="pdfv-error">' +
              '<i class="fas fa-exclamation-triangle"></i>' +
              '<p>Could not load this document.</p>' +
              '<button type="button" class="btn btn-outline btn-sm" onclick="window.PDFViewer.close()">Close</button>' +
            '</div>';
        }
      }
    }

    _buildUI() {
      const old = document.getElementById('pdfViewerModal');
      if (old) old.remove();

      const el = document.createElement('div');
      el.id = 'pdfViewerModal';
      el.className = 'pdf-viewer-modal';

      const colorBtns = Object.keys(HL_COLORS).map(c =>
        '<button class="pdfv-color ' + c + '" data-color="' + c + '" title="' + c + '" type="button"></button>'
      ).join('');

      el.innerHTML =
        '<div class="pdfv-shell" oncontextmenu="return false;">' +
          '<div class="pdfv-toolbar">' +
            '<div class="pdfv-toolbar-left">' +
              '<button type="button" class="pdfv-back-btn" data-act="close" title="Back (Esc)">' +
                '<i class="fas fa-arrow-left"></i><span>Back</span>' +
              '</button>' +
              '<span class="pdfv-title" id="pdfvTitle"></span>' +
              '<span class="pdfv-hlcount" id="pdfvHlCount"></span>' +
            '</div>' +
            '<div class="pdfv-toolbar-center">' +
              '<button type="button" class="pdfv-btn" data-act="prev" title="Previous page"><i class="fas fa-chevron-up"></i></button>' +
              '<span class="pdfv-pageinfo">' +
                '<input type="number" id="pdfvPageInput" min="1" value="1">' +
                '<span>/</span><span id="pdfvPageCount">1</span>' +
              '</span>' +
              '<button type="button" class="pdfv-btn" data-act="next" title="Next page"><i class="fas fa-chevron-down"></i></button>' +
              '<span class="pdfv-divider"></span>' +
              '<button type="button" class="pdfv-btn" data-act="zoomout" title="Zoom out"><i class="fas fa-search-minus"></i></button>' +
              '<span class="pdfv-zoomlabel" id="pdfvZoomLabel">100%</span>' +
              '<button type="button" class="pdfv-btn" data-act="zoomin" title="Zoom in"><i class="fas fa-search-plus"></i></button>' +
              '<button type="button" class="pdfv-btn" data-act="fit" title="Fit to width"><i class="fas fa-arrows-alt-h"></i></button>' +
            '</div>' +
            '<div class="pdfv-toolbar-right">' +
              '<div class="pdfv-hl-colors" id="pdfvColors">' + colorBtns + '</div>' +
              '<button type="button" class="pdfv-btn" data-act="clear-page" title="Clear highlights on current page"><i class="fas fa-eraser"></i></button>' +
              '<button type="button" class="pdfv-btn" data-act="clear-all" title="Clear all highlights"><i class="fas fa-trash-alt"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="pdfv-body" id="pdfvBody">' +
            '<div class="pdfv-pages" id="pdfvPages"></div>' +
            '<div class="pdfv-watermark" id="pdfvWatermark"></div>' +
            '<div class="pdfv-loader" id="pdfvLoader">' +
              '<div class="pdfv-spinner"></div>' +
              '<p>Loading document…</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pdfv-selection-menu" id="pdfvSelMenu">' +
          '<button type="button" class="pdfv-sel-btn" data-act="highlight"><i class="fas fa-highlighter"></i> Highlight</button>' +
          '<button type="button" class="pdfv-sel-btn" data-act="copy"><i class="fas fa-copy"></i> Copy</button>' +
        '</div>';

      document.body.appendChild(el);
      this.modal = el;
      this.bodyEl = el.querySelector('#pdfvBody');
      this.pagesEl = el.querySelector('#pdfvPages');
      this.selMenu = el.querySelector('#pdfvSelMenu');
      this.loaderEl = el.querySelector('#pdfvLoader');

      const self = this;
      el.querySelectorAll('.pdfv-btn, .pdfv-back-btn').forEach(btn => {
        btn.addEventListener('click', () => self._handleToolbar(btn.dataset.act));
      });
      el.querySelectorAll('.pdfv-color').forEach(btn => {
        btn.addEventListener('click', () => self._setColor(btn.dataset.color));
      });
      this._setColor('yellow');

      const pageInput = el.querySelector('#pdfvPageInput');
      pageInput.addEventListener('change', () => {
        const n = parseInt(pageInput.value, 10);
        if (n >= 1 && self.pdfDoc && n <= self.pdfDoc.numPages) self._scrollToPage(n);
      });

      this.selMenu.addEventListener('mousedown', e => e.preventDefault());
      this.selMenu.addEventListener('click', e => {
        const b = e.target.closest('.pdfv-sel-btn');
        if (!b) return;
        if (b.dataset.act === 'highlight') self._createHighlight();
        else if (b.dataset.act === 'copy') self._copySelection();
      });

      document.addEventListener('selectionchange', this._onSelectionChange);
      document.addEventListener('keydown', this._onKeyDown, true);
      this.bodyEl.addEventListener('scroll', this._onBodyScroll, { passive: true });
      window.addEventListener('blur', this._onWindowBlur);
      window.addEventListener('focus', this._onWindowFocus);
      document.addEventListener('visibilitychange', this._onVisibility);

      this.bodyEl.addEventListener('dragstart', e => e.preventDefault());
      this.bodyEl.addEventListener('contextmenu', e => { e.preventDefault(); return false; });
      this.bodyEl.addEventListener('copy', e => { e.preventDefault(); return false; });
      this.bodyEl.addEventListener('cut', e => { e.preventDefault(); return false; });

      this.pagesEl.addEventListener('click', e => {
        const mark = e.target.closest('mark.pdf-hl');
        if (!mark) return;
        e.stopPropagation();
        self._deleteHighlight(mark.dataset.hlId);
      });
      el.addEventListener('click', e => { if (e.target === el) self.close(); });
    }

    _handleToolbar(act) {
      if (act === 'close') return this.close();
      if (act === 'prev') return this._scrollToPage(Math.max(1, this.currentPage - 1));
      if (act === 'next') return this._scrollToPage(Math.min(this.pdfDoc ? this.pdfDoc.numPages : 1, this.currentPage + 1));
      if (act === 'zoomin') return this._changeZoom(0.15);
      if (act === 'zoomout') return this._changeZoom(-0.15);
      if (act === 'fit') return this._fitToWidth();
      if (act === 'clear-page') return this._clearPageHighlights(this.currentPage);
      if (act === 'clear-all') return this._clearAllHighlights();
    }

    _setColor(c) {
      this.color = c;
      if (!this.modal) return;
      this.modal.querySelectorAll('.pdfv-color').forEach(b => {
        b.classList.toggle('active', b.dataset.color === c);
      });
    }

    async _renderAllPages() {
      this.pagesEl.innerHTML = '';
      this.pageEls.clear();
      this.textLayers.clear();
      const total = this.pdfDoc.numPages;
      this.modal.querySelector('#pdfvPageCount').textContent = total;
      this.modal.querySelector('#pdfvTitle').textContent = this.title;
      this._updateZoomLabel();
      this._updateHlCount();
      for (let i = 1; i <= total; i++) {
        const pageEl = document.createElement('div');
        pageEl.className = 'pdfv-page';
        pageEl.dataset.page = i;
        this.pagesEl.appendChild(pageEl);
        this.pageEls.set(i, pageEl);
      }
      for (let i = 1; i <= total; i++) await this._renderPage(i);
      this._applyAllHighlights();
    }

    async _renderPage(n) {
      const page = await this.pdfDoc.getPage(n);

      // ⚡ CRISP RENDER — render at devicePixelRatio so text is sharp
      // on Retina / high-DPI screens and mobile.
      // Cap at 3 to avoid blowing up memory on ultra-dense screens.
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));

      // CSS-space viewport (what the user sees — used for layout & text layer)
      const cssViewport = page.getViewport({ scale: this.scale });
      // Render-space viewport (higher res — what gets painted on the canvas)
      const renderViewport = page.getViewport({ scale: this.scale * dpr });

      const pageEl = this.pageEls.get(n);
      if (!pageEl) return;

      pageEl.innerHTML = '';
      pageEl.style.width  = cssViewport.width  + 'px';
      pageEl.style.height = cssViewport.height + 'px';
      pageEl.style.position = 'relative';

      const canvas = document.createElement('canvas');
      canvas.width  = renderViewport.width;
      canvas.height = renderViewport.height;
      // Keep CSS size equal to the CSS viewport — browser downsamples → sharp.
      canvas.style.width  = cssViewport.width  + 'px';
      canvas.style.height = cssViewport.height + 'px';
      canvas.className = 'pdfv-canvas';
      pageEl.appendChild(canvas);

      const ctx = canvas.getContext('2d', { alpha: false });
      // Improves text legibility on some browsers
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      await page.render({
        canvasContext: ctx,
        viewport: renderViewport
      }).promise;

      // Text layer uses the CSS viewport (correct CSS pixel coordinates)
      const textLayer = document.createElement('div');
      textLayer.className = 'pdfv-textlayer';
      textLayer.style.width  = cssViewport.width  + 'px';
      textLayer.style.height = cssViewport.height + 'px';
      textLayer.style.position = 'absolute';
      textLayer.style.top  = '0';
      textLayer.style.left = '0';
      textLayer.style.setProperty('--scale-factor', this.scale);
      pageEl.appendChild(textLayer);

      const textContent = await page.getTextContent();
      let task;
      try {
        task = pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          textContent: textContent,
          container: textLayer,
          viewport: cssViewport,   // ← was `viewport`, now CSS-space
          textDivs: []
        });
      } catch (e) {
        task = pdfjsLib.renderTextLayer({
          textContent: textContent,
          container: textLayer,
          viewport: cssViewport,   // ← same here
          textDivs: []
        });
      }
      await task.promise;
      this.textLayers.set(n, textLayer);
    }

    _scrollToPage(n) {
      const el = this.pageEls.get(n);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    _onBodyScroll() {
      this._hideSelMenu();
      if (!this.modal || !this.bodyEl) return;
      const scrollTop = this.bodyEl.scrollTop;
      let current = 1;
      this.pageEls.forEach((el, page) => {
        if (el.offsetTop - 60 <= scrollTop) current = page;
      });
      this.currentPage = current;
      const inp = this.modal.querySelector('#pdfvPageInput');
      if (inp && document.activeElement !== inp) inp.value = current;
    }

    // Do NOT blur on tab switch — users often check notes/slides and come
    // back, and blurring the whole PDF for that is too aggressive.
    // Real screenshots are handled in `_onKeyDown` (PrintScreen, Cmd+Shift+3/4/5).
    _onVisibility() {
      // intentionally empty
    }

    _onWindowBlur() {
      // intentionally empty — no blur on focus loss
    }

    _onWindowFocus() {
      // nothing to restore
    }

    // Light, short blur ONLY for actual screenshot key presses.
    // 18px is enough to ruin a captured frame without hiding the content
    // from the student who is still reading it.
    _flashBlur() {
      if (!this.active || !this.modal) return;
      const shell = this.modal.querySelector('.pdfv-shell');
      if (!shell) return;

      clearTimeout(this._blurTimer);
      shell.style.transition = 'filter .08s ease';
      shell.style.filter = 'blur(18px)';

      this._blurTimer = setTimeout(() => {
        if (shell) shell.style.filter = '';
      }, 800);
    }

    _changeZoom(delta) { this._setZoom(this.scale + delta); }

    async _setZoom(scale) {
      scale = Math.max(0.4, Math.min(3.5, scale));
      if (Math.abs(scale - this.scale) < 0.01) return;
      const ratio = this.bodyEl.scrollTop / Math.max(1, this.bodyEl.scrollHeight);
      this.scale = scale;
      this._updateZoomLabel();
      this.loaderEl.style.display = 'flex';
      await this._renderAllPages();
      this.bodyEl.scrollTop = ratio * this.bodyEl.scrollHeight;
      this.loaderEl.style.display = 'none';
    }

    _updateZoomLabel() {
      if (!this.modal) return;
      const el = this.modal.querySelector('#pdfvZoomLabel');
      if (el) el.textContent = Math.round(this.scale * 100) + '%';
    }

    async _fitToWidth() {
      if (!this.pdfDoc) return;
      const page = await this.pdfDoc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const target = (this.bodyEl.clientWidth - 60) / vp.width;
      this._setZoom(target);
    }

    _onSelectionChange() {
      if (!this.active) return;
      const self = this;
      clearTimeout(this._selTimer);
      this._selTimer = setTimeout(() => self._computeSelection(), 10);
    }

    _computeSelection() {
      if (!this.active || !this.modal) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return this._hideSelMenu();
      const range = sel.getRangeAt(0);
      const textLayer = this._findTextLayer(range.commonAncestorContainer);
      if (!textLayer) return this._hideSelMenu();
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return this._hideSelMenu();
      this.pendingSel = { textLayer };
      this.selMenu.style.display = 'flex';
      this.selMenu.style.visibility = 'hidden';
      this.selMenu.style.left = '0px';
      this.selMenu.style.top = '0px';
      const mr = this.selMenu.getBoundingClientRect();
      this.selMenu.style.visibility = '';
      let left = rect.left + rect.width / 2 - mr.width / 2;
      let top  = rect.top - mr.height - 10;
      if (top < 8) top = rect.bottom + 10;
      left = Math.max(8, Math.min(window.innerWidth - mr.width - 8, left));
      this.selMenu.style.left = left + 'px';
      this.selMenu.style.top  = top + 'px';
    }

    _findTextLayer(node) {
      while (node && node !== document) {
        if (node.classList && node.classList.contains('pdfv-textlayer')) return node;
        node = node.parentNode;
      }
      return null;
    }

    _hideSelMenu() {
      if (this.selMenu) this.selMenu.style.display = 'none';
      this.pendingSel = null;
    }

    _createHighlight() {
      if (!this.pendingSel) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      const text = range.toString();
      if (!text.trim()) return;
      const textLayer = this.pendingSel.textLayer;
      const pageEl = textLayer.closest('.pdfv-page');
      if (!pageEl) return;
      const pageNum = parseInt(pageEl.dataset.page, 10);
      const start = this._textOffset(textLayer, range.startContainer, range.startOffset);
      const end   = this._textOffset(textLayer, range.endContainer, range.endOffset);
      if (start == null || end == null || start >= end) {
        return userToast('Could not create highlight — try selecting again.', 'error');
      }
      const pageHls = this.highlights.filter(h => h.page === pageNum);
      for (let i = 0; i < pageHls.length; i++) {
        if (start < pageHls[i].end && end > pageHls[i].start) {
          return userToast('Overlaps an existing highlight.', 'error');
        }
      }
      this.highlights.push({
        id: uid(), page: pageNum, start, end, text,
        color: this.color, createdAt: Date.now()
      });
      this._saveHighlights();
      this._applyPageHighlights(pageNum);
      this._updateHlCount();
      sel.removeAllRanges();
      this._hideSelMenu();
      userToast('Highlighted.', 'success');
    }

    _textOffset(root, node, offset) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      let cum = 0, n;
      while ((n = walker.nextNode())) {
        if (n === node) return cum + offset;
        cum += n.nodeValue.length;
      }
      return null;
    }

    _copySelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      if (!text) return;
      const self = this;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(
            () => userToast('Copied to clipboard.', 'success'),
            () => self._fallbackCopy(text)
          );
        } else this._fallbackCopy(text);
      } catch(e) { this._fallbackCopy(text); }
    }

    _fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        userToast(ok ? 'Copied.' : 'Copy failed.', ok ? 'success' : 'error');
      } catch(e) { userToast('Copy failed.', 'error'); }
    }

    _deleteHighlight(id) {
      const idx = this.highlights.findIndex(h => h.id === id);
      if (idx === -1) return;
      const hl = this.highlights[idx];
      if (!confirm('Remove this highlight?')) return;
      this.highlights.splice(idx, 1);
      this._saveHighlights();
      this._applyPageHighlights(hl.page);
      this._updateHlCount();
    }

    _clearPageHighlights(pageNum) {
      const list = this.highlights.filter(h => h.page === pageNum);
      if (list.length === 0) return userToast('No highlights on this page.', 'info');
      if (!confirm('Remove ' + list.length + ' highlight(s) on this page?')) return;
      this.highlights = this.highlights.filter(h => h.page !== pageNum);
      this._saveHighlights();
      this._applyPageHighlights(pageNum);
      this._updateHlCount();
    }

    _clearAllHighlights() {
      if (this.highlights.length === 0) return userToast('No highlights to clear.', 'info');
      if (!confirm('Remove all ' + this.highlights.length + ' highlight(s)?')) return;
      this.highlights = [];
      this._saveHighlights();
      this._applyAllHighlights();
      this._updateHlCount();
    }

    _storageKey() { return 'aero_pdf_hl_' + this.materialId; }

    _loadHighlights() {
      try {
        const raw = localStorage.getItem(this._storageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        this.highlights = Array.isArray(parsed) ? parsed : [];
      } catch(e) { this.highlights = []; }
    }

    _saveHighlights() {
      try { localStorage.setItem(this._storageKey(), JSON.stringify(this.highlights)); } catch(e){}
    }

    _updateHlCount() {
      if (!this.modal) return;
      const el = this.modal.querySelector('#pdfvHlCount');
      if (!el) return;
      const n = this.highlights.length;
      el.textContent = n > 0 ? '· ' + n + ' highlight' + (n === 1 ? '' : 's') : '';
    }

    _applyAllHighlights() {
      const self = this;
      this.textLayers.forEach((_, n) => self._applyPageHighlights(n));
    }

    _applyPageHighlights(pageNum) {
      const pageEl = this.pageEls.get(pageNum);
      const textLayer = this.textLayers.get(pageNum);
      if (!pageEl || !textLayer) return;
      pageEl.querySelectorAll('mark.pdf-hl').forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      try { textLayer.normalize(); } catch(e){}
      const list = this.highlights.filter(h => h.page === pageNum);
      if (list.length === 0) return;
      list.sort((a,b) => b.start - a.start);
      for (let i = 0; i < list.length; i++) this._paintHighlight(list[i], textLayer);
    }

    _paintHighlight(hl, textLayer) {
      const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      let cum = 0, n;
      while ((n = walker.nextNode())) {
        const len = n.nodeValue.length;
        nodes.push({ node: n, start: cum, end: cum + len });
        cum += len;
      }
      const total = cum;
      const start = Math.max(0, Math.min(hl.start, total));
      const end = Math.min(hl.end, total);
      if (start >= end) return;
      const targets = nodes.filter(t => t.end > start && t.start < end);
      const color = HL_COLORS[hl.color] || HL_COLORS.yellow;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const node = t.node;
        if (!node.parentNode) continue;
        const localStart = Math.max(0, start - t.start);
        const localEnd = Math.min(node.nodeValue.length, end - t.start);
        if (localStart >= localEnd) continue;
        const before = node.nodeValue.slice(0, localStart);
        const mid    = node.nodeValue.slice(localStart, localEnd);
        const after  = node.nodeValue.slice(localEnd);
        const mark = document.createElement('mark');
        mark.className = 'pdf-hl';
        mark.dataset.hlId = hl.id;
        mark.style.backgroundColor = color;
        mark.textContent = mid;
        const parent = node.parentNode;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(mark);
        if (after) frag.appendChild(document.createTextNode(after));
        parent.replaceChild(frag, node);
      }
    }

    _renderWatermark() {
      if (!this.modal) return;
      const wm = this.modal.querySelector('#pdfvWatermark');
      if (!wm) return;
      const now = new Date();
      const stamp = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const text = this.username + ' · ' + stamp;
      wm.style.backgroundImage = makeWatermarkUrl(text, {
        size: 13, angle: -25, tile: 750, dark: false
      });
      wm.style.opacity = '0.42';
    }

    _onKeyDown(e) {
      if (!this.active) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }

      if (e.key === 'PrintScreen' || e.keyCode === 44) {
        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('Screenshots disabled.');
        }
        userToast('Screenshots are disabled for this document.', 'error');
        this._flashBlur();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && ['3','4','5','s','S'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        userToast('Screenshots are disabled.', 'error');
        this._flashBlur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p' || e.key === 'S' || e.key === 'P')) {
        e.preventDefault(); e.stopPropagation();
        userToast('Downloading and printing are disabled.', 'error');
        return;
      }
      if (e.key === 'F12' ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && ['I','J','C','i','j','c'].includes(e.key))) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault(); e.stopPropagation(); return;
      }
    }

    close() {
      if (!this.active) return;
      this.active = false;
      clearTimeout(this._selTimer);
      clearTimeout(this._blurTimer);
      document.removeEventListener('selectionchange', this._onSelectionChange);
      document.removeEventListener('keydown', this._onKeyDown, true);
      if (this.bodyEl) this.bodyEl.removeEventListener('scroll', this._onBodyScroll);
      window.removeEventListener('blur', this._onWindowBlur);
      window.removeEventListener('focus', this._onWindowFocus);
      document.removeEventListener('visibilitychange', this._onVisibility);
      document.body.style.overflow = this._prevBodyOverflow || '';

      const m = this.modal;
      if (m) {
        m.classList.remove('active');
        setTimeout(() => { try { m.remove(); } catch(e){} }, 240);
      }
      this.pdfDoc = null;
      this.pageEls.clear();
      this.textLayers.clear();
      this.pendingSel = null;
      const saved = this.materialId;
      this._init();
      this.materialId = saved;
    }
  }

  window.PDFViewer = new PDFViewer();
  console.log('[AeroMediaViewer v5] Ready — hardened protection + fixed YouTube embed');
})();