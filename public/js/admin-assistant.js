(function () {
  if (window.IoriAdminAssistant) return;

  const state = {
    actions: [],
    undoToken: '',
  };

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken(),
    };
  }

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'class') node.className = value;
      else if (key === 'style') node.setAttribute('style', value);
      else node.setAttribute(key, value);
    });
    if (text) node.textContent = text;
    return node;
  }

  function appendMessage(role, text) {
    const list = document.getElementById('ioriAssistantMessages');
    if (!list) return;
    const item = el('div', {
      class: role === 'user' ? 'iori-assistant-msg user' : 'iori-assistant-msg ai'
    });
    item.textContent = text;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  function renderResults(results) {
    const box = document.getElementById('ioriAssistantResults');
    box.innerHTML = '';
    if (!Array.isArray(results) || !results.length) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    results.forEach((item, index) => {
      const card = el('div', { class: 'iori-assistant-result' });
      const title = el('div', { class: 'iori-assistant-result-title' }, `${index + 1}. ${item.name}`);
      const url = el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.url);
      const meta = el('div', { class: 'iori-assistant-result-meta' }, [item.category, item.reason].filter(Boolean).join(' · '));
      card.append(title, url, meta);
      box.appendChild(card);
    });
  }

  function actionLabel(action) {
    if (action.type === 'rename_bookmark') return `重命名 #${action.siteId}：${action.currentName || ''} → ${action.name}`;
    if (action.type === 'update_description') return `修改描述 #${action.siteId}：${action.description}`;
    if (action.type === 'move_bookmark') return `移动分类 #${action.siteId}：${action.currentCategory || '未分类'} → ${action.category}`;
    return '未知操作';
  }

  function renderActions(actions) {
    state.actions = Array.isArray(actions) ? actions : [];
    const panel = document.getElementById('ioriAssistantActions');
    const list = document.getElementById('ioriAssistantActionList');
    list.innerHTML = '';
    if (!state.actions.length) {
      panel.style.display = 'none';
      return;
    }

    state.actions.forEach(action => {
      const row = el('div', { class: 'iori-assistant-action-row' }, actionLabel(action));
      list.appendChild(row);
    });
    panel.style.display = 'block';
  }

  async function sendMessage() {
    const input = document.getElementById('ioriAssistantInput');
    const sendBtn = document.getElementById('ioriAssistantSend');
    const message = input.value.trim();
    if (!message) return;

    appendMessage('user', message);
    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '处理中...';
    renderActions([]);
    renderResults([]);

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ message })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || 'AI 助手请求失败');
      appendMessage('ai', data.data.reply || '已完成分析。');
      renderResults(data.data.results || []);
      renderActions(data.data.actions || []);
    } catch (error) {
      appendMessage('ai', `处理失败：${error.message}`);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
    }
  }

  async function applyActions() {
    if (!state.actions.length) return;
    const button = document.getElementById('ioriAssistantApply');
    button.disabled = true;
    button.textContent = '执行中...';

    try {
      const response = await fetch('/api/assistant/apply', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ actions: state.actions })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || '执行失败');
      state.undoToken = data.data?.undoToken || '';
      appendMessage('ai', `${data.message}。如结果不满意，可点击“撤销本次修改”。`);
      renderActions([]);
      document.getElementById('ioriAssistantUndo').style.display = state.undoToken ? 'inline-flex' : 'none';
      window.fetchConfigs?.();
      window.fetchCategories?.();
    } catch (error) {
      appendMessage('ai', `执行失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '确认执行';
    }
  }

  async function undoLast() {
    if (!state.undoToken) return;
    const button = document.getElementById('ioriAssistantUndo');
    button.disabled = true;
    button.textContent = '撤销中...';
    try {
      const response = await fetch('/api/assistant/undo', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ undoToken: state.undoToken })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || '撤销失败');
      appendMessage('ai', data.message);
      state.undoToken = '';
      button.style.display = 'none';
      window.fetchConfigs?.();
      window.fetchCategories?.();
    } catch (error) {
      appendMessage('ai', `撤销失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '撤销本次修改';
    }
  }

  function buildUi() {
    const style = el('style');
    style.textContent = `
      #ioriAssistantFab{position:fixed;right:24px;bottom:24px;z-index:4500;width:52px;height:52px;border:0;border-radius:50%;background:#111827;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.22);cursor:pointer;font-size:22px}
      #ioriAssistantPanel{position:fixed;right:24px;bottom:88px;z-index:4499;width:min(430px,calc(100vw - 32px));height:min(650px,calc(100vh - 120px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.22);display:none;overflow:hidden;font-family:inherit}
      .iori-assistant-head{padding:14px 16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;background:#111827;color:white}
      .iori-assistant-head h3{margin:0;font-size:16px}.iori-assistant-head button{border:0;background:transparent;color:white;font-size:22px;cursor:pointer}
      .iori-assistant-body{display:flex;flex-direction:column;height:calc(100% - 52px)}
      #ioriAssistantMessages{flex:1;overflow:auto;padding:14px;background:#f8fafc}.iori-assistant-msg{max-width:88%;padding:10px 12px;border-radius:12px;margin-bottom:10px;white-space:pre-wrap;font-size:14px;line-height:1.55}.iori-assistant-msg.user{margin-left:auto;background:#2563eb;color:#fff}.iori-assistant-msg.ai{background:#fff;border:1px solid #e5e7eb;color:#111827}
      #ioriAssistantResults,#ioriAssistantActions{padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff;max-height:190px;overflow:auto}.iori-assistant-result{padding:8px 0;border-bottom:1px solid #f1f5f9}.iori-assistant-result:last-child{border-bottom:0}.iori-assistant-result-title{font-weight:600;font-size:13px}.iori-assistant-result a{font-size:12px;color:#2563eb;word-break:break-all}.iori-assistant-result-meta{font-size:12px;color:#64748b;margin-top:3px}.iori-assistant-action-row{padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155}
      .iori-assistant-actions-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.iori-assistant-actions-footer button{border:0;border-radius:8px;padding:8px 12px;cursor:pointer}.iori-assistant-apply{background:#16a34a;color:#fff}.iori-assistant-cancel{background:#e5e7eb;color:#111827}.iori-assistant-undo{background:#f59e0b;color:white;display:none}
      .iori-assistant-input{border-top:1px solid #e5e7eb;padding:10px;background:#fff}.iori-assistant-input textarea{width:100%;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:10px;font-size:14px;min-height:64px;outline:none}.iori-assistant-input-row{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px}.iori-assistant-hint{font-size:11px;color:#64748b;line-height:1.3}.iori-assistant-send{border:0;border-radius:8px;background:#111827;color:#fff;padding:8px 14px;cursor:pointer;white-space:nowrap}
      @media(max-width:640px){#ioriAssistantFab{right:16px;bottom:16px}#ioriAssistantPanel{right:16px;bottom:78px;height:calc(100vh - 100px)}}
    `;
    document.head.appendChild(style);

    const fab = el('button', { id: 'ioriAssistantFab', type: 'button', title: 'AI 书签助手', 'aria-label': '打开 AI 书签助手' }, '✨');
    const panel = el('div', { id: 'ioriAssistantPanel' });
    panel.innerHTML = `
      <div class="iori-assistant-head"><h3>AI 书签助手</h3><button type="button" id="ioriAssistantClose">×</button></div>
      <div class="iori-assistant-body">
        <div id="ioriAssistantMessages"></div>
        <div id="ioriAssistantResults" style="display:none"></div>
        <div id="ioriAssistantActions" style="display:none">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">待确认变更</div>
          <div id="ioriAssistantActionList"></div>
          <div class="iori-assistant-actions-footer">
            <button type="button" id="ioriAssistantCancel" class="iori-assistant-cancel">取消</button>
            <button type="button" id="ioriAssistantApply" class="iori-assistant-apply">确认执行</button>
          </div>
        </div>
        <div class="iori-assistant-input">
          <textarea id="ioriAssistantInput" placeholder="例如：找一下那个测试 TCP 重传的网站；或把 VPS 相关书签重新分类"></textarea>
          <div class="iori-assistant-input-row">
            <div>
              <div class="iori-assistant-hint">查找不会修改数据；修改类任务会先给你预览。</div>
              <button type="button" id="ioriAssistantUndo" class="iori-assistant-undo">撤销本次修改</button>
            </div>
            <button type="button" id="ioriAssistantSend" class="iori-assistant-send">发送</button>
          </div>
        </div>
      </div>`;

    document.body.append(fab, panel);
    appendMessage('ai', '你好，我可以帮你模糊查找收藏的网站，也可以根据你的指令重命名、修改描述或重新分类。涉及修改时，我会先给出变更预览。');

    fab.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });
    document.getElementById('ioriAssistantClose').addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('ioriAssistantSend').addEventListener('click', sendMessage);
    document.getElementById('ioriAssistantApply').addEventListener('click', applyActions);
    document.getElementById('ioriAssistantCancel').addEventListener('click', () => renderActions([]));
    document.getElementById('ioriAssistantUndo').addEventListener('click', undoLast);
    document.getElementById('ioriAssistantInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
  }

  window.IoriAdminAssistant = { init: buildUi };
  buildUi();
})();
