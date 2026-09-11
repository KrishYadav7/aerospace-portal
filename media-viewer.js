/* ============================================================
   AEROSPACE MEDIA VIEWER
   — Custom PDF Viewer with client-side highlights
   — Custom Video Player with modern controls
   No download. Watermarked. No server round-trips for highlights.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Utils ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
    }[c]));
  }

  function makeWatermarkUrl(text, opts) {
    opts = opts || {};
    const color = opts.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
    const size  = opts.size  || 22;
    const angle = opts.angle || -28;
    const tile  = opts.tile  || 380;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + tile + '" height="' + tile + '">' +
      '<text x="50%" y="50%" font-family="Inter,Arial,sans-serif" font-size="' + size + '" ' +
      'font-weight="700" fill="' + color + '" text-anchor="middle" ' +
      'transform="rotate(' + angle + ' ' + (tile / 2) + ' ' + (tile / 2) + ')">' +
      escapeXml(text) + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  async function dataURLToUint8(dataURL) {
    const res = await fetch(dataURL);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  const HL_COLORS = {
    yellow: 'rgba(253, 224, 71, 0.55)',
    green:  'rgba(52, 211, 153, 0.50)',
    blue:   'rgba(96, 165, 250, 0.50)',
    pink:   'rgba(244, 114, 182, 0.50)',
    orange: 'rgba(251, 146, 60, 0.50)'
  };

  /* ============================================================
     PDF VIEWER
     ============================================================ */
  class PDFViewer {
    constructor() {
      this.modal = null;
      this.bodyEl = null;
      this.pagesEl = null;
      this.selMenu = null;
      this.loaderEl = null;
      this.pdfDoc = null;
      this.materialId = null;
      this.courseId = null;
      this.scale = 1.25;
      this.highlights = [];
      this.currentColor = 'yellow';
      this.pageEls = new Map();
      this.textLayers = new Map();
      this._pendingSel = null;
      this._currentPage = 1;
      this.username = '';
      this.title = '';
      this._open = false;
    }

    async open(opts) {
      if (this._open) return;
      this._open = true;
      this.materialId = opts.materialId;
      this.courseId = opts.courseId;
      this.username = opts.username || 'Student';
      this.title = opts.title || opts.fileName || 'Document';

      this.buildModal();
      this.loadHighlights();
      this.renderWatermark();

      this.modal.classList.add('active');
      document.body.style.overflow = 'hidden';
      this.loaderEl.style.display = 'flex';

      try {
        const dataURL = opts.data.indexOf('data:') === 0
          ? opts.data
          : 'data:application/pdf;base64,' + opts.data;
        const bytes = await dataURLToUint8(dataURL);
        const task = pdfjsLib.getDocument({ data: bytes });
        this.pdfDoc = await task.promise;
        await this.renderAllPages();
      } catch (err) {
        console.error('[PDFViewer] load error', err);
        this.loaderEl.innerHTML =
          '<div class="pdfv-error"><i class="fas fa-exclamation-triangle"></i>' +
          '<p>Could not load this document.</p></div>';
      }
    }

    buildModal() {
      const old = document.getElementById('pdfViewerModal');
      if (old) old.remove();

      const modal = document.createElement('div');
      modal.id = 'pdfViewerModal';
      modal.className = 'pdf-viewer-modal';
      modal.innerHTML =
        '<div class="pdfv-shell">' +
          '<div class="pdfv-toolbar">' +
            '<div class="pdfv-toolbar-left">' +
              '<button class="pdfv-btn" data-act="close" title="Close (Esc)"><i class="fas fa-times"></i></button>' +
              '<span class="pdfv-title" id="pdfvTitle"></span>' +
            '</div>' +
            '<div class="pdfv-toolbar-center">' +
              '<button class="pdfv-btn" data-act="prev" title="Previous page"><i class="fas fa-chevron-up"></i></button>' +
              '<span class="pdfv-pageinfo">' +
                '<input type="number" id="pdfvPageInput" min="1" value="1">' +
                '<span>/</span><span id="pdfvPageCount">1</span>' +
              '</span>' +
              '<button class="pdfv-btn" data-act="next" title="Next page"><i class="fas fa-chevron-down"></i></button>' +
              '<span class="pdfv-divider"></span>' +
              '<button class="pdfv-btn" data-act="zoomout" title="Zoom out"><i class="fas fa-search-minus"></i></button>' +
              '<span class="pdfv-zoomlabel" id="pdfvZoomLabel">125%</span>' +
              '<button class="pdfv-btn" data-act="zoomin" title="Zoom in"><i class="fas fa-search-plus"></i></button>' +
              '<button class="pdfv-btn" data-act="fit" title="Fit width"><i class="fas fa-arrows-alt-h"></i></button>' +
            '</div>' +
            '<div class="pdfv-toolbar-right">' +
              '<div class="pdfv-hl-colors" id="pdfvColors">' +
                Object.keys(HL_COLORS).map(c =>
                  '<button class="pdfv-color ' + c + '" data-color="' + c + '" title="' + c + '" type="button"></button>'
                ).join('') +
              '</div>' +
              '<button class="pdfv-btn" data-act="clear-page" title="Clear highlights on current page"><i class="fas fa-eraser"></i></button>' +
              '<button class="pdfv-btn" data-act="clear-all" title="Clear all highlights"><i class="fas fa-trash-alt"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="pdfv-body" id="pdfvBody">' +
            '<div class="pdfv-pages" id="pdfvPages"></div>' +
            '<div class="pdfv-watermark" id="pdfvWatermark"></div>' +
            '<div class="pdfv-loader" id="pdfvLoader">' +
              '<div class="pdfv-spinner"></div><p>Loading document…</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pdfv-selection-menu" id="pdfvSelMenu">' +
          '<button class="pdfv-sel-btn" data-act="highlight" type="button"><i class="fas fa-highlighter"></i> Highlight</button>' +
          '<button class="pdfv-sel-btn" data-act="copy" type="button"><i class="fas fa-copy"></i> Copy</button>' +
        '</div>';

      document.body.appendChild(modal);

      this.modal = modal;
      this.bodyEl = modal.querySelector('#pdfvBody');
      this.pagesEl = modal.querySelector('#pdfvPages');
      this.selMenu = modal.querySelector('#pdfvSelMenu');
      this.loaderEl = modal.querySelector('#pdfvLoader');

      // Toolbar buttons
      modal.querySelectorAll('.pdfv-btn').forEach(b => {
        b.addEventListener('click', () => this.handleToolbar(b.dataset.act));
      });
      modal.querySelectorAll('.pdfv-color').forEach(b => {
        b.addEventListener('click', () => this.setColor(b.dataset.color));
      });

      // Page input
      modal.querySelector('#pdfvPageInput').addEventListener('change', e => {
        const n = parseInt(e.target.value, 10);
        if (n >= 1 && n <= (this.pdfDoc ? this.pdfDoc.numPages : 1)) this.scrollToPage(n);
      });

      // Selection menu — don't lose selection on mousedown
      this.selMenu.addEventListener('mousedown', e => e.preventDefault());
      this.selMenu.addEventListener('click', e => {
        const btn = e.target.closest('.pdfv-sel-btn');
        if (!btn) return;
        if (btn.dataset.act === 'highlight') this.createHighlight();
        else if (btn.dataset.act === 'copy') this.copySelection();
      });

      // Selection tracking
      this._selectionHandler = () => this.onSelectionChange();
      document.addEventListener('selectionchange', this._selectionHandler);
      this.bodyEl.addEventListener('scroll', () => { this.hideSelMenu(); this.onScroll(); }, { passive: true });

      // Block right-click / drag
      this.bodyEl.addEventListener('contextmenu', e => e.preventDefault());
      this.bodyEl.addEventListener('dragstart', e => e.preventDefault());

      // Click highlight → delete
      this.pagesEl.addEventListener('click', e => {
        const mark = e.target.closest('mark.pdf-hl');
        if (!mark) return;
        e.stopPropagation();
        this.deleteHighlight(mark.dataset.hlId);
      });

      // Esc + Ctrl+S/P guard
      this._keydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); this.close(); }
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p')) {
          e.preventDefault(); e.stopPropagation();
        }
      };
      document.addEventListener('keydown', this._keydown, true);

      // Close on backdrop
      modal.addEventListener('click', e => { if (e.target === modal) this.close(); });
    }

    handleToolbar(act) {
      if (act === 'close') return this.close();
      if (act === 'prev') return this.scrollToPage(Math.max(1, this._currentPage - 1));
      if (act === 'next') return this.scrollToPage(Math.min(this.pdfDoc ? this.pdfDoc.numPages : 1, this._currentPage + 1));
      if (act === 'zoomin') return this.setZoom(this.scale + 0.15);
      if (act === 'zoomout') return this.setZoom(Math.max(0.5, this.scale - 0.15));
      if (act === 'fit') return this.fitWidth();
      if (act === 'clear-page') return this.clearPageHighlights(this._currentPage);
      if (act === 'clear-all') {
        if (this.highlights.length === 0) return showToast('No highlights to clear.', 'info');
        if (confirm('Remove all highlights in this document?')) {
          this.highlights = [];
          this.saveHighlights();
          this.applyAllHighlights();
          showToast('All highlights cleared.', 'success');
        }
      }
    }

    setColor(c) {
      this.currentColor = c;
      this.modal.querySelectorAll('.pdfv-color').forEach(b =>
        b.classList.toggle('active', b.dataset.color === c));
    }

    setZoom(scale) {
      scale = Math.max(0.5, Math.min(3, scale));
      if (Math.abs(scale - this.scale) < 0.01) return;
      const ratio = this.bodyEl.scrollTop / Math.max(1, this.bodyEl.scrollHeight);
      this.scale = scale;
      this.loaderEl.style.display = 'flex';
      this.renderAllPages().then(() => {
        this.bodyEl.scrollTop = ratio * this.bodyEl.scrollHeight;
        this.loaderEl.style.display = 'none';
      });
    }

    fitWidth() {
      if (!this.pdfDoc) return;
      this.pdfDoc.getPage(1).then(p => {
        const vp = p.getViewport({ scale: 1 });
        this.setZoom((this.bodyEl.clientWidth - 60) / vp.width);
      });
    }

    updateZoomLabel() {
      this.modal.querySelector('#pdfvZoomLabel').textContent = Math.round(this.scale * 100) + '%';
    }

    async renderAllPages() {
      this.pagesEl.innerHTML = '';
      this.pageEls.clear();
      this.textLayers.clear();

      const total = this.pdfDoc.numPages;
      this.modal.querySelector('#pdfvPageCount').textContent = total;
      this.modal.querySelector('#pdfvTitle').textContent = this.title;
      this.updateZoomLabel();

      for (let i = 1; i <= total; i++) {
        const el = document.createElement('div');
        el.className = 'pdfv-page';
        el.dataset.page = i;
        this.pagesEl.appendChild(el);
        this.pageEls.set(i, el);
      }

      for (let i = 1; i <= total; i++) await this.renderPage(i);
      this.applyAllHighlights();
    }

    async renderPage(n) {
      const page = await this.pdfDoc.getPage(n);
      const viewport = page.getViewport({ scale: this.scale });
      const el = this.pageEls.get(n);
      el.innerHTML = '';
      el.style.width = viewport.width + 'px';
      el.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = 'pdfv-canvas';
      el.appendChild(canvas);

      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport
      }).promise;

      const textContent = await page.getTextContent();
      const textLayer = document.createElement('div');
      textLayer.className = 'pdfv-textlayer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';
      textLayer.style.setProperty('--scale-factor', String(this.scale));
      el.appendChild(textLayer);

      // PDF.js 3.x uses textContent; 4.x uses textContentSource
      const params = { container: textLayer, viewport: viewport, textDivs: [] };
      if (pdfjsLib.version && /^4\./.test(pdfjsLib.version)) params.textContentSource = textContent;
      else params.textContent = textContent;

      try {
        await pdfjsLib.renderTextLayer(params).promise;
      } catch (e) {
        const alt = { container: textLayer, viewport: viewport, textDivs: [] };
        if (params.textContent) alt.textContentSource = textContent; else alt.textContent = textContent;
        await pdfjsLib.renderTextLayer(alt).promise;
      }

      this.textLayers.set(n, textLayer);
    }

    scrollToPage(n) {
      const el = this.pageEls.get(n);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    onScroll() {
      const top = this.bodyEl.scrollTop;
      let current = 1;
      for (const entry of this.pageEls) {
        if (entry[1].offsetTop - 60 <= top) current = entry[0]; else break;
      }
      this._currentPage = current;
      const inp = this.modal.querySelector('#pdfvPageInput');
      if (inp && document.activeElement !== inp) inp.value = current;
    }

    /* ---------- Selection ---------- */
    onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return this.hideSelMenu();
      const range = sel.getRangeAt(0);
      const textLayer = this.getTextLayerAncestor(range.commonAncestorContainer);
      if (!textLayer) return this.hideSelMenu();
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return this.hideSelMenu();

      this._pendingSel = { textLayer: textLayer, range: range.cloneRange() };

      this.selMenu.style.display = 'flex';
      const mr = this.selMenu.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - mr.width / 2;
      let top  = rect.top - mr.height - 10;
      if (top < 8) top = rect.bottom + 10;
      left = Math.max(8, Math.min(window.innerWidth - mr.width - 8, left));
      this.selMenu.style.left = left + 'px';
      this.selMenu.style.top  = top  + 'px';
    }

    getTextLayerAncestor(node) {
      while (node && node !== document) {
        if (node.classList && node.classList.contains('pdfv-textlayer')) return node;
        node = node.parentNode;
      }
      return null;
    }

    hideSelMenu() {
      this.selMenu.style.display = 'none';
      this._pendingSel = null;
    }

    /* ---------- Create / delete highlight ---------- */
    createHighlight() {
      const pending = this._pendingSel;
      if (!pending) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      const text = range.toString();
      if (!text.trim()) return;

      const textLayer = pending.textLayer;
      const pageEl = textLayer.closest('.pdfv-page');
      if (!pageEl) return;
      const pageNum = parseInt(pageEl.dataset.page, 10);

      const preRange = document.createRange();
      preRange.selectNodeContents(textLayer);
      preRange.setEnd(range.startContainer, range.startOffset);
      const start = preRange.toString().length;
      const end = start + text.length;

      // Reject overlap
      const pageHls = this.highlights.filter(h => h.page === pageNum);
      for (let i = 0; i < pageHls.length; i++) {
        if (start < pageHls[i].end && end > pageHls[i].start) {
          showToast('This range overlaps an existing highlight.', 'error');
          return;
        }
      }

      this.highlights.push({
        id: uid(),
        page: pageNum,
        start: start,
        end: end,
        text: text,
        color: this.currentColor,
        createdAt: Date.now()
      });
      this.saveHighlights();
      this.applyPageHighlights(pageNum);

      sel.removeAllRanges();
      this.hideSelMenu();
    }

    async copySelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      if (!text) return;
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        }
        showToast('Copied to clipboard.', 'success');
      } catch { showToast('Copy failed.', 'error'); }
    }

    deleteHighlight(id) {
      const idx = this.highlights.findIndex(h => h.id === id);
      if (idx === -1) return;
      const hl = this.highlights[idx];
      if (!confirm('Remove this highlight?')) return;
      this.highlights.splice(idx, 1);
      this.saveHighlights();
      this.applyPageHighlights(hl.page);
    }

    clearPageHighlights(pageNum) {
      const list = this.highlights.filter(h => h.page === pageNum);
      if (list.length === 0) return showToast('No highlights on this page.', 'info');
      if (!confirm('Clear ' + list.length + ' highlight(s) on this page?')) return;
      this.highlights = this.highlights.filter(h => h.page !== pageNum);
      this.saveHighlights();
      this.applyPageHighlights(pageNum);
      showToast('Highlights cleared.', 'success');
    }

    /* ---------- Persistence ---------- */
    storageKey() { return 'aero_pdf_hl_' + this.materialId; }

    loadHighlights() {
      try {
        const raw = localStorage.getItem(this.storageKey());
        this.highlights = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(this.highlights)) this.highlights = [];
      } catch (e) { this.highlights = []; }
    }

    saveHighlights() {
      try {
        localStorage.setItem(this.storageKey(), JSON.stringify(this.highlights));
      } catch (e) { console.warn('[PDFViewer] save failed', e); }
    }

    /* ---------- Rendering highlights ---------- */
    applyAllHighlights() {
      const self = this;
      this.textLayers.forEach(function (_, n) { self.applyPageHighlights(n); });
    }

    applyPageHighlights(pageNum) {
      const pageEl = this.pageEls.get(pageNum);
      const textLayer = this.textLayers.get(pageNum);
      if (!pageEl || !textLayer) return;

      // Unwrap existing marks
      pageEl.querySelectorAll('mark.pdf-hl').forEach(function (m) {
        const p = m.parentNode;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      });
      textLayer.normalize();

      const list = this.highlights.filter(h => h.page === pageNum);
      if (!list.length) return;

      // Sort descending so earlier ranges aren't shifted
      list.sort((a, b) => b.start - a.start);
      for (let i = 0; i < list.length; i++) this._applyOne(list[i], textLayer);
    }

    _applyOne(hl, textLayer) {
      const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
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

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const node = t.node;
        if (!node.parentNode) continue;
        const localStart = Math.max(0, start - t.start);
        const localEnd = Math.min(node.nodeValue.length, end - t.start);
        if (localStart >= localEnd) continue;

        const before = node.nodeValue.slice(0, localStart);
        const mid = node.nodeValue.slice(localStart, localEnd);
        const after = node.nodeValue.slice(localEnd);

        const mark = document.createElement('mark');
        mark.className = 'pdf-hl';
        mark.dataset.hlId = hl.id;
        mark.style.background = HL_COLORS[hl.color] || HL_COLORS.yellow;
        mark.textContent = mid;

        const parent = node.parentNode;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(mark);
        if (after) frag.appendChild(document.createTextNode(after));
        parent.replaceChild(frag, node);
      }
    }

    /* ---------- Watermark ---------- */
    renderWatermark() {
      const wm = this.modal.querySelector('#pdfvWatermark');
      const text = this.username + ' · ' + new Date().toISOString().slice(0, 10);
      wm.style.backgroundImage = 'url("' + makeWatermarkUrl(text) + '")';
    }

    close() {
      this._open = false;
      document.removeEventListener('keydown', this._keydown, true);
      document.removeEventListener('selectionchange', this._selectionHandler);
      if (this.modal) this.modal.classList.remove('active');
      document.body.style.overflow = '';
      const m = this.modal;
      this.modal = null;
      this.pdfDoc = null;
      this.pageEls.clear();
      this.textLayers.clear();
      setTimeout(function () { if (m) m.remove(); }, 260);
    }
  }

  /* ============================================================
     VIDEO PLAYER
     ============================================================ */
  class VideoPlayer {
    constructor() {
      this.modal = null;
      this.video = null;
      this.materialId = null;
      this._hideTimer = null;
      this._toastTimer = null;
      this._resumeInterval = null;
      this._currentSpeed = 1;
    }

    parseYouTube(url) {
      if (!url) return null;
      const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    }

    open(opts) {
      this.materialId = opts.materialId || 'video';
      this.courseId = opts.courseId;
      this.username = opts.username || 'Student';
      this.title = opts.title || 'Video';

      const ytId = this.parseYouTube(opts.src);
      if (ytId) return this.openYouTube(ytId);
      if (!opts.src || !/^https?:\/\//i.test(opts.src)) return showToast('Invalid video URL.', 'error');
      this.openDirect(opts.src, opts.poster);
    }

    openYouTube(ytId) {
      // YouTube natively prevents download; embed with restricted UI
      this.buildModal(
        '<iframe class="vp-iframe" frameborder="0" allowfullscreen ' +
        'src="https://www.youtube.com/embed/' + ytId +
        '?rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&showinfo=0" ' +
        'allow="autoplay; encrypted-media; picture-in-picture; fullscreen" ' +
        'referrerpolicy="strict-origin-when-cross-origin"></iframe>'
      );
      this.renderWatermark();
    }

    openDirect(src, poster) {
      const controlsHtml =
        '<div class="vp-center-play" id="vpCenterPlay"><i class="fas fa-play"></i></div>' +
        '<div class="vp-title" id="vpTitle">' + this.escapeHtml(this.title) + '</div>' +
        '<div class="vp-toast" id="vpToast"></div>' +
        '<div class="vp-watermark" id="vpWatermark"></div>' +
        '<div class="vp-controls" id="vpControls">' +
          '<div class="vp-progress-row" id="vpProgress">' +
            '<div class="vp-progress-bg"></div>' +
            '<div class="vp-progress-buffered" id="vpBuffered"></div>' +
            '<div class="vp-progress-filled" id="vpFilled"></div>' +
            '<div class="vp-thumb" id="vpThumb"></div>' +
            '<div class="vp-tooltip" id="vpTooltip">0:00</div>' +
          '</div>' +
          '<div class="vp-buttons">' +
            '<button class="vp-btn" data-act="back" title="Back 10s (J)"><i class="fas fa-rotate-left"></i></button>' +
            '<button class="vp-btn" data-act="play" id="vpPlayBtn" title="Play/Pause (Space)"><i class="fas fa-play"></i></button>' +
            '<button class="vp-btn" data-act="fwd" title="Forward 10s (L)"><i class="fas fa-rotate-right"></i></button>' +
            '<span class="vp-time" id="vpTime">0:00 / 0:00</span>' +
            '<div class="vp-spacer"></div>' +
            '<div class="vp-volume-wrap">' +
              '<button class="vp-btn" data-act="mute" id="vpMuteBtn" title="Mute (M)"><i class="fas fa-volume-high"></i></button>' +
              '<div class="vp-volume"><input type="range" id="vpVolume" min="0" max="1" step="0.05" value="1"></div>' +
            '</div>' +
            '<div class="vp-speed-wrap">' +
              '<button class="vp-speed-btn" data-act="speed" id="vpSpeedBtn" title="Playback speed">1×</button>' +
              '<div class="vp-speed-menu" id="vpSpeedMenu">' +
                [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(function (s) {
                  return '<button data-speed="' + s + '"' + (s === 1 ? ' class="active"' : '') + '>' + s + '×</button>';
                }).join('') +
              '</div>' +
            '</div>' +
            '<button class="vp-btn" data-act="pip" title="Picture-in-Picture"><i class="fas fa-clone"></i></button>' +
            '<button class="vp-btn" data-act="fs" title="Fullscreen (F)"><i class="fas fa-expand"></i></button>' +
          '</div>' +
        '</div>';

      this.buildModal(
        '<video id="vpVideo" playsinline preload="metadata" controlslist="nodownload noplaybackrate noremoteplayback" ' +
        'disablepictureinpicture="false"' + (poster ? ' poster="' + poster + '"' : '') + '></video>' + controlsHtml
      );

      this.video = this.modal.querySelector('#vpVideo');
      this.video.src = src;
      this.renderWatermark();
      this.wireVideoEvents();
      this.setupPrefs();

      const playPromise = this.video.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => this.showCenterPlay());
    }

    escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    buildModal(inner) {
      const old = document.getElementById('videoPlayerModal');
      if (old) old.remove();

      const modal = document.createElement('div');
      modal.id = 'videoPlayerModal';
      modal.className = 'video-player-modal';
      modal.innerHTML = '<div class="vp-shell">' + inner + '</div>';
      document.body.appendChild(modal);

      this.modal = modal;
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';

      modal.addEventListener('click', e => { if (e.target === modal) this.close(); });
      modal.addEventListener('contextmenu', e => e.preventDefault());

      this._keydown = e => {
        if (e.key === 'Escape' && !document.fullscreenElement) { e.preventDefault(); this.close(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); return; }
        if (!this.video) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); this.togglePlay(); }
        else if (e.key === 'ArrowRight' || e.key === 'l') this.seek(this.video.currentTime + 10);
        else if (e.key === 'ArrowLeft' || e.key === 'j') this.seek(this.video.currentTime - 10);
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.setVolume(Math.min(1, this.video.volume + 0.1)); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this.setVolume(Math.max(0, this.video.volume - 0.1)); }
        else if (e.key === 'm') this.toggleMute();
        else if (e.key === 'f') this.toggleFullscreen();
        else if (e.key === 'p') this.togglePiP();
      };
      document.addEventListener('keydown', this._keydown, true);
    }

    wireVideoEvents() {
      const self = this;
      const v = this.video;

      v.addEventListener('timeupdate', () => self.updateProgress());
      v.addEventListener('loadedmetadata', () => { self.updateProgress(); self.updateTime(); self.restoreResume(); });
      v.addEventListener('play', () => { self.setPlayIcon(true); self.hideCenterPlay(); self.scheduleHideControls(); });
      v.addEventListener('pause', () => { self.setPlayIcon(false); self.showControls(); clearTimeout(self._hideTimer); self.saveResume(); });
      v.addEventListener('ended', () => { self.setPlayIcon(false); self.saveResume(); });
      v.addEventListener('progress', () => self.updateBuffered());
      v.addEventListener('error', () => showToast('Could not play this video.', 'error'));
      v.addEventListener('dblclick', () => self.toggleFullscreen());
      v.addEventListener('click', () => { if (!self._dragSeeking) self.togglePlay(); });

      // Controls
      this.modal.querySelectorAll('.vp-btn, .vp-speed-btn').forEach(b => {
        b.addEventListener('click', e => { e.stopPropagation(); self.handleAction(b.dataset.act); });
      });

      // Progress bar
      const progress = this.modal.querySelector('#vpProgress');
      let seeking = false;

      function getPct(e) {
        const r = progress.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      }
      function preview(e) {
        const pct = getPct(e);
        self.modal.querySelector('#vpFilled').style.width = (pct * 100) + '%';
        self.modal.querySelector('#vpThumb').style.left  = (pct * 100) + '%';
        self.modal.querySelector('#vpTooltip').style.left = (pct * 100) + '%';
        self.modal.querySelector('#vpTooltip').textContent = self.formatTime(pct * (v.duration || 0));
        return pct;
      }
      progress.addEventListener('mousemove', preview);
      progress.addEventListener('mousedown', e => {
        seeking = true; self._dragSeeking = true;
        let lastPct = preview(e);
        function onMove(ev) { lastPct = preview(ev); }
        function onUp() {
          v.currentTime = lastPct * (v.duration || 0);
          seeking = false;
          setTimeout(() => { self._dragSeeking = false; }, 50);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Volume
      const vol = this.modal.querySelector('#vpVolume');
      vol.addEventListener('input', () => self.setVolume(parseFloat(vol.value)));

      // Speed menu
      const speedMenu = this.modal.querySelector('#vpSpeedMenu');
      speedMenu.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          self.setSpeed(parseFloat(b.dataset.speed));
          speedMenu.classList.remove('open');
        });
      });
      document.addEventListener('click', e => {
        if (!e.target.closest('.vp-speed-wrap')) speedMenu.classList.remove('open');
      });

      // Auto-hide controls
      this.modal.addEventListener('mousemove', () => self.scheduleHideControls());
      this.modal.addEventListener('touchstart', () => self.scheduleHideControls());

      // Fullscreen icon
      this._fsHandler = () => {
        const i = self.modal && self.modal.querySelector('[data-act="fs"] i');
        if (i) i.className = document.fullscreenElement ? 'fas fa-compress' : 'fas fa-expand';
      };
      document.addEventListener('fullscreenchange', this._fsHandler);
    }

    handleAction(act) {
      if (act === 'play') this.togglePlay();
      else if (act === 'back') this.seek(this.video.currentTime - 10);
      else if (act === 'fwd') this.seek(this.video.currentTime + 10);
      else if (act === 'mute') this.toggleMute();
      else if (act === 'pip') this.togglePiP();
      else if (act === 'fs') this.toggleFullscreen();
      else if (act === 'speed') this.modal.querySelector('#vpSpeedMenu').classList.toggle('open');
    }

    togglePlay() {
      if (!this.video) return;
      if (this.video.paused) this.video.play(); else this.video.pause();
    }

    seek(t) {
      if (!this.video) return;
      const d = this.video.duration || 0;
      const from = this.video.currentTime;
      this.video.currentTime = Math.max(0, Math.min(d, t));
      this.showToast((t < from ? '⏪ ' : '⏩ ') + this.formatTime(this.video.currentTime));
    }

    setVolume(v) {
      if (!this.video) return;
      v = Math.max(0, Math.min(1, v));
      this.video.volume = v;
      this.video.muted = v === 0;
      this.modal.querySelector('#vpVolume').value = v;
      this.updateVolumeIcon();
      try { localStorage.setItem('aero_vp_volume', String(v)); } catch (e) {}
    }

    toggleMute() {
      if (!this.video) return;
      this.video.muted = !this.video.muted;
      this.updateVolumeIcon();
    }

    updateVolumeIcon() {
      const i = this.modal && this.modal.querySelector('#vpMuteBtn i');
      if (!i) return;
      const v = this.video.muted ? 0 : this.video.volume;
      i.className = v === 0 ? 'fas fa-volume-xmark' : v < 0.5 ? 'fas fa-volume-low' : 'fas fa-volume-high';
    }

    setSpeed(s) {
      if (!this.video) return;
      this._currentSpeed = s;
      this.video.playbackRate = s;
      this.modal.querySelector('#vpSpeedBtn').textContent = s + '×';
      this.modal.querySelectorAll('#vpSpeedMenu button').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === s));
      try { localStorage.setItem('aero_vp_speed', String(s)); } catch (e) {}
    }

    async togglePiP() {
      if (!this.video) return;
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (document.pictureInPictureEnabled) await this.video.requestPictureInPicture();
        else showToast('Picture-in-Picture not supported.', 'info');
      } catch (e) { showToast('PiP unavailable.', 'info'); }
    }

    toggleFullscreen() {
      const t = this.modal;
      if (!document.fullscreenElement) {
        (t.requestFullscreen || t.webkitRequestFullscreen || t.msRequestFullscreen || function () {}).call(t);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen || function () {}).call(document);
      }
    }

    setPlayIcon(playing) {
      const i = this.modal.querySelector('#vpPlayBtn i');
      if (i) i.className = playing ? 'fas fa-pause' : 'fas fa-play';
    }
    showCenterPlay() { const el = this.modal.querySelector('#vpCenterPlay'); if (el) el.classList.add('visible'); }
    hideCenterPlay() { const el = this.modal.querySelector('#vpCenterPlay'); if (el) el.classList.remove('visible'); }

    updateProgress() {
      if (!this.video) return;
      const d = this.video.duration || 0;
      const pct = d ? (this.video.currentTime / d) * 100 : 0;
      this.modal.querySelector('#vpFilled').style.width = pct + '%';
      this.modal.querySelector('#vpThumb').style.left = pct + '%';
      this.updateTime();
    }
    updateBuffered() {
      if (!this.video || !this.video.buffered.length) return;
      const d = this.video.duration || 0;
      if (!d) return;
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      this.modal.querySelector('#vpBuffered').style.width = (end / d) * 100 + '%';
    }
    updateTime() {
      if (!this.video) return;
      this.modal.querySelector('#vpTime').textContent =
        this.formatTime(this.video.currentTime) + ' / ' + this.formatTime(this.video.duration);
    }
    formatTime(t) {
      if (!isFinite(t) || t < 0) t = 0;
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = Math.floor(t % 60);
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      return m + ':' + String(s).padStart(2, '0');
    }

    showToast(msg) {
      const t = this.modal && this.modal.querySelector('#vpToast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.remove('show'), 700);
    }

    scheduleHideControls() {
      const c = this.modal && this.modal.querySelector('#vpControls');
      const ttl = this.modal && this.modal.querySelector('#vpTitle');
      if (!c) return;
      c.classList.remove('hidden');
      if (ttl) ttl.classList.remove('hidden');
      this.modal.style.cursor = '';
      clearTimeout(this._hideTimer);
      if (this.video && !this.video.paused) {
        this._hideTimer = setTimeout(() => {
          c.classList.add('hidden');
          if (ttl) ttl.classList.add('hidden');
          this.modal.style.cursor = 'none';
        }, 2500);
      }
    }
    showControls() {
      const c = this.modal && this.modal.querySelector('#vpControls');
      if (c) c.classList.remove('hidden');
      const ttl = this.modal && this.modal.querySelector('#vpTitle');
      if (ttl) ttl.classList.remove('hidden');
      this.modal.style.cursor = '';
    }

    renderWatermark() {
      const wm = this.modal && this.modal.querySelector('#vpWatermark');
      if (!wm) return;
      wm.style.backgroundImage = 'url("' + makeWatermarkUrl(this.username, { dark: true }) + '")';
    }

    /* ---------- Resume ---------- */
    resumeKey() { return 'aero_vp_pos_' + this.materialId; }
    saveResume() {
      if (!this.video) return;
      try {
        const d = this.video.duration || 0;
        const t = this.video.currentTime;
        if (t > 3 && t < d - 5) localStorage.setItem(this.resumeKey(), String(t));
        else if (d > 0 && t >= d - 5) localStorage.removeItem(this.resumeKey());
      } catch (e) {}
    }
    restoreResume() {
      try {
        const t = parseFloat(localStorage.getItem(this.resumeKey()) || '0');
        if (t > 3 && this.video && this.video.currentTime < 1) {
          this.video.currentTime = t;
          this.showToast('Resumed at ' + this.formatTime(t));
        }
      } catch (e) {}
    }
    setupPrefs() {
      try {
        const v = parseFloat(localStorage.getItem('aero_vp_volume') || '1');
        if (!isNaN(v)) { this.video.volume = v; this.modal.querySelector('#vpVolume').value = v; }
        const s = parseFloat(localStorage.getItem('aero_vp_speed') || '1');
        if (!isNaN(s) && s !== 1) this.setSpeed(s);
      } catch (e) {}
      this.updateVolumeIcon();
      const self = this;
      this._resumeInterval = setInterval(() => self.saveResume(), 3000);
    }

    close() {
      if (this.video) { try { this.video.pause(); } catch (e) {} this.saveResume(); }
      clearInterval(this._resumeInterval);
      clearTimeout(this._hideTimer);
      clearTimeout(this._toastTimer);
      document.removeEventListener('keydown', this._keydown, true);
      document.removeEventListener('fullscreenchange', this._fsHandler);
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      if (this.modal) this.modal.classList.remove('active');
      document.body.style.overflow = '';
      const m = this.modal;
      this.modal = null;
      this.video = null;
      setTimeout(function () { if (m) m.remove(); }, 260);
    }
  }

  /* ---------- Exports ---------- */
  window.PDFViewer   = new PDFViewer();
  window.VideoPlayer = new VideoPlayer();
})();