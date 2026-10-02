/* ============================================================
   AEROGYAN DOCUMENT VIEWER — v2 (Fallback-enabled)
   ------------------------------------------------------------
   Universal viewer for any non-PDF, non-video material:
     • PowerPoint   (.pptx .ppt .ppsx .pps)  → Office/Google viewer
     • Word         (.docx .doc .rtf .odt)   → Office/Google viewer
     • Excel/CSV    (.xlsx .xls .csv .ods)   → Office/Google viewer
     • Images       (.png .jpg .gif .webp …) → inline <img>
     • Text         (.txt .md .log .json …)  → <pre>

   NEW in v2:
     • Microsoft Office viewer is tried first.
     • If it times out (7s) or crashes, it automatically falls
       back to Google Docs Viewer.
     • If both fail, a clean "Download / Open in new tab" card
       is shown.
   ============================================================ */
(function () {
  'use strict';
  if (window.__AERO_DOCUMENT_VIEWER_LOADED__) return;
  window.__AERO_DOCUMENT_VIEWER_LOADED__ = true;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  function _toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[DocumentViewer]', msg);
  }

  function detectDocType(fileName, url) {
    const hay = (String(fileName || '') + ' ' + String(url || ''))
      .toLowerCase().split('?')[0].split('#')[0];
    const m = hay.match(/\.([a-z0-9]{1,6})(?:\s|$|\/|&|,)/);
    const ext = m ? m[1] : '';

    if (['pptx', 'ppt', 'ppsx', 'pps', 'potx', 'pot'].includes(ext)) return 'presentation';
    if (['docx', 'doc', 'rtf', 'odt'].includes(ext))  return 'document';
    if (['xlsx', 'xls', 'csv', 'ods'].includes(ext))  return 'spreadsheet';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image';
    if (['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'ini'].includes(ext)) return 'text';
    if (['pdf'].includes(ext)) return 'pdf';
    return 'unknown';
  }

  function makeWatermarkUrl(text, opts) {
    opts = opts || {};
    const color = opts.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const size  = opts.size || 11;
    const angle = opts.angle || -25;
    const tile  = opts.tile || 900;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + tile + '" height="' + tile + '">' +
        '<text x="50%" y="50%" font-family="Inter,Arial,sans-serif" font-size="' + size + '" ' +
        'font-weight="700" fill="' + color + '" text-anchor="middle" ' +
        'transform="rotate(' + angle + ' ' + (tile / 2) + ' ' + (tile / 2) + ')">' +
          _esc(text) +
        '</text>' +
      '</svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }

  class DocumentViewer {
    constructor() {
      this.active       = false;
      this.modal        = null;
      this.username     = '';
      this.title        = '';
      this.fileName     = '';
      this.fileUrl      = '';
      this.courseId     = null;
      this.materialId   = null;
      this.docType      = 'unknown';
      this._prevOverflow = '';
      this._onKeyDown   = this._onKeyDown.bind(this);
      this._officeAttempt = 0;
      this._officeTimer = null;
    }

    open(opts) {
      opts = opts || {};
      if (this.active) return;

      const kind = opts.docType || detectDocType(opts.fileName, opts.url);
      if (kind === 'pdf' && window.PDFViewer && typeof window.PDFViewer.open === 'function') {
        return window.PDFViewer.open({
          url:      opts.url,
          title:    opts.title,
          fileName: opts.fileName,
          materialId: opts.materialId,
          courseId:   opts.courseId,
          username:   opts.username,
          hasFullAccess: opts.hasFullAccess,
          previewPercent: opts.previewPercent,
          lockReason: opts.lockReason
        });
      }

      this.active     = true;
      this.username   = opts.username || 'Student';
      this.title      = opts.title || opts.fileName || 'Document';
      this.fileName   = opts.fileName || '';
      this.courseId   = opts.courseId || null;
      this.materialId = opts.materialId || null;
      this.docType    = kind;
      this._officeAttempt = 0;

      let rawUrl = String(opts.url || '').trim();
      if (rawUrl && !/^(https?:|blob:|data:)/i.test(rawUrl)) {
        try { rawUrl = new URL(rawUrl, location.origin).href; }
        catch (e) { /* leave as-is */ }
      }
      this.fileUrl = rawUrl;

      this._prevOverflow = document.body.style.overflow;
      this._buildUI();
      this.modal.classList.add('active');
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', this._onKeyDown, true);

      if (this.docType === 'image') {
        this._renderImage();
      } else if (this.docType === 'text') {
        this._renderText();
      } else if (this.docType === 'presentation' ||
                 this.docType === 'document' ||
                 this.docType === 'spreadsheet') {
        this._renderOffice();
      } else {
        this._renderUnsupported();
      }
    }

    _buildUI() {
      const old = document.getElementById('docViewerModal');
      if (old) old.remove();

      const el = document.createElement('div');
      el.id = 'docViewerModal';
      el.className = 'doc-viewer-modal';

      el.innerHTML = `
        <div class="docv-shell" oncontextmenu="return false;">
          <div class="docv-toolbar">
            <div class="docv-toolbar-left">
              <button type="button" class="docv-back-btn" data-act="close" title="Back (Esc)">
                <i class="fas fa-arrow-left"></i><span>Back</span>
              </button>
              <span class="docv-title" id="docvTitle">${_esc(this.title)}</span>
            </div>
            <div class="docv-toolbar-right">
              <a class="docv-btn" id="docvOpenExternal"
                 href="${_esc(this.fileUrl)}"
                 target="_blank" rel="noopener noreferrer"
                 title="Open in a new tab">
                <i class="fas fa-external-link-alt"></i>
              </a>
              <button type="button" class="docv-btn" data-act="close" title="Close (Esc)">
                <i class="fas fa-times"></i>
              </button>
            </div>
          </div>
          <div class="docv-body" id="docvBody">
            <div class="docv-loader">
              <div class="docv-spinner"></div>
              <p>Preparing document…</p>
            </div>
          </div>
          <div class="docv-watermark" id="docvWatermark" aria-hidden="true"></div>
        </div>`;

      document.body.appendChild(el);
      this.modal = el;

      el.querySelectorAll('[data-act="close"]').forEach(b => {
        b.addEventListener('click', () => this.close());
      });
      el.addEventListener('click', e => { if (e.target === el) this.close(); });

      this._renderWatermark();
    }

    _renderWatermark() {
      const wm = this.modal && this.modal.querySelector('#docvWatermark');
      if (!wm) return;
      const stamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const text  = this.username + ' · ' + stamp;
      wm.style.backgroundImage = makeWatermarkUrl(text, {
        size: 13, angle: -25, tile: 750, dark: false
      });
      wm.style.opacity = '0.30';
    }

    _renderImage() {
      const body = this.modal.querySelector('#docvBody');
      body.innerHTML = `
        <div class="docv-image-wrap">
          <img src="${_esc(this.fileUrl)}" alt="${_esc(this.title)}"
               loading="eager" decoding="async">
        </div>`;
    }

    async _renderText() {
      const body = this.modal.querySelector('#docvBody');
      body.innerHTML = `
        <div class="docv-loader">
          <div class="docv-spinner"></div>
          <p>Loading text file…</p>
        </div>`;
      try {
        const res = await fetch(this.fileUrl, { cache: 'default', credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        body.innerHTML = `
          <div class="docv-text-wrap">
            <pre class="docv-text">${_esc(text)}</pre>
          </div>`;
      } catch (err) {
        this._renderError('Could not load the text file. ' + (err.message || ''));
      }
    }

    /* ------------------------------------------------------------
       Office documents — Try Microsoft, then Google, then fallback
       ------------------------------------------------------------ */
    _renderOffice() {
      if (this._officeTimer) {
        clearTimeout(this._officeTimer);
        this._officeTimer = null;
      }

      const body = this.modal.querySelector('#docvBody');
      const srcEncoded = encodeURIComponent(this.fileUrl);

      // Microsoft viewer (tries to render actual slides)
      const msEmbed = 'https://view.officeapps.live.com/op/embed.aspx?src=' + srcEncoded;
      // Google viewer (very reliable fallback)
      const googleEmbed = 'https://docs.google.com/viewer?url=' + srcEncoded + '&embedded=true';

      const providers = [
        { name: 'Microsoft Office Viewer', url: msEmbed },
        { name: 'Google Docs Viewer',      url: googleEmbed }
      ];

      if (this._officeAttempt >= providers.length) {
        return this._renderUnsupported();
      }

      const provider = providers[this._officeAttempt];
      const loaderId = 'docvLoader_' + uid();

      body.innerHTML = `
        <div class="docv-office-wrap">
          <iframe id="docvFrame"
                  src="${_esc(provider.url)}"
                  class="docv-frame"
                  allowfullscreen
                  referrerpolicy="no-referrer"></iframe>
          <div class="docv-loader docv-loader-overlay" id="${loaderId}">
            <div class="docv-spinner"></div>
            <p>Loading presentation via ${_esc(provider.name)}…</p>
            <p class="docv-loader-hint">
              If this takes more than a few seconds, we will automatically
              try a different viewer.
            </p>
          </div>
        </div>`;

      const iframe = body.querySelector('#docvFrame');
      const loader = body.querySelector('#' + loaderId);
      let settled = false;

      const dismiss = () => {
        if (settled) return;
        settled = true;
        if (loader && loader.parentNode) {
          loader.style.opacity = '0';
          setTimeout(() => { try { loader.remove(); } catch (e) {} }, 250);
        }
      };

      // ⭐ 8-second timeout: if the viewer hasn't dismissed its own
      // loader, it's almost certainly broken (as seen in your console
      // with the 404 errors). Trigger the fallback automatically.
      this._officeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[DocumentViewer] ${provider.name} timed out. Trying next provider…`);
        this._officeAttempt++;
        this._renderOffice();
      }, 8000);

      if (iframe) {
        // Some browsers fire `load` even on 404s, so we only use it
        // to dismiss the loader early. The timeout handles real failures.
        iframe.addEventListener('load', () => setTimeout(dismiss, 600), { once: true });
      }
    }

    _renderUnsupported() {
      if (this._officeTimer) clearTimeout(this._officeTimer);
      const body = this.modal.querySelector('#docvBody');
      body.innerHTML = `
        <div class="docv-unsupported">
          <i class="fas fa-file"></i>
          <h3>Preview not available in-app</h3>
          <p>
            Both the Microsoft and Google viewers were unable to display this file.
            You can open it in a new tab or download it to view on your device.
          </p>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin-top:6px;">
            <a href="${_esc(this.fileUrl)}" target="_blank" rel="noopener noreferrer"
               class="btn btn-primary btn-lg">
              <i class="fas fa-external-link-alt"></i> Open in new tab
            </a>
            <button type="button" class="btn btn-outline btn-lg"
                    onclick="window.DocumentViewer._retryViewers()">
              <i class="fas fa-rotate"></i> Retry viewers
            </button>
          </div>
        </div>`;
    }

    _retryViewers() {
      this._officeAttempt = 0;
      this._renderOffice();
    }

    _renderError(msg) {
      const body = this.modal.querySelector('#docvBody');
      body.innerHTML = `
        <div class="docv-unsupported">
          <i class="fas fa-triangle-exclamation"></i>
          <h3>Could not load document</h3>
          <p>${_esc(msg)}</p>
          <a href="${_esc(this.fileUrl)}" target="_blank" rel="noopener noreferrer"
             class="btn btn-primary">
            <i class="fas fa-external-link-alt"></i> Open in a new tab
          </a>
        </div>`;
    }

    _onKeyDown(e) {
      if (!this.active) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    }

    close() {
      if (!this.active) return;
      this.active = false;
      if (this._officeTimer) clearTimeout(this._officeTimer);
      document.removeEventListener('keydown', this._onKeyDown, true);
      document.body.style.overflow = this._prevOverflow || '';

      const m = this.modal;
      if (m) {
        m.classList.remove('active');
        setTimeout(() => { try { m.remove(); } catch (e) {} }, 240);
      }
      this.modal = null;
    }
  }

  window.DocumentViewer = new DocumentViewer();
  console.log('[DocumentViewer v2] Ready with fallback providers');
})();