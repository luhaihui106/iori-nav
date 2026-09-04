(function () {
  if (window.IoriAssistantWindow) return;

  const PANEL_ID = 'ioriAssistantPanel';
  const FAB_ID = 'ioriAssistantFab';
  const STORAGE_KEY = 'iori_assistant_window_v1';
  const MIN_WIDTH = 380;
  const MIN_HEIGHT = 320;
  const EDGE_GAP = 10;

  let panel = null;
  let restoreRect = null;
  let dragState = null;
  let resizeState = null;
  let saveTimer = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveStateNow() {
    if (!panel || panel.style.display === 'none') return;
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const state = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      maximized: panel.classList.contains('iori-window-maximized'),
      minimized: panel.classList.contains('iori-window-minimized'),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStateNow, 120);
  }

  function setRect(rect) {
    if (!panel || !rect) return;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - EDGE_GAP * 2);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - EDGE_GAP * 2);
    const width = clamp(Number(rect.width) || 640, MIN_WIDTH, maxWidth);
    const height = clamp(Number(rect.height) || 720, MIN_HEIGHT, maxHeight);
    const left = clamp(Number(rect.left) || EDGE_GAP, EDGE_GAP, window.innerWidth - width - EDGE_GAP);
    const top = clamp(Number(rect.top) || EDGE_GAP, EDGE_GAP, window.innerHeight - height - EDGE_GAP);

    Object.assign(panel.style, {
      left: `${left}px`,
      top: `${top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  function currentRect() {
    const rect = panel?.getBoundingClientRect();
    if (!rect) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function ensureVisiblePosition(forceStored = false) {
    if (!panel || panel.style.display === 'none') return;
    const rect = panel.getBoundingClientRect();
    const stored = loadState();

    if (forceStored && stored && !stored.maximized && !stored.minimized) {
      setRect(stored);
      return;
    }

    if (!rect.width || !rect.height) return;
    if (panel.style.left && panel.style.top) {
      setRect(currentRect());
      return;
    }

    setRect({
      left: Math.max(EDGE_GAP, window.innerWidth - rect.width - 24),
      top: Math.max(EDGE_GAP, window.innerHeight - rect.height - 88),
      width: rect.width,
      height: rect.height,
    });
  }

  function setButtonState() {
    const minBtn = document.getElementById('ioriAssistantMinimize');
    const maxBtn = document.getElementById('ioriAssistantMaximize');
    if (minBtn) {
      minBtn.textContent = panel?.classList.contains('iori-window-minimized') ? '▤' : '—';
      minBtn.title = panel?.classList.contains('iori-window-minimized') ? '恢复窗口' : '最小化窗口';
    }
    if (maxBtn) {
      maxBtn.textContent = panel?.classList.contains('iori-window-maximized') ? '❐' : '□';
      maxBtn.title = panel?.classList.contains('iori-window-maximized') ? '恢复窗口' : '最大化窗口';
    }
  }

  function restoreWindow() {
    if (!panel) return;
    panel.classList.remove('iori-window-maximized', 'iori-window-minimized');
    if (restoreRect) setRect(restoreRect);
    else ensureVisiblePosition(true);
    restoreRect = null;
    setButtonState();
    scheduleSave();
  }

  function toggleMinimize() {
    if (!panel) return;
    if (panel.classList.contains('iori-window-minimized')) {
      restoreWindow();
      return;
    }
    if (!panel.classList.contains('iori-window-maximized')) restoreRect = currentRect();
    panel.classList.remove('iori-window-maximized');
    panel.classList.add('iori-window-minimized');
    const rect = panel.getBoundingClientRect();
    Object.assign(panel.style, {
      width: `${Math.min(420, Math.max(MIN_WIDTH, rect.width))}px`,
      height: '52px',
    });
    setButtonState();
    scheduleSave();
  }

  function toggleMaximize() {
    if (!panel) return;
    if (panel.classList.contains('iori-window-maximized')) {
      restoreWindow();
      return;
    }
    if (!panel.classList.contains('iori-window-minimized')) restoreRect = currentRect();
    panel.classList.remove('iori-window-minimized');
    panel.classList.add('iori-window-maximized');
    setRect({
      left: EDGE_GAP,
      top: EDGE_GAP,
      width: window.innerWidth - EDGE_GAP * 2,
      height: window.innerHeight - EDGE_GAP * 2,
    });
    setButtonState();
    scheduleSave();
  }

  function beginDrag(event) {
    if (!panel || event.button !== 0) return;
    if (event.target.closest('button, a, input, textarea, summary')) return;
    if (panel.classList.contains('iori-window-maximized')) return;
    if (window.innerWidth <= 640) return;

    ensureVisiblePosition();
    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('iori-window-interacting');
  }

  function moveDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId || !panel) return;
    const rect = panel.getBoundingClientRect();
    const left = clamp(dragState.left + event.clientX - dragState.startX, EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
    const top = clamp(dragState.top + event.clientY - dragState.startY, EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function endDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    dragState = null;
    document.body.classList.remove('iori-window-interacting');
    scheduleSave();
  }

  function beginResize(event) {
    if (!panel || event.button !== 0 || panel.classList.contains('iori-window-maximized') || panel.classList.contains('iori-window-minimized')) return;
    ensureVisiblePosition();
    const rect = panel.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('iori-window-interacting');
    event.preventDefault();
  }

  function moveResize(event) {
    if (!resizeState || event.pointerId !== resizeState.pointerId || !panel) return;
    const maxWidth = window.innerWidth - resizeState.left - EDGE_GAP;
    const maxHeight = window.innerHeight - resizeState.top - EDGE_GAP;
    const width = clamp(resizeState.width + event.clientX - resizeState.startX, MIN_WIDTH, maxWidth);
    const height = clamp(resizeState.height + event.clientY - resizeState.startY, MIN_HEIGHT, maxHeight);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  function endResize(event) {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return;
    resizeState = null;
    document.body.classList.remove('iori-window-interacting');
    scheduleSave();
  }

  function actionSummary() {
    const rows = [...document.querySelectorAll('#ioriAssistantActionList .iori-assistant-action-row')];
    const summary = { total: rows.length, create: 0, move: 0, rename: 0, desc: 0 };
    rows.forEach(row => {
      const text = row.textContent || '';
      if (text.startsWith('新建分类')) summary.create++;
      else if (text.startsWith('移动分类')) summary.move++;
      else if (text.startsWith('重命名')) summary.rename++;
      else if (text.startsWith('修改描述')) summary.desc++;
    });
    return summary;
  }

  function closeConfirm() {
    document.getElementById('ioriAssistantConfirmOverlay')?.remove();
  }

  function showConfirm(button) {
    closeConfirm();
    const counts = actionSummary();
    const overlay = document.createElement('div');
    overlay.id = 'ioriAssistantConfirmOverlay';
    overlay.innerHTML = `
      <div class="iori-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ioriConfirmTitle">
        <div id="ioriConfirmTitle" class="iori-confirm-title">确认执行这批修改？</div>
        <div class="iori-confirm-total">即将写入 D1，共 <strong>${counts.total}</strong> 项变更。</div>
        <div class="iori-confirm-stats">
          ${counts.create ? `<span>新建分类 ${counts.create}</span>` : ''}
          ${counts.move ? `<span>移动书签 ${counts.move}</span>` : ''}
          ${counts.rename ? `<span>重命名 ${counts.rename}</span>` : ''}
          ${counts.desc ? `<span>修改描述 ${counts.desc}</span>` : ''}
        </div>
        <div class="iori-confirm-note">执行后仍可使用“撤销本次修改”恢复。建议先检查上方待确认变更。</div>
        <div class="iori-confirm-actions">
          <button type="button" id="ioriConfirmBack">返回检查</button>
          <button type="button" id="ioriConfirmApply" class="danger">确认执行</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('ioriConfirmBack')?.addEventListener('click', closeConfirm);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeConfirm(); });
    document.getElementById('ioriConfirmApply')?.addEventListener('click', () => {
      closeConfirm();
      button.dataset.ioriConfirmed = '1';
      button.click();
    });
  }

  function installConfirmGuard() {
    document.addEventListener('click', event => {
      const button = event.target.closest?.('#ioriAssistantApply');
      if (!button) return;
      if (button.dataset.ioriConfirmed === '1') {
        delete button.dataset.ioriConfirmed;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      showConfirm(button);
    }, true);
  }

  function restoreStoredWindow() {
    const stored = loadState();
    if (!stored || !panel || panel.style.display === 'none') return;
    if (stored.maximized) {
      restoreRect = stored;
      panel.classList.add('iori-window-maximized');
      setRect({ left: EDGE_GAP, top: EDGE_GAP, width: window.innerWidth - EDGE_GAP * 2, height: window.innerHeight - EDGE_GAP * 2 });
    } else if (stored.minimized) {
      restoreRect = stored;
      panel.classList.add('iori-window-minimized');
      setRect({ left: stored.left, top: stored.top, width: Math.max(MIN_WIDTH, Math.min(420, stored.width || 420)), height: 52 });
    } else {
      setRect(stored);
    }
    setButtonState();
  }

  function install() {
    panel = document.getElementById(PANEL_ID);
    const fab = document.getElementById(FAB_ID);
    const head = panel?.querySelector('.iori-assistant-head');
    const actions = panel?.querySelector('.iori-assistant-head-actions');
    if (!panel || !fab || !head || !actions) return false;
    if (document.getElementById('ioriAssistantMaximize')) return true;

    panel.classList.add('iori-window-enhanced');
    head.title = '拖动这里可以移动窗口；双击可最大化/恢复';

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.id = 'ioriAssistantMinimize';
    minBtn.className = 'iori-assistant-window-btn';
    minBtn.textContent = '—';
    minBtn.title = '最小化窗口';

    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.id = 'ioriAssistantMaximize';
    maxBtn.className = 'iori-assistant-window-btn';
    maxBtn.textContent = '□';
    maxBtn.title = '最大化窗口';

    const closeBtn = document.getElementById('ioriAssistantClose');
    actions.insertBefore(minBtn, closeBtn || null);
    actions.insertBefore(maxBtn, closeBtn || null);

    const grip = document.createElement('div');
    grip.id = 'ioriAssistantResizeGrip';
    grip.title = '拖动调整窗口大小';
    panel.appendChild(grip);

    const style = document.createElement('style');
    style.textContent = `
      #ioriAssistantPanel.iori-window-enhanced{min-width:${MIN_WIDTH}px;min-height:${MIN_HEIGHT}px;max-width:calc(100vw - ${EDGE_GAP * 2}px);max-height:calc(100vh - ${EDGE_GAP * 2}px)}
      #ioriAssistantPanel .iori-assistant-head{cursor:move;user-select:none;touch-action:none}
      #ioriAssistantPanel .iori-assistant-head-actions,#ioriAssistantPanel .iori-assistant-head-actions *{cursor:pointer}
      .iori-assistant-window-btn{font-size:15px!important;min-width:28px;height:28px;border:1px solid rgba(255,255,255,.22)!important;border-radius:7px!important;line-height:1!important}
      #ioriAssistantResizeGrip{position:absolute;right:2px;bottom:2px;width:18px;height:18px;cursor:nwse-resize;z-index:30;touch-action:none;background:linear-gradient(135deg,transparent 0 48%,#94a3b8 49% 56%,transparent 57% 66%,#64748b 67% 74%,transparent 75%)}
      #ioriAssistantPanel.iori-window-minimized{min-height:52px!important;overflow:hidden!important}
      #ioriAssistantPanel.iori-window-minimized .iori-assistant-body,#ioriAssistantPanel.iori-window-minimized #ioriAssistantResizeGrip{display:none!important}
      #ioriAssistantPanel.iori-window-maximized{border-radius:12px}
      body.iori-window-interacting{user-select:none!important;cursor:move!important}
      #ioriAssistantConfirmOverlay{position:fixed;inset:0;z-index:12000;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:18px}
      .iori-confirm-dialog{width:min(460px,calc(100vw - 36px));background:#fff;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.28);padding:20px;color:#0f172a}
      .iori-confirm-title{font-size:17px;font-weight:700;margin-bottom:10px}.iori-confirm-total{font-size:14px;line-height:1.55}.iori-confirm-stats{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}.iori-confirm-stats span{font-size:12px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:5px 8px}.iori-confirm-note{font-size:12px;color:#64748b;line-height:1.55;background:#f8fafc;border-radius:8px;padding:9px 10px}.iori-confirm-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}.iori-confirm-actions button{border:0;border-radius:8px;padding:9px 14px;cursor:pointer;background:#e2e8f0;color:#0f172a}.iori-confirm-actions .danger{background:#dc2626;color:#fff}
      @media(max-width:640px){#ioriAssistantPanel.iori-window-enhanced{min-width:0;min-height:0;left:8px!important;top:8px!important;width:calc(100vw - 16px)!important;height:calc(100vh - 16px)!important;max-width:none;max-height:none;border-radius:12px}.iori-assistant-window-btn{display:none!important}#ioriAssistantResizeGrip{display:none!important}#ioriAssistantPanel .iori-assistant-head{cursor:default}}
    `;
    document.head.appendChild(style);

    minBtn.addEventListener('click', event => { event.stopPropagation(); toggleMinimize(); });
    maxBtn.addEventListener('click', event => { event.stopPropagation(); toggleMaximize(); });
    head.addEventListener('dblclick', event => { if (!event.target.closest('button')) toggleMaximize(); });
    head.addEventListener('pointerdown', beginDrag);
    head.addEventListener('pointermove', moveDrag);
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    grip.addEventListener('pointerdown', beginResize);
    grip.addEventListener('pointermove', moveResize);
    grip.addEventListener('pointerup', endResize);
    grip.addEventListener('pointercancel', endResize);

    fab.addEventListener('click', () => {
      requestAnimationFrame(() => {
        if (panel.style.display !== 'none') {
          if (!panel.dataset.ioriWindowRestored) {
            panel.dataset.ioriWindowRestored = '1';
            restoreStoredWindow();
          } else {
            ensureVisiblePosition();
          }
        }
      });
    });

    window.addEventListener('resize', () => {
      if (!panel || panel.style.display === 'none') return;
      if (panel.classList.contains('iori-window-maximized')) {
        setRect({ left: EDGE_GAP, top: EDGE_GAP, width: window.innerWidth - EDGE_GAP * 2, height: window.innerHeight - EDGE_GAP * 2 });
      } else {
        setRect(currentRect());
      }
      scheduleSave();
    });

    installConfirmGuard();
    setButtonState();
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

  window.IoriAssistantWindow = { init, restoreWindow, toggleMaximize, toggleMinimize };
  init();
})();
