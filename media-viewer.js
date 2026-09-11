/* ============================================================
   AEROSPACE MEDIA VIEWER v2 — PDF + Video
   Self-contained. No dependencies except pdfjsLib (loaded in HTML).
   ============================================================ */
(function () {
  'use strict';

  if (window.__AERO_MEDIA_VIEWER_LOADED__) return;
  window.__AERO_MEDIA_VIEWER_LOADED__ = true;

  /* ---------- Utilities ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, function (c) {
      return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c];
    });
  }

  function makeWatermarkUrl(text, opts) {
    opts = opts || {};
    const color = opts.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
    const size  = opts.size  || 22;
    const angle = opts.angle || -28;
    const tile  = opts.tile  || 420;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + tile + '" height="' + tile + '">' +
        '<text x="50%" y="50%" font-family="Inter,Arial,sans-serif" font-size="' + size + '" ' +
        'font-weight="700" fill="' + color + '" text-anchor="middle" ' +
        'transform="rotate(' + angle + ' ' + (tile / 2) + ' ' + (tile / 2) + ')">' +
          escapeXml(text) +
        '</text>' +
      '</svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
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
    yellow: 'rgba(253,224,71,0.55)',
    green:  'rgba(52,211,153,0.50)',
    blue:   'rgba(96,165,250,0.50)',
    pink:   'rgba(244,114,182,0.50)',
    orange: 'rgba(251,146,60,0.55)'
  };

  /* ============================================================
     PDF VIEWER
     ============================================================ */
  class PDFViewer {
    constructor() {
      this._init();
    }

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

      this._onSelectionChange = this._onSelectionChange.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
      this._onBodyScroll = this._onBodyScroll.bind(this);
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
      } catch (e) { /* ignore */ }

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
        const dataURL = String(opts.data || '').indexOf('data:') === 0
          ? opts.data
          : 'data:application/pdf;base64,' + opts.data;
        const bytes = dataURLToBytes(dataURL);
        const task = pdfjsLib.getDocument({ data: bytes });
        this.pdfDoc = await task.promise;
        await this._renderAllPages();
        this.loaderEl.style.display = 'none';
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

    /* ---------- UI construction ---------- */
    _buildUI() {
      const old = document.getElementById('pdfViewerModal');
      if (old) old.remove();

      const el = document.createElement('div');
      el.id = 'pdfViewerModal';
      el.className = 'pdf-viewer-modal';

      const colorBtns = Object.keys(HL_COLORS).map(function (c) {
        return '<button class="pdfv-color ' + c + '" data-color="' + c +
               '" title="' + c + '" type="button"></button>';
      }).join('');

      el.innerHTML =
        '<div class="pdfv-shell">' +
          '<div class="pdfv-toolbar">' +

            '<div class="pdfv-toolbar-left">' +
              '<button type="button" class="pdfv-btn" data-act="close" title="Close (Esc)"><i class="fas fa-times"></i></button>' +
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

      this.modal    = el;
      this.bodyEl   = el.querySelector('#pdfvBody');
      this.pagesEl  = el.querySelector('#pdfvPages');
      this.selMenu  = el.querySelector('#pdfvSelMenu');
      this.loaderEl = el.querySelector('#pdfvLoader');

      const self = this;

      // Toolbar buttons
      el.querySelectorAll('.pdfv-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { self._handleToolbar(btn.dataset.act); });
      });

      // Color buttons
      el.querySelectorAll('.pdfv-color').forEach(function (btn) {
        btn.addEventListener('click', function () { self._setColor(btn.dataset.color); });
      });
      this._setColor('yellow');

      // Page input
      const pageInput = el.querySelector('#pdfvPageInput');
      pageInput.addEventListener('change', function () {
        const n = parseInt(pageInput.value, 10);
        if (n >= 1 && self.pdfDoc && n <= self.pdfDoc.numPages) self._scrollToPage(n);
      });

      // Selection floating menu
      this.selMenu.addEventListener('mousedown', function (e) { e.preventDefault(); });
      this.selMenu.addEventListener('click', function (e) {
        const b = e.target.closest('.pdfv-sel-btn');
        if (!b) return;
        if (b.dataset.act === 'highlight') self._createHighlight();
        else if (b.dataset.act === 'copy') self._copySelection();
      });

      // Document-level listeners (removed on close)
      document.addEventListener('selectionchange', this._onSelectionChange);
      document.addEventListener('keydown', this._onKeyDown, true);
      this.bodyEl.addEventListener('scroll', this._onBodyScroll, { passive: true });

      // Block right-click & drag
      this.bodyEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      this.bodyEl.addEventListener('dragstart', function (e) { e.preventDefault(); });

      // Click on highlight → delete
      this.pagesEl.addEventListener('click', function (e) {
        const mark = e.target.closest('mark.pdf-hl');
        if (!mark) return;
        e.stopPropagation();
        self._deleteHighlight(mark.dataset.hlId);
      });

      // Backdrop click closes
      el.addEventListener('click', function (e) {
        if (e.target === el) self.close();
      });
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
      this.modal.querySelectorAll('.pdfv-color').forEach(function (b) {
        b.classList.toggle('active', b.dataset.color === c);
      });
    }

    /* ---------- Rendering ---------- */
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

      for (let i = 1; i <= total; i++) {
        await this._renderPage(i);
      }
      this._applyAllHighlights();
    }

    async _renderPage(n) {
      const page = await this.pdfDoc.getPage(n);
      const viewport = page.getViewport({ scale: this.scale });
      const pageEl = this.pageEls.get(n);
      if (!pageEl) return;

      pageEl.innerHTML = '';
      pageEl.style.width = viewport.width + 'px';
      pageEl.style.height = viewport.height + 'px';

      // ---- Canvas ----
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      canvas.className = 'pdfv-canvas';
      pageEl.appendChild(canvas);

      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport: viewport
      }).promise;

      // ---- Text layer ----
      const textLayer = document.createElement('div');
      textLayer.className = 'pdfv-textlayer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';
      pageEl.appendChild(textLayer);

      const textContent = await page.getTextContent();

      // PDF.js 3.11.x uses `textContentSource`; older 3.x used `textContent`.
      // We pass BOTH defensively.
      let task;
      try {
        task = pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          textContent: textContent,
          container: textLayer,
          viewport: viewport,
          textDivs: []
        });
      } catch (e) {
        task = pdfjsLib.renderTextLayer({
          textContent: textContent,
          container: textLayer,
          viewport: viewport,
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
      this.pageEls.forEach(function (el, page) {
        if (el.offsetTop - 60 <= scrollTop) current = page;
      });
      this.currentPage = current;
      const inp = this.modal.querySelector('#pdfvPageInput');
      if (inp && document.activeElement !== inp) inp.value = current;
    }

    /* ---------- Zoom ---------- */
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

    /* ---------- Selection ---------- */
    _onSelectionChange() {
      if (!this.active) return;
      const self = this;
      clearTimeout(this._selTimer);
      this._selTimer = setTimeout(function () { self._computeSelection(); }, 10);
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

      this.pendingSel = { textLayer: textLayer };

      // Measure menu
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

    /* ---------- Highlight creation ---------- */
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

      // Reject overlap
      const pageHls = this.highlights.filter(function (h) { return h.page === pageNum; });
      for (let i = 0; i < pageHls.length; i++) {
        if (start < pageHls[i].end && end > pageHls[i].start) {
          return userToast('Overlaps an existing highlight.', 'error');
        }
      }

      this.highlights.push({
        id: uid(),
        page: pageNum,
        start: start,
        end: end,
        text: text,
        color: this.color,
        createdAt: Date.now()
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
            function () { userToast('Copied to clipboard.', 'success'); },
            function () { self._fallbackCopy(text); }
          );
        } else {
          this._fallbackCopy(text);
        }
      } catch (e) { this._fallbackCopy(text); }
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
        userToast(ok ? 'Copied to clipboard.' : 'Copy failed.', ok ? 'success' : 'error');
      } catch (e) { userToast('Copy failed.', 'error'); }
    }

    _deleteHighlight(id) {
      const idx = this.highlights.findIndex(function (h) { return h.id === id; });
      if (idx === -1) return;
      const hl = this.highlights[idx];
      if (!confirm('Remove this highlight?')) return;
      this.highlights.splice(idx, 1);
      this._saveHighlights();
      this._applyPageHighlights(hl.page);
      this._updateHlCount();
    }

    _clearPageHighlights(pageNum) {
      const list = this.highlights.filter(function (h) { return h.page === pageNum; });
      if (list.length === 0) return userToast('No highlights on this page.', 'info');
      if (!confirm('Remove ' + list.length + ' highlight(s) on this page?')) return;
      this.highlights = this.highlights.filter(function (h) { return h.page !== pageNum; });
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

    /* ---------- Storage ---------- */
    _storageKey() { return 'aero_pdf_hl_' + this.materialId; }

    _loadHighlights() {
      try {
        const raw = localStorage.getItem(this._storageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        this.highlights = Array.isArray(parsed) ? parsed : [];
      } catch (e) { this.highlights = []; }
    }

    _saveHighlights() {
      try {
        localStorage.setItem(this._storageKey(), JSON.stringify(this.highlights));
      } catch (e) { console.warn('[PDFViewer] save failed', e); }
    }

    _updateHlCount() {
      if (!this.modal) return;
      const el = this.modal.querySelector('#pdfvHlCount');
      if (!el) return;
      const n = this.highlights.length;
      el.textContent = n > 0 ? '· ' + n + ' highlight' + (n === 1 ? '' : 's') : '';
    }

    /* ---------- Highlight painting ---------- */
    _applyAllHighlights() {
      const self = this;
      this.textLayers.forEach(function (_, n) { self._applyPageHighlights(n); });
    }

    _applyPageHighlights(pageNum) {
      const pageEl = this.pageEls.get(pageNum);
      const textLayer = this.textLayers.get(pageNum);
      if (!pageEl || !textLayer) return;

      // Unwrap existing marks
      pageEl.querySelectorAll('mark.pdf-hl').forEach(function (mark) {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      try { textLayer.normalize(); } catch (e) { /* ignore */ }

      const list = this.highlights.filter(function (h) { return h.page === pageNum; });
      if (list.length === 0) return;

      // Apply rightmost first (offsets stay valid while we split nodes)
      list.sort(function (a, b) { return b.start - a.start; });
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

      const targets = nodes.filter(function (t) { return t.end > start && t.start < end; });
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

    /* ---------- Watermark ---------- */
    _renderWatermark() {
      if (!this.modal) return;
      const wm = this.modal.querySelector('#pdfvWatermark');
      if (!wm) return;
      const text = this.username + '  ·  ' + new Date().toISOString().slice(0, 10);
      wm.style.backgroundImage = makeWatermarkUrl(text, { size: 20, angle: -28, tile: 400 });
    }

    /* ---------- Keyboard ---------- */
    _onKeyDown(e) {
      if (!this.active) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p')) {
        e.preventDefault(); e.stopPropagation();
      }
    }

    /* ---------- Close ---------- */
    close() {
      if (!this.active) return;
      this.active = false;
      clearTimeout(this._selTimer);

      document.removeEventListener('selectionchange', this._onSelectionChange);
      document.removeEventListener('keydown', this._onKeyDown, true);
      if (this.bodyEl) this.bodyEl.removeEventListener('scroll', this._onBodyScroll);

      document.body.style.overflow = this._prevBodyOverflow || '';

      const m = this.modal;
      if (m) {
        m.classList.remove('active');
        setTimeout(function () { try { m.remove(); } catch (e) {} }, 240);
      }

      this.pdfDoc = null;
      this.pageEls.clear();
      this.textLayers.clear();
      this.pendingSel = null;

      // Reset for a fresh open
      const saved = this.materialId;
      this._init();
      this.materialId = saved;
    }
  }

  /* ============================================================
     VIDEO PLAYER
     ============================================================ */
  class VideoPlayer {
    constructor() {
      this._init();
    }

    _init() {
      this.active = false;
      this.modal = null;
      this.video = null;
      this.materialId = null;
      this.username = '';
      this.title = '';
      this._hideTimer = null;
      this._toastTimer = null;
      this._resumeTimer = null;
      this._prevBodyOverflow = '';
      this._isYouTube = false;
      this._dragSeeking = false;
      this._onDocClick = null;

      this._onKeyDown = this._onKeyDown.bind(this);
      this._onFsChange = this._onFsChange.bind(this);
    }

    _parseYouTube(url) {
      if (!url) return null;
      const m = String(url).match(
        /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
      );
      return m ? m[1] : null;
    }

    open(opts) {
      if (this.active) return;
      this.active = true;

      this.materialId = opts.materialId || 'video';
      this.username   = opts.username || 'Student';
      this.title      = opts.title || 'Video';
      this._prevBodyOverflow = document.body.style.overflow;

      const src = String(opts.src || '').trim();
      const ytId = this._parseYouTube(src);

      if (ytId) {
        this._openYouTube(ytId);
      } else if (/^https?:\/\//i.test(src) || src.indexOf('data:') === 0 || src.indexOf('blob:') === 0) {
        this._openDirect(src, opts.poster);
      } else {
        this.active = false;
        userToast('Invalid or missing video URL.', 'error');
      }
    }

    _openYouTube(ytId) {
      this._isYouTube = true;
      const src = 'https://www.youtube.com/embed/' + ytId +
        '?rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&fs=1';

      this._buildModal(
        '<iframe class="vp-iframe" frameborder="0" allowfullscreen ' +
        'src="' + src + '" ' +
        'allow="autoplay; encrypted-media; picture-in-picture; fullscreen" ' +
        'referrerpolicy="strict-origin-when-cross-origin"></iframe>'
      );
      this._renderWatermark();
      document.addEventListener('keydown', this._onKeyDown, true);
    }

    _openDirect(src, poster) {
      const self = this;
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
      const speedHtml = speeds.map(function (s) {
        return '<button type="button" data-speed="' + s + '"' +
               (s === 1 ? ' class="active"' : '') + '>' + s + '×</button>';
      }).join('');

      const posterAttr = poster ? ' poster="' + this._esc(poster) + '"' : '';

      const html =
        '<video id="vpVideo" playsinline preload="metadata" ' +
        'controlslist="nodownload noplaybackrate noremoteplayback"' +
        posterAttr + '></video>' +

        '<div class="vp-watermark" id="vpWatermark"></div>' +
        '<div class="vp-title" id="vpTitle">' + this._esc(this.title) + '</div>' +
        '<button type="button" class="vp-center-play" id="vpCenterPlay"><i class="fas fa-play"></i></button>' +
        '<div class="vp-toast" id="vpToast"></div>' +

        '<div class="vp-controls" id="vpControls">' +

          '<div class="vp-progress-row" id="vpProgress">' +
            '<div class="vp-progress-bg"></div>' +
            '<div class="vp-progress-buffered" id="vpBuffered"></div>' +
            '<div class="vp-progress-filled" id="vpFilled"></div>' +
            '<div class="vp-thumb" id="vpThumb"></div>' +
            '<div class="vp-tooltip" id="vpTooltip">0:00</div>' +
          '</div>' +

          '<div class="vp-buttons">' +
            '<button type="button" class="vp-btn" data-act="back" title="Back 10s (J)"><i class="fas fa-rotate-left"></i></button>' +
            '<button type="button" class="vp-btn" data-act="play" id="vpPlayBtn" title="Play/Pause (Space)"><i class="fas fa-play"></i></button>' +
            '<button type="button" class="vp-btn" data-act="fwd" title="Forward 10s (L)"><i class="fas fa-rotate-right"></i></button>' +
            '<span class="vp-time" id="vpTime">0:00 / 0:00</span>' +
            '<div class="vp-spacer"></div>' +
            '<div class="vp-volume-wrap">' +
              '<button type="button" class="vp-btn" data-act="mute" id="vpMuteBtn" title="Mute (M)"><i class="fas fa-volume-high"></i></button>' +
              '<div class="vp-volume"><input type="range" id="vpVolume" min="0" max="1" step="0.05" value="1"></div>' +
            '</div>' +
            '<div class="vp-speed-wrap">' +
              '<button type="button" class="vp-speed-btn" data-act="speed" id="vpSpeedBtn" title="Playback speed">1×</button>' +
              '<div class="vp-speed-menu" id="vpSpeedMenu">' + speedHtml + '</div>' +
            '</div>' +
            '<button type="button" class="vp-btn" data-act="pip" id="vpPipBtn" title="Picture-in-Picture (P)"><i class="fas fa-clone"></i></button>' +
            '<button type="button" class="vp-btn" data-act="fs" id="vpFsBtn" title="Fullscreen (F)"><i class="fas fa-expand"></i></button>' +
          '</div>' +

        '</div>';

      this._buildModal(html);

      this.video = this.modal.querySelector('#vpVideo');
      this.video.src = src;
      this._renderWatermark();
      this._wireVideo();
      this._loadPrefs();

      const p = this.video.play();
      if (p && p.catch) p.catch(function () { self._showCenterPlay(); });

      document.addEventListener('keydown', this._onKeyDown, true);
      document.addEventListener('fullscreenchange', this._onFsChange);
      document.addEventListener('webkitfullscreenchange', this._onFsChange);
    }

    _esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c];
      });
    }

    _buildModal(inner) {
      const old = document.getElementById('videoPlayerModal');
      if (old) old.remove();

      const el = document.createElement('div');
      el.id = 'videoPlayerModal';
      el.className = 'video-player-modal';
      el.innerHTML = '<div class="vp-shell">' + inner + '</div>';
      document.body.appendChild(el);

      this.modal = el;
      el.classList.add('active');
      document.body.style.overflow = 'hidden';

      const self = this;
      el.addEventListener('click', function (e) { if (e.target === el) self.close(); });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    _wireVideo() {
      const self = this;
      const v = this.video;
      if (!v || !this.modal) return;

      v.addEventListener('timeupdate', function () { self._updateProgress(); });
      v.addEventListener('loadedmetadata', function () {
        self._updateProgress(); self._updateTime(); self._restoreResume();
      });
      v.addEventListener('play', function () {
        self._setPlayIcon(true); self._hideCenterPlay(); self._scheduleHideControls();
      });
      v.addEventListener('pause', function () {
        self._setPlayIcon(false); self._showCenterPlay(); self._showControls();
        clearTimeout(self._hideTimer); self._saveResume();
      });
      v.addEventListener('ended', function () {
        self._setPlayIcon(false); self._showCenterPlay(); self._saveResume();
      });
      v.addEventListener('progress', function () { self._updateBuffered(); });
      v.addEventListener('volumechange', function () { self._updateVolumeIcon(); });
      v.addEventListener('error', function () {
        userToast('Could not play this video. Check the URL or format.', 'error');
      });
      v.addEventListener('dblclick', function () { self._toggleFullscreen(); });
      v.addEventListener('click', function () {
        if (!self._dragSeeking) self._togglePlay();
      });

      // Buttons
      this.modal.querySelectorAll('.vp-btn, .vp-speed-btn').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          self._handleAction(b.dataset.act);
        });
      });

      // Center play button
      const centerPlay = this.modal.querySelector('#vpCenterPlay');
      if (centerPlay) {
        centerPlay.addEventListener('click', function (e) {
          e.stopPropagation();
          self._togglePlay();
        });
      }

      // Progress bar
      const progress = this.modal.querySelector('#vpProgress');
      const getPct = function (e) {
        const r = progress.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      };
      const preview = function (e) {
        const pct = getPct(e);
        self.modal.querySelector('#vpFilled').style.width = (pct * 100) + '%';
        self.modal.querySelector('#vpThumb').style.left   = (pct * 100) + '%';
        const tip = self.modal.querySelector('#vpTooltip');
        tip.style.left = (pct * 100) + '%';
        tip.textContent = self._formatTime(pct * (v.duration || 0));
        return pct;
      };
      progress.addEventListener('mousemove', preview);
      progress.addEventListener('mousedown', function (e) {
        e.preventDefault();
        self._dragSeeking = true;
        let lastPct = preview(e);
        const onMove = function (ev) { lastPct = preview(ev); };
        const onUp = function () {
          if (v.duration) v.currentTime = lastPct * v.duration;
          self._dragSeeking = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Volume
      const vol = this.modal.querySelector('#vpVolume');
      vol.addEventListener('input', function () { self._setVolume(parseFloat(vol.value)); });

      // Speed menu
      const speedMenu = this.modal.querySelector('#vpSpeedMenu');
      speedMenu.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          self._setSpeed(parseFloat(b.dataset.speed));
          speedMenu.classList.remove('open');
        });
      });
      this._onDocClick = function (e) {
        if (!e.target.closest('.vp-speed-wrap')) speedMenu.classList.remove('open');
      };
      document.addEventListener('click', this._onDocClick);

      // Auto-hide controls
      this.modal.addEventListener('mousemove', function () { self._scheduleHideControls(); });
      this.modal.addEventListener('touchstart', function () { self._scheduleHideControls(); }, { passive: true });

      // Periodic resume save
      this._resumeTimer = setInterval(function () { self._saveResume(); }, 3000);
    }

    _handleAction(act) {
      if (act === 'play') this._togglePlay();
      else if (act === 'back') this._seek((this.video ? this.video.currentTime : 0) - 10);
      else if (act === 'fwd')  this._seek((this.video ? this.video.currentTime : 0) + 10);
      else if (act === 'mute') this._toggleMute();
      else if (act === 'pip')  this._togglePiP();
      else if (act === 'fs')   this._toggleFullscreen();
      else if (act === 'speed') {
        const menu = this.modal.querySelector('#vpSpeedMenu');
        if (menu) menu.classList.toggle('open');
      }
    }

    _togglePlay() {
      if (!this.video) return;
      if (this.video.paused) {
        const p = this.video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        this.video.pause();
      }
    }

    _seek(t) {
      if (!this.video) return;
      const d = this.video.duration || 0;
      const from = this.video.currentTime;
      this.video.currentTime = Math.max(0, Math.min(d, t));
      this._flashToast((t < from ? '⏪ ' : '⏩ ') + this._formatTime(this.video.currentTime));
    }

    _setVolume(v) {
      if (!this.video) return;
      v = Math.max(0, Math.min(1, v));
      this.video.volume = v;
      if (v > 0) this.video.muted = false;
      const volEl = this.modal.querySelector('#vpVolume');
      if (volEl) volEl.value = v;
      this._updateVolumeIcon();
      try { localStorage.setItem('aero_vp_volume', String(v)); } catch (e) {}
    }

    _toggleMute() {
      if (!this.video) return;
      this.video.muted = !this.video.muted;
      this._updateVolumeIcon();
    }

    _updateVolumeIcon() {
      if (!this.modal || !this.video) return;
      const i = this.modal.querySelector('#vpMuteBtn i');
      if (!i) return;
      const v = this.video.muted ? 0 : this.video.volume;
      i.className = v === 0
        ? 'fas fa-volume-xmark'
        : v < 0.5
          ? 'fas fa-volume-low'
          : 'fas fa-volume-high';
    }

    _setSpeed(s) {
      if (!this.video) return;
      this.video.playbackRate = s;
      const btn = this.modal.querySelector('#vpSpeedBtn');
      if (btn) btn.textContent = s + '×';
      this.modal.querySelectorAll('#vpSpeedMenu button').forEach(function (b) {
        b.classList.toggle('active', parseFloat(b.dataset.speed) === s);
      });
      try { localStorage.setItem('aero_vp_speed', String(s)); } catch (e) {}
    }

    async _togglePiP() {
      if (!this.video) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled) {
          await this.video.requestPictureInPicture();
        } else {
          userToast('Picture-in-Picture not supported.', 'info');
        }
      } catch (e) {
        userToast('Picture-in-Picture unavailable.', 'info');
      }
    }

    _toggleFullscreen() {
      const target = this.modal;
      if (!target) return;
      if (!document.fullscreenElement) {
        const req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
        if (req) {
          const p = req.call(target);
          if (p && p.catch) p.catch(function () {});
        }
      } else {
        const ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
        if (ex) {
          const p = ex.call(document);
          if (p && p.catch) p.catch(function () {});
        }
      }
    }

    _onFsChange() {
      if (!this.modal) return;
      const btn = this.modal.querySelector('#vpFsBtn i');
      if (btn) btn.className = document.fullscreenElement ? 'fas fa-compress' : 'fas fa-expand';
    }

    _setPlayIcon(playing) {
      if (!this.modal) return;
      const i = this.modal.querySelector('#vpPlayBtn i');
      if (i) i.className = playing ? 'fas fa-pause' : 'fas fa-play';
    }
    _showCenterPlay() {
      if (!this.modal) return;
      const el = this.modal.querySelector('#vpCenterPlay');
      if (el) el.classList.add('visible');
    }
    _hideCenterPlay() {
      if (!this.modal) return;
      const el = this.modal.querySelector('#vpCenterPlay');
      if (el) el.classList.remove('visible');
    }

    _updateProgress() {
      if (!this.video || !this.modal) return;
      const d = this.video.duration || 0;
      const pct = d ? (this.video.currentTime / d) * 100 : 0;
      const filled = this.modal.querySelector('#vpFilled');
      const thumb = this.modal.querySelector('#vpThumb');
      if (filled) filled.style.width = pct + '%';
      if (thumb) thumb.style.left = pct + '%';
      this._updateTime();
    }
    _updateBuffered() {
      if (!this.video || !this.modal) return;
      if (!this.video.buffered || !this.video.buffered.length) return;
      const d = this.video.duration || 0;
      if (!d) return;
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      const buf = this.modal.querySelector('#vpBuffered');
      if (buf) buf.style.width = (end / d) * 100 + '%';
    }
    _updateTime() {
      if (!this.video || !this.modal) return;
      const el = this.modal.querySelector('#vpTime');
      if (el) el.textContent =
        this._formatTime(this.video.currentTime) + ' / ' + this._formatTime(this.video.duration);
    }
    _formatTime(t) {
      if (!isFinite(t) || t < 0) t = 0;
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = Math.floor(t % 60);
      return h > 0
        ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
        : m + ':' + String(s).padStart(2, '0');
    }

    _flashToast(msg) {
      if (!this.modal) return;
      const t = this.modal.querySelector('#vpToast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      const self = this;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () { t.classList.remove('show'); }, 700);
    }

    _scheduleHideControls() {
      if (!this.modal) return;
      this._showControls();
      const self = this;
      clearTimeout(this._hideTimer);
      if (this.video && !this.video.paused) {
        this._hideTimer = setTimeout(function () {
          if (!self.modal) return;
          const c = self.modal.querySelector('#vpControls');
          const t = self.modal.querySelector('#vpTitle');
          if (c) c.classList.add('hidden');
          if (t) t.classList.add('hidden');
          self.modal.style.cursor = 'none';
        }, 2500);
      }
    }
    _showControls() {
      if (!this.modal) return;
      const c = this.modal.querySelector('#vpControls');
      const t = this.modal.querySelector('#vpTitle');
      if (c) c.classList.remove('hidden');
      if (t) t.classList.remove('hidden');
      this.modal.style.cursor = '';
    }

    _renderWatermark() {
      if (!this.modal) return;
      const wm = this.modal.querySelector('#vpWatermark');
      if (!wm) return;
      const text = this.username + '  ·  ' + new Date().toISOString().slice(0, 10);
      wm.style.backgroundImage = makeWatermarkUrl(text, { dark: true, size: 22, angle: -30, tile: 400 });
    }

    /* ---------- Resume ---------- */
    _resumeKey() { return 'aero_vp_pos_' + this.materialId; }
    _saveResume() {
      if (!this.video) return;
      try {
        const d = this.video.duration || 0;
        const t = this.video.currentTime;
        if (t > 3 && t < d - 5) localStorage.setItem(this._resumeKey(), String(t));
        else if (d > 0 && t >= d - 5) localStorage.removeItem(this._resumeKey());
      } catch (e) {}
    }
    _restoreResume() {
      try {
        const t = parseFloat(localStorage.getItem(this._resumeKey()) || '0');
        if (t > 3 && this.video && this.video.currentTime < 1) {
          this.video.currentTime = t;
          this._flashToast('Resumed at ' + this._formatTime(t));
        }
      } catch (e) {}
    }
    _loadPrefs() {
      if (!this.video) return;
      try {
        const v = parseFloat(localStorage.getItem('aero_vp_volume') || '1');
        if (!isNaN(v)) {
          this.video.volume = v;
          const vol = this.modal.querySelector('#vpVolume');
          if (vol) vol.value = v;
        }
        const s = parseFloat(localStorage.getItem('aero_vp_speed') || '1');
        if (!isNaN(s) && s !== 1) this._setSpeed(s);
      } catch (e) {}
      this._updateVolumeIcon();
    }

    /* ---------- Keyboard ---------- */
    _onKeyDown(e) {
      if (!this.active) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'Escape') {
        if (!document.fullscreenElement) { e.preventDefault(); this.close(); }
        return;
      }
      if (!this.video) return;

      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); this._togglePlay(); }
      else if (e.key === 'ArrowRight' || e.key === 'l') this._seek(this.video.currentTime + 10);
      else if (e.key === 'ArrowLeft'  || e.key === 'j') this._seek(this.video.currentTime - 10);
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this._setVolume(Math.min(1, this.video.volume + 0.1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this._setVolume(Math.max(0, this.video.volume - 0.1)); }
      else if (e.key === 'm') this._toggleMute();
      else if (e.key === 'f') this._toggleFullscreen();
      else if (e.key === 'p') this._togglePiP();
      else if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); }
    }

    /* ---------- Close ---------- */
    close() {
      if (!this.active) return;
      this.active = false;

      clearInterval(this._resumeTimer);
      clearTimeout(this._hideTimer);
      clearTimeout(this._toastTimer);

      if (this.video) {
        try { this.video.pause(); } catch (e) {}
        this._saveResume();
      }

      document.removeEventListener('keydown', this._onKeyDown, true);
      document.removeEventListener('fullscreenchange', this._onFsChange);
      document.removeEventListener('webkitfullscreenchange', this._onFsChange);
      if (this._onDocClick) document.removeEventListener('click', this._onDocClick);

      if (document.fullscreenElement) {
        const ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
        if (ex) { const p = ex.call(document); if (p && p.catch) p.catch(function () {}); }
      }

      document.body.style.overflow = this._prevBodyOverflow || '';

      const m = this.modal;
      if (m) {
        m.classList.remove('active');
        setTimeout(function () { try { m.remove(); } catch (e) {} }, 240);
      }

      const savedId = this.materialId;
      this._init();
      this.materialId = savedId;
    }
  }

  /* ---------- Expose as singletons ---------- */
  window.PDFViewer   = new PDFViewer();
  window.VideoPlayer = new VideoPlayer();

  console.log('[AeroMediaViewer] Ready');
})();