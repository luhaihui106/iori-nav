(function () {
  if (window.IoriAssistantMemory) return;

  const SESSION_STORAGE_KEY = 'iori_assistant_session_id';
  const CHAT_PATH = '/api/assistant/chat';
  const MEMORY_CHAT_PATH = '/api/assistant/chat-memory';
  const originalFetch = window.fetch.bind(window);
  let restoredSessionId = '';

  function currentSessionId() {
    try { return localStorage.getItem(SESSION_STORAGE_KEY) || ''; }
    catch { return ''; }
  }

  function setCurrentSessionId(sessionId) {
    try { localStorage.setItem(SESSION_STORAGE_KEY, sessionId); } catch {}
  }

  function patchFetch() {
    if (window.__ioriMemoryFetchPatched) return;
    window.__ioriMemoryFetchPatched = true;

    window.fetch = function patchedFetch(input, init) {
      if (typeof input === 'string' && input === CHAT_PATH) {
        return originalFetch(MEMORY_CHAT_PATH, init);
      }
      if (input instanceof Request) {
        try {
          const url = new URL(input.url, location.origin);
          if (url.origin === location.origin && url.pathname === CHAT_PATH) {
            const replacement = new Request(MEMORY_CHAT_PATH, input);
            return originalFetch(replacement, init);
          }
        } catch {}
      }
      return originalFetch(input, init);
    };
  }

  function createMessage(role, content) {
    const item = document.createElement('div');
    item.className = `iori-assistant-msg ${role === 'user' ? 'user' : 'ai'}`;
    item.textContent = content;
    return item;
  }

  async function restoreCurrentSession(force = false) {
    const sessionId = currentSessionId();
    const box = document.getElementById('ioriAssistantMessages');
    if (!sessionId || !box) return;
    if (!force && restoredSessionId === sessionId) return;

    try {
      const response = await originalFetch(`/api/assistant/session?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      if (!response.ok || data.code !== 200 || !data.data?.exists) return;
      const history = Array.isArray(data.data.history) ? data.data.history : [];
      if (!history.length) return;

      box.innerHTML = '';
      history.forEach(item => box.appendChild(createMessage(item.role, item.content)));
      box.scrollTop = box.scrollHeight;
      restoredSessionId = sessionId;

      const hint = document.getElementById('ioriAssistantMemoryHint');
      if (hint) hint.textContent = `已恢复 ${Math.floor(history.length / 2)} 轮历史对话`;
    } catch (error) {
      console.warn('Failed to restore assistant history:', error);
    }
  }

  function formatTime(value) {
    if (!value) return '';
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  async function loadHistoryList() {
    const list = document.getElementById('ioriAssistantHistoryList');
    if (!list) return;
    list.innerHTML = '<div class="iori-history-empty">正在读取历史对话...</div>';

    try {
      const response = await originalFetch('/api/assistant/sessions');
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || '读取失败');
      const sessions = Array.isArray(data.data) ? data.data : [];
      const activeId = currentSessionId();

      list.innerHTML = '';
      if (!sessions.length) {
        list.innerHTML = '<div class="iori-history-empty">还没有可恢复的历史对话。</div>';
        return;
      }

      sessions.forEach(session => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `iori-history-item${session.sessionId === activeId ? ' active' : ''}`;
        const title = document.createElement('div');
        title.className = 'iori-history-title';
        title.textContent = session.title || '未命名对话';
        const meta = document.createElement('div');
        meta.className = 'iori-history-meta';
        meta.textContent = `${formatTime(session.updatedAt)} · ${Math.floor((session.messageCount || 0) / 2)} 轮${session.planTitle ? ` · ${session.planTitle}` : ''}`;
        button.append(title, meta);
        button.addEventListener('click', () => {
          if (session.sessionId === currentSessionId()) {
            closeHistory();
            restoreCurrentSession(true);
            return;
          }
          setCurrentSessionId(session.sessionId);
          location.reload();
        });
        list.appendChild(button);
      });
    } catch (error) {
      list.innerHTML = `<div class="iori-history-empty">历史对话读取失败：${String(error.message || error)}</div>`;
    }
  }

  function closeHistory() {
    const panel = document.getElementById('ioriAssistantHistory');
    if (panel) panel.style.display = 'none';
  }

  function toggleHistory() {
    const panel = document.getElementById('ioriAssistantHistory');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) loadHistoryList();
  }

  function installHistoryUi() {
    const assistantPanel = document.getElementById('ioriAssistantPanel');
    const actions = assistantPanel?.querySelector('.iori-assistant-head-actions');
    if (!assistantPanel || !actions || document.getElementById('ioriAssistantHistoryBtn')) return false;

    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.id = 'ioriAssistantHistoryBtn';
    historyButton.className = 'iori-assistant-new';
    historyButton.textContent = '历史';
    actions.insertBefore(historyButton, actions.firstChild);

    const historyPanel = document.createElement('div');
    historyPanel.id = 'ioriAssistantHistory';
    historyPanel.innerHTML = `
      <div class="iori-history-head">
        <div>
          <strong>历史对话</strong>
          <div id="ioriAssistantMemoryHint">会话会保存 7 天；同一会话支持连续追问。</div>
        </div>
        <button type="button" id="ioriAssistantHistoryClose">×</button>
      </div>
      <div id="ioriAssistantHistoryList"></div>`;
    assistantPanel.appendChild(historyPanel);

    const style = document.createElement('style');
    style.textContent = `
      #ioriAssistantHistory{display:none;position:absolute;inset:52px 0 0 0;z-index:10;background:#f8fafc;overflow:auto}
      .iori-history-head{position:sticky;top:0;display:flex;justify-content:space-between;align-items:flex-start;padding:14px;background:#fff;border-bottom:1px solid #e5e7eb;z-index:2}.iori-history-head strong{font-size:14px}.iori-history-head div div{font-size:11px;color:#64748b;margin-top:3px}.iori-history-head button{border:0;background:transparent;font-size:22px;cursor:pointer;color:#334155}
      #ioriAssistantHistoryList{padding:10px}.iori-history-item{width:100%;text-align:left;border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:10px 11px;margin-bottom:8px;cursor:pointer}.iori-history-item:hover{border-color:#a5b4fc;background:#f8faff}.iori-history-item.active{border-color:#6366f1;background:#eef2ff}.iori-history-title{font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iori-history-meta{font-size:11px;color:#64748b;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iori-history-empty{font-size:12px;color:#64748b;padding:20px;text-align:center}
    `;
    document.head.appendChild(style);

    historyButton.addEventListener('click', toggleHistory);
    document.getElementById('ioriAssistantHistoryClose')?.addEventListener('click', closeHistory);

    document.getElementById('ioriAssistantNew')?.addEventListener('click', () => {
      restoredSessionId = '';
      closeHistory();
      const hint = document.getElementById('ioriAssistantMemoryHint');
      if (hint) hint.textContent = '已开始新对话；新的上下文将独立保存。';
    });

    restoreCurrentSession();
    return true;
  }

  function init() {
    patchFetch();
    if (installHistoryUi()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (installHistoryUi() || tries > 80) clearInterval(timer);
    }, 100);
  }

  window.IoriAssistantMemory = { init, restoreCurrentSession, loadHistoryList };
  init();
})();
