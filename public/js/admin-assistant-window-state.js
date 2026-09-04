(function () {
  if (window.IoriAssistantWindowStateFix) return;

  const NORMAL_RECT_KEY = 'iori_assistant_window_normal_rect_v2';
  const OPEN_KEY = 'iori_assistant_window_open_v2';
  let panel = null;
  let resizeObserver = null;

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function isNormalWindow() {
    return panel && panel.style.display !== 'none'
      && !panel.classList.contains('iori-window-maximized')
      && !panel.classList.contains('iori-window-minimized');
  }

  function saveNormalRect() {
    if (!isNormalWindow()) return;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 250 || rect.height < 200) return;
    writeJson(NORMAL_RECT_KEY, {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  function restoreNormalRect() {
    if (!panel) return;
    const saved = readJson(NORMAL_RECT_KEY);
    if (!saved) return;
    const gap = 10;
    const width = Math.min(Math.max(Number(saved.width) || 640, 380), Math.max(380, innerWidth - gap * 2));
    const height = Math.min(Math.max(Number(saved.height) || 720, 360), Math.max(360, innerHeight - gap * 2));
    const left = Math.min(Math.max(Number(saved.left) || gap, gap), Math.max(gap, innerWidth - width - gap));
    const top = Math.min(Math.max(Number(saved.top) || gap, gap), Math.max(gap, innerHeight - height - gap));
    Object.assign(panel.style, {
      left: `${left}px`,
      top: `${top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  function setOpenState(open) {
    writeJson(OPEN_KEY, Boolean(open));
  }

  function actionCounts() {
    const counts = { create: 0, move: 0, rename: 0, desc: 0 };
    document.querySelectorAll('#ioriAssistantActionList .iori-assistant-action-row').forEach(row => {
      const text = row.textContent || '';
      if (text.startsWith('新建分类')) counts.create++;
      else if (text.startsWith('移动书签') || text.startsWith('移动分类')) counts.move++;
      else if (text.startsWith('重命名')) counts.rename++;
      else if (text.startsWith('修改描述')) counts.desc++;
    });
    return counts;
  }

  function normalizeConfirmSummary() {
    const stats = document.querySelector('#ioriAssistantConfirmOverlay .iori-confirm-stats');
    if (!stats || stats.dataset.ioriNormalized === '1') return;
    const counts = actionCounts();
    stats.dataset.ioriNormalized = '1';
    stats.innerHTML = `
      <span>新建分类 ${counts.create}</span>
      <span>移动书签 ${counts.move}</span>
      <span>重命名 ${counts.rename}</span>
      <span>修改描述 ${counts.desc}</span>`;
  }

  function updateCompactMode() {
    if (!panel || panel.style.display === 'none') return;
    const rect = panel.getBoundingClientRect();
    panel.classList.toggle('iori-window-compact-height', rect.height > 0 && rect.height < 430 && !panel.classList.contains('iori-window-minimized'));
  }

  function installEvents() {
    document.addEventListener('click', event => {
      const maxBtn = event.target.closest?.('#ioriAssistantMaximize');
      if (maxBtn && panel) {
        const wasMaximized = panel.classList.contains('iori-window-maximized');
        if (!wasMaximized) saveNormalRect();
        setTimeout(() => {
          if (wasMaximized && !panel.classList.contains('iori-window-maximized')) restoreNormalRect();
          updateCompactMode();
        }, 0);
      }

      const fab = event.target.closest?.('#ioriAssistantFab');
      if (fab && panel) {
        const wasOpen = panel.style.display === 'block';
        setTimeout(() => {
          const open = panel.style.display === 'block';
          setOpenState(open);
          if (open && !wasOpen) {
            const saved = readJson(NORMAL_RECT_KEY);
            if (saved && !panel.classList.contains('iori-window-maximized') && !panel.classList.contains('iori-window-minimized')) {
              restoreNormalRect();
            }
            updateCompactMode();
          }
        }, 0);
      }

      if (event.target.closest?.('#ioriAssistantClose')) setOpenState(false);
    }, true);

    document.addEventListener('dblclick', event => {
      const head = event.target.closest?.('#ioriAssistantPanel .iori-assistant-head');
      if (!head || event.target.closest('button') || !panel) return;
      const wasMaximized = panel.classList.contains('iori-window-maximized');
      if (!wasMaximized) saveNormalRect();
      setTimeout(() => {
        if (wasMaximized && !panel.classList.contains('iori-window-maximized')) restoreNormalRect();
        updateCompactMode();
      }, 0);
    }, true);

    document.addEventListener('pointerup', () => {
      setTimeout(() => {
        saveNormalRect();
        updateCompactMode();
      }, 0);
    }, true);

    const observer = new MutationObserver(() => normalizeConfirmSummary());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function install() {
    panel = document.getElementById('ioriAssistantPanel');
    const fab = document.getElementById('ioriAssistantFab');
    if (!panel || !fab) return false;

    const style = document.createElement('style');
    style.textContent = `
      #ioriAssistantPanel.iori-window-compact-height .iori-assistant-quick{display:none!important}
      #ioriAssistantPanel.iori-window-compact-height #ioriAssistantConversation{min-height:140px!important}
    `;
    document.head.appendChild(style);

    resizeObserver = new ResizeObserver(() => {
      saveNormalRect();
      updateCompactMode();
    });
    resizeObserver.observe(panel);
    installEvents();

    const shouldOpen = readJson(OPEN_KEY) === true;
    if (shouldOpen && panel.style.display !== 'block') {
      setTimeout(() => {
        if (panel.style.display !== 'block') fab.click();
      }, 180);
    }

    updateCompactMode();
    return true;
  }

  function init() {
    if (install()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (install() || tries > 100) clearInterval(timer);
    }, 100);
  }

  window.IoriAssistantWindowStateFix = { init, saveNormalRect, restoreNormalRect };
  init();
})();
