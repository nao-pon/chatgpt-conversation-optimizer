(() => {
  if (window.__chatgptOptimizerLoaded) return;
  window.__chatgptOptimizerLoaded = true;

  const MODE_CONFIG = {
    off:    { buffer: null },
    weak:   { buffer: 1600 },
    medium: { buffer: 2600 },
    strong: { buffer: 4200 },
  };

  const DEFAULT_SETTINGS = {
    mode: 'auto',
    panelCollapsed: true,
    autoEnabled: true,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let effectiveMode = 'medium';
  let root = null;
  let listRoot = null;
  let statusEl = null;
  let countEl = null;
  let modeButtons = new Map();
  let autoToggle = null;
  let optimizeScheduled = false;
  let toggleEl = null;
  let titleEl = null;

  function t(key, substitutions) {
    try {
      return chrome.i18n.getMessage(key, substitutions) || key;
    } catch {
      return key;
    }
  }

  function getConversationNodes() {
    const main = document.querySelector('main');
    if (!main) return [];

    const selectors = [
      'main article',
      'main [data-message-author-role]',
      'main div[data-message-id]',
      'main div.group.w-full',
    ];

    for (const selector of selectors) {
      const nodes = Array.from(main.querySelectorAll(selector)).filter(isUsableMessageNode);
      if (nodes.length >= 4) return dedupeNested(nodes);
    }

    const blocks = Array.from(main.children).filter(isUsableMessageNode);
    return dedupeNested(blocks);
  }

  function isUsableMessageNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const text = (node.innerText || '').trim();
    return rect.height > 80 || text.length > 80;
  }

  function dedupeNested(nodes) {
    const set = new Set(nodes);
    return nodes.filter(node => {
      let p = node.parentElement;
      while (p) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  function chooseAutoMode(count) {
    if (count >= 280) return 'strong';
    if (count >= 120) return 'medium';
    return 'weak';
  }

  function getCurrentMode(count) {
    if (settings.mode === 'auto') return chooseAutoMode(count);
    return MODE_CONFIG[settings.mode] ? settings.mode : 'medium';
  }

  function applyOptimization() {
    optimizeScheduled = false;
    const nodes = getConversationNodes();
    const count = nodes.length;
    effectiveMode = getCurrentMode(count);
    const cfg = MODE_CONFIG[effectiveMode];

    const scrollY = window.scrollY;
    const topBound = scrollY - (cfg.buffer ?? 0);
    const bottomBound = scrollY + window.innerHeight + (cfg.buffer ?? 0);

    let optimized = 0;
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (cfg.buffer === null) {
        clearOptimization(el);
        continue;
      }
      const rect = el.getBoundingClientRect();
      const top = rect.top + scrollY;
      const bottom = rect.bottom + scrollY;
      const outside = bottom < topBound || top > bottomBound;
      if (outside) {
        optimized += 1;
        optimizeNode(el);
      } else {
        clearOptimization(el);
      }
    }

    updatePanel(count, optimized);
  }

  function optimizeNode(el) {
    el.style.contentVisibility = 'auto';
    if (!el.style.containIntrinsicSize) {
      const h = Math.max(400, Math.ceil(el.getBoundingClientRect().height || 900));
      el.style.containIntrinsicSize = `${h}px`;
    }
    el.style.contain = 'layout style paint';
  }

  function clearOptimization(el) {
    el.style.contentVisibility = 'visible';
    el.style.contain = '';
    // retain containIntrinsicSize to reduce layout thrash when toggling
  }

  function scheduleOptimize() {
    if (optimizeScheduled) return;
    optimizeScheduled = true;
    requestAnimationFrame(applyOptimization);
  }

  function saveSettings() {
    chrome.storage.local.set({ chatgptOptimizerSettings: settings });
  }

  function setMode(mode) {
    settings.mode = mode;
    settings.autoEnabled = mode === 'auto';
    saveSettings();
    refreshModeButtons();
    scheduleOptimize();
  }

  function refreshModeButtons() {
    for (const [mode, btn] of modeButtons.entries()) {
      const active = settings.mode === mode;
      btn.style.opacity = active ? '1' : '0.75';
      btn.style.outline = active ? '2px solid rgba(255,255,255,0.85)' : 'none';
    }
    if (autoToggle) {
      autoToggle.textContent = t(settings.mode === 'auto' ? 'autoOn' : 'autoOff');
      autoToggle.style.opacity = settings.mode === 'auto' ? '1' : '0.75';
    }
  }

  function updatePanel(count, optimized) {
    if (!statusEl || !countEl) return;

    const effectiveLabel = t(`${effectiveMode}`);

    const modeLabel =
      settings.mode === 'auto'
        ? t('autoArrow', [effectiveLabel])
        : effectiveLabel;

    statusEl.textContent = `${t('intensity')}: ${modeLabel}`;
    countEl.textContent = t('countsLine', [String(count), String(optimized)]);
  }

  function togglePanel() {
    settings.panelCollapsed = !settings.panelCollapsed;
    saveSettings();
    renderPanelState();
  }

  function renderPanelState() {
    const expanded = !settings.panelCollapsed;
    if (!root) return;

    const box = root.firstElementChild;
    if (!box) return;

    if (expanded) {
      box.style.padding = '8px';
      box.style.minWidth = '180px';
      box.style.maxWidth = '220px';
      box.style.borderRadius = '14px';

      if (titleEl) titleEl.style.display = '';
      if (listRoot) listRoot.style.display = '';
      if (toggleEl) toggleEl.textContent = '×';
    } else {
      box.style.padding = '6px';
      box.style.minWidth = '0';
      box.style.maxWidth = 'none';
      box.style.borderRadius = '999px';

      if (titleEl) titleEl.style.display = 'none';
      if (listRoot) listRoot.style.display = 'none';
      if (toggleEl) toggleEl.textContent = '⚡';
    }
  }

  function makeButton(label, mode) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.type = 'button';
    btn.style.cssText = buttonCss();
    btn.addEventListener('click', () => setMode(mode));
    modeButtons.set(mode, btn);
    return btn;
  }

  function buttonCss() {
    return [
      'display:block',
      'width:100%',
      'margin:6px 0 0 0',
      'padding:7px 10px',
      'border:none',
      'border-radius:10px',
      'background:rgba(255,255,255,0.12)',
      'color:#fff',
      'font-size:12px',
      'cursor:pointer',
      'text-align:left',
    ].join(';');
  }

  function createPanel() {
    root = document.createElement('div');
    root.id = 'chatgpt-optimizer-panel';
    root.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:4px',
      'z-index:2147483647',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'color:#fff',
      'user-select:none',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:rgba(20,20,24,0.82)',
      'backdrop-filter:blur(8px)',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:14px',
      'box-shadow:0 8px 30px rgba(0,0,0,0.28)',
      'padding:8px',
      'min-width:180px',
      'max-width:220px',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    titleEl = document.createElement('div');
    titleEl.textContent = t('optimizer');
    titleEl.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.02em;';

    toggleEl = document.createElement('button');
    toggleEl.id = 'cgo-toggle';
    toggleEl.type = 'button';
    toggleEl.textContent = '⚡';
    toggleEl.style.cssText = [
      'border:none',
      'background:rgba(255,255,255,0.12)',
      'color:#fff',
      'width:28px',
      'height:28px',
      'border-radius:999px',
      'cursor:pointer',
      'font-size:14px',
    ].join(';');
    toggleEl.addEventListener('click', togglePanel);

    header.appendChild(titleEl);
    header.appendChild(toggleEl);

    listRoot = document.createElement('div');
    listRoot.style.cssText = 'margin-top:8px;';

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:12px;opacity:0.9;';
    countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;';

    autoToggle = document.createElement('button');
    autoToggle.type = 'button';
    autoToggle.style.cssText = buttonCss();
    autoToggle.addEventListener('click', () => setMode(settings.mode === 'auto' ? 'medium' : 'auto'));

    listRoot.appendChild(statusEl);
    listRoot.appendChild(countEl);
    listRoot.appendChild(autoToggle);
    listRoot.appendChild(makeButton(t('off'), 'off'));
    listRoot.appendChild(makeButton(t('weak'), 'weak'));
    listRoot.appendChild(makeButton(t('medium'), 'medium'));
    listRoot.appendChild(makeButton(t('strong'), 'strong'));

    box.appendChild(header);
    box.appendChild(listRoot);
    root.appendChild(box);
    document.documentElement.appendChild(root);

    renderPanelState();
    refreshModeButtons();
  }

  function installObservers() {
    const observer = new MutationObserver(() => scheduleOptimize());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('scroll', scheduleOptimize, { passive: true });
    window.addEventListener('resize', scheduleOptimize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleOptimize();
    });
  }

  async function init() {
    try {
      const stored = await chrome.storage.local.get(['chatgptOptimizerSettings']);
      if (stored.chatgptOptimizerSettings && typeof stored.chatgptOptimizerSettings === 'object') {
        settings = { ...DEFAULT_SETTINGS, ...stored.chatgptOptimizerSettings };
      }
    } catch (_) {}

    createPanel();
    installObservers();
    setTimeout(scheduleOptimize, 400);
    setTimeout(scheduleOptimize, 1500);
    setTimeout(scheduleOptimize, 3000);
  }

  init();
})();
