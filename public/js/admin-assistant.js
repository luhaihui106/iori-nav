(function () {
  if (window.IoriAdminAssistant) return;

  const SESSION_STORAGE_KEY = 'iori_assistant_session_id';
  const state = {
    actions: [],
    undoToken: '',
    sessionId: getOrCreateSessionId(),
  };

  function newSessionId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function getOrCreateSessionId() {
    try {
      const existing = localStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) return existing;
      const created = newSessionId();
      localStorage.setItem(SESSION_STORAGE_KEY, created);
      return created;
    } catch {
      return newSessionId();
    }
  }

  function resetSessionId() {
    state.sessionId = newSessionId();
    try { localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId); } catch {}
  }

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

  function messagesBox() {
    return document.getElementById('ioriAssistantMessages');
  }

  function scrollConversationToBottom() {
    const scroller = document.getElementById('ioriAssistantConversation');
    if (!scroller) return;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function appendMessage(role, text) {
    const list = messagesBox();
    if (!list) return;
    const item = el('div', {
      class: role === 'user' ? 'iori-assistant-msg user' : 'iori-assistant-msg ai'
    });
    item.textContent = text;
    list.appendChild(item);
    scrollConversationToBottom();
  }

  function renderResults(results) {
    const box = document.getElementById('ioriAssistantResults');
    if (!box) return;
    box.innerHTML = '';
    if (!Array.isArray(results) || !results.length) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'block';
    const details = el('details', { class: 'iori-assistant-card' });
    if (results.length <= 4) details.open = true;
    details.appendChild(el('summary', {}, `匹配结果 · ${results.length}`));
    const content = el('div', { class: 'iori-assistant-card-content' });

    results.forEach((item, index) => {
      const card = el('div', { class: 'iori-assistant-result' });
      const title = el('div', { class: 'iori-assistant-result-title' }, `${index + 1}. ${item.name}`);
      const url = el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.url);
      const meta = el('div', { class: 'iori-assistant-result-meta' }, [item.category, item.reason].filter(Boolean).join(' · '));
      card.append(title, url, meta);
      content.appendChild(card);
    });

    details.appendChild(content);
    box.appendChild(details);
  }

  function renderPlan(plan) {
    const box = document.getElementById('ioriAssistantPlan');
    if (!box) return;
    box.innerHTML = '';
    if (!plan || (!plan.title && !plan.summary && !plan.scope)) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'block';
    const details = el('details', { class: 'iori-assistant-card' });
    details.open = true;
    details.appendChild(el('summary', {}, plan.title || '处理方案'));
    const content = el('div', { class: 'iori-assistant-card-content' });
    if (plan.summary) content.appendChild(el('div', { class: 'iori-assistant-plan-text' }, plan.summary));
    if (plan.scope) content.appendChild(el('div', { class: 'iori-assistant-plan-scope' }, `覆盖范围：${plan.scope}`));
    if (Number(plan.estimatedChanges) > 0) {
      content.appendChild(el('div', { class: 'iori-assistant-plan-scope' }, `预计变更：约 ${plan.estimatedChanges} 项`));
    }
    details.appendChild(content);
    box.appendChild(details);
  }

  function renderTrace(items) {
    const box = document.getElementById('ioriAssistantTrace');
    if (!box) return;
    box.innerHTML = '';
    if (!Array.isArray(items) || !items.length) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'block';
    const details = el('details', { class: 'iori-assistant-trace-details' });
    details.appendChild(el('summary', {}, `执行过程 · ${items.length} 项`));
    const text = el('div', { class: 'iori-assistant-trace-text' }, items.join('；'));
    details.appendChild(text);
    box.appendChild(details);
  }

  function providerLabel(provider) {
    if (provider === 'openai') return 'OpenAI 兼容';
    if (provider === 'workers-ai') return 'Workers AI';
    if (provider === 'gemini') return 'Gemini';
    return provider || '未知';
  }

  function renderRuntime(runtime) {
    const box = document.getElementById('ioriAssistantRuntime');
    if (!box) return;
    box.innerHTML = '';
    box.className = '';

    if (!runtime || (!runtime.primaryProvider && !runtime.actualProvider)) {
      box.style.display = 'none';
      return;
    }

    const primaryName = runtime.primaryModel || providerLabel(runtime.primaryProvider);
    const finalName = runtime.finalModel || runtime.actualModel || providerLabel(runtime.finalProvider || runtime.actualProvider);
    let line = `主模型 ${primaryName} · 最终 ${finalName}`;

    if (runtime.fallbackUsed) {
      const fallbackName = runtime.fallbackActualModel || runtime.fallbackModel || providerLabel(runtime.fallbackActualProvider || runtime.fallbackProvider);
      const recovery = runtime.recoveredToPrimary ? '已恢复主模型' : '备用模型完成';
      line = `⚠ 主模型发生${runtime.fallbackReason === 'format' ? '格式异常' : '异常'} · 备用 ${fallbackName} · 最终 ${finalName} · ${recovery}`;
      box.className = 'iori-runtime-warning';
    } else {
      box.className = 'iori-runtime-ok';
    }

    box.style.display = 'block';
    box.textContent = line;
    box.title = runtime.status || line;
  }

  function actionLabel(action) {
    if (action.type === 'create_category') {
      const parent = action.parentRef ? `（父分类：${action.parentRef}）` : '';
      return `新建分类：${action.name}${parent}`;
    }
    if (action.type === 'rename_bookmark') return `重命名 #${action.siteId}：${action.currentName || ''} → ${action.name}`;
    if (action.type === 'update_description') return `修改描述 #${action.siteId}：${action.description}`;
    if (action.type === 'move_bookmark') return `移动分类 #${action.siteId}：${action.currentCategory || '未分类'} → ${action.category || action.categoryRef || action.categoryId}`;
    return '未知操作';
  }

  function renderActions(actions) {
    state.actions = Array.isArray(actions) ? actions : [];
    const panel = document.getElementById('ioriAssistantActions');
    if (!panel) return;

    panel.innerHTML = '';
    if (!state.actions.length) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    const details = el('details', { class: 'iori-assistant-card iori-actions-card' });
    details.open = true;
    details.appendChild(el('summary', {}, `待确认变更 · ${state.actions.length}`));
    const content = el('div', { class: 'iori-assistant-card-content' });
    const list = el('div', { id: 'ioriAssistantActionList' });
    state.actions.forEach(action => {
      list.appendChild(el('div', { class: 'iori-assistant-action-row' }, actionLabel(action)));
    });
    content.appendChild(list);

    const footer = el('div', { class: 'iori-assistant-actions-footer' });
    const cancel = el('button', { type: 'button', class: 'iori-assistant-cancel' }, '取消');
    const apply = el('button', { type: 'button', id: 'ioriAssistantApply', class: 'iori-assistant-apply' }, '确认执行');
    cancel.addEventListener('click', () => renderActions([]));
    apply.addEventListener('click', applyActions);
    footer.append(cancel, apply);
    content.appendChild(footer);
    details.appendChild(content);
    panel.appendChild(details);
    scrollConversationToBottom();
  }

  function clearAnalysisPanels() {
    renderActions([]);
    renderResults([]);
    renderPlan(null);
    renderTrace([]);
    renderRuntime(null);
  }

  async function sendMessage(textOverride = '') {
    const input = document.getElementById('ioriAssistantInput');
    const sendBtn = document.getElementById('ioriAssistantSend');
    const message = String(textOverride || input?.value || '').trim();
    if (!message || !sendBtn) return;

    appendMessage('user', message);
    if (input) input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '分析中…';
    clearAnalysisPanels();

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ message, sessionId: state.sessionId })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || 'AI 助手请求失败');

      if (data.data?.sessionId) {
        state.sessionId = data.data.sessionId;
        try { localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId); } catch {}
      }

      appendMessage('ai', data.data.reply || '已完成分析。');
      renderRuntime(data.data.runtime || null);
      renderTrace(data.data.toolsUsed || []);
      renderPlan(data.data.plan || null);
      renderResults(data.data.results || []);
      renderActions(data.data.actions || []);
      scrollConversationToBottom();
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
    if (!button) return;
    button.disabled = true;
    button.textContent = '执行中…';

    try {
      const response = await fetch('/api/assistant/apply', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ actions: state.actions, sessionId: state.sessionId })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) throw new Error(data.message || '执行失败');
      state.undoToken = data.data?.undoToken || '';
      appendMessage('ai', `${data.message}。如结果不满意，可点击“撤销本次修改”。`);
      renderActions([]);
      const undoButton = document.getElementById('ioriAssistantUndo');
      if (undoButton) undoButton.style.display = state.undoToken ? 'inline-flex' : 'none';
      window.fetchConfigs?.();
      window.fetchCategories?.();
      window.loadGlobalCategories?.();
    } catch (error) {
      appendMessage('ai', `执行失败：${error.message}`);
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = '确认执行';
      }
    }
  }

  async function undoLast() {
    if (!state.undoToken) return;
    const button = document.getElementById('ioriAssistantUndo');
    if (!button) return;
    button.disabled = true;
    button.textContent = '撤销中…';
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
      window.loadGlobalCategories?.();
    } catch (error) {
      appendMessage('ai', `撤销失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '撤销本次修改';
    }
  }

  function resetConversation() {
    resetSessionId();
    state.actions = [];
    state.undoToken = '';
    const list = messagesBox();
    if (list) list.innerHTML = '';
    clearAnalysisPanels();
    const undoButton = document.getElementById('ioriAssistantUndo');
    if (undoButton) undoButton.style.display = 'none';
    appendMessage('ai', '已开始新对话。你可以让我查找网站、分析书签库或规划分类；涉及写操作时会先生成预览。');
  }

  function bindQuickPrompts() {
    document.querySelectorAll('[data-iori-agent-prompt]').forEach(button => {
      button.addEventListener('click', () => sendMessage(button.dataset.ioriAgentPrompt || ''));
    });
  }

  function buildUi() {
    const style = el('style');
    style.textContent = `
      #ioriAssistantFab{position:fixed;right:24px;bottom:24px;z-index:4500;width:52px;height:52px;border:0;border-radius:50%;background:#111827;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.22);cursor:pointer;font-size:22px}
      #ioriAssistantPanel{position:fixed;right:24px;bottom:88px;z-index:4499;width:min(640px,calc(100vw - 40px));height:min(780px,calc(100vh - 116px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.22);display:none;overflow:hidden;font-family:inherit}
      .iori-assistant-head{height:52px;padding:0 14px 0 16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;background:#111827;color:white}.iori-assistant-head h3{margin:0;font-size:16px}.iori-assistant-head-actions{display:flex;gap:8px;align-items:center}.iori-assistant-head button{border:0;background:transparent;color:white;cursor:pointer}.iori-assistant-new{font-size:12px;padding:6px 8px!important;border:1px solid rgba(255,255,255,.25)!important;border-radius:7px!important}.iori-assistant-close{font-size:22px!important}
      .iori-assistant-body{display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:calc(100% - 52px);background:#f8fafc}
      .iori-assistant-quick{display:flex;gap:6px;overflow-x:auto;padding:9px 10px;border-bottom:1px solid #e5e7eb;background:#fff}.iori-assistant-quick button{border:1px solid #dbe2ea;background:#f8fafc;color:#334155;border-radius:999px;padding:6px 10px;font-size:12px;white-space:nowrap;cursor:pointer}.iori-assistant-quick button:hover{background:#eef2ff;border-color:#c7d2fe}
      #ioriAssistantConversation{overflow:auto;padding:14px;scroll-behavior:smooth}.iori-assistant-msg{max-width:88%;padding:10px 12px;border-radius:12px;margin-bottom:10px;white-space:pre-wrap;font-size:14px;line-height:1.58;overflow-wrap:anywhere}.iori-assistant-msg.user{margin-left:auto;background:#2563eb;color:#fff}.iori-assistant-msg.ai{background:#fff;border:1px solid #e5e7eb;color:#111827;box-shadow:0 1px 2px rgba(15,23,42,.03)}
      #ioriAssistantRuntime{margin:8px 0;padding:7px 10px;border-radius:8px;font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iori-runtime-ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}.iori-runtime-warning{background:#fff7ed;color:#9a3412;border:1px solid #fed7aa}
      #ioriAssistantTrace,#ioriAssistantPlan,#ioriAssistantResults,#ioriAssistantActions{margin-top:8px}.iori-assistant-card,.iori-assistant-trace-details{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}.iori-assistant-card>summary,.iori-assistant-trace-details>summary{cursor:pointer;list-style:none;padding:9px 11px;font-size:12px;font-weight:650;color:#334155;background:#fff}.iori-assistant-card>summary::-webkit-details-marker,.iori-assistant-trace-details>summary::-webkit-details-marker{display:none}.iori-assistant-card>summary::after,.iori-assistant-trace-details>summary::after{content:'›';float:right;transform:rotate(90deg);color:#94a3b8}.iori-assistant-card:not([open])>summary::after,.iori-assistant-trace-details:not([open])>summary::after{transform:rotate(0)}.iori-assistant-card-content{padding:0 11px 10px}.iori-assistant-trace-text{padding:0 11px 10px;font-size:11px;line-height:1.5;color:#64748b}.iori-assistant-plan-text{font-size:12px;line-height:1.55;color:#334155;white-space:pre-wrap}.iori-assistant-plan-scope{font-size:11px;color:#64748b;margin-top:5px}.iori-assistant-result{padding:8px 0;border-bottom:1px solid #f1f5f9}.iori-assistant-result:last-child{border-bottom:0}.iori-assistant-result-title{font-weight:600;font-size:13px}.iori-assistant-result a{font-size:12px;color:#2563eb;word-break:break-all}.iori-assistant-result-meta{font-size:12px;color:#64748b;margin-top:3px}.iori-assistant-action-row{padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155}.iori-assistant-action-row:last-child{border-bottom:0}
      .iori-assistant-actions-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}.iori-assistant-actions-footer button{border:0;border-radius:8px;padding:8px 12px;cursor:pointer}.iori-assistant-apply{background:#16a34a;color:#fff}.iori-assistant-cancel{background:#e5e7eb;color:#111827}.iori-assistant-undo{background:#f59e0b;color:white;display:none;border:0;border-radius:7px;padding:5px 8px;font-size:11px;cursor:pointer;margin-top:4px}
      .iori-assistant-input{border-top:1px solid #e5e7eb;padding:10px;background:#fff}.iori-assistant-input textarea{box-sizing:border-box;width:100%;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:10px;font-size:14px;min-height:62px;max-height:130px;outline:none}.iori-assistant-input textarea:focus{border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,.12)}.iori-assistant-input-row{display:flex;justify-content:space-between;align-items:flex-end;margin-top:7px;gap:8px}.iori-assistant-hint{font-size:11px;color:#64748b;line-height:1.3}.iori-assistant-send{border:0;border-radius:8px;background:#111827;color:#fff;padding:8px 14px;cursor:pointer;white-space:nowrap}.iori-assistant-send:disabled{opacity:.6;cursor:wait}
      @media(max-width:760px){#ioriAssistantFab{right:16px;bottom:16px}#ioriAssistantPanel{right:8px;bottom:76px;width:calc(100vw - 16px);height:calc(100vh - 92px);border-radius:12px}.iori-assistant-msg{max-width:94%}}
    `;
    document.head.appendChild(style);

    const fab = el('button', { id: 'ioriAssistantFab', type: 'button', title: 'AI 书签 Agent', 'aria-label': '打开 AI 书签 Agent' }, '✨');
    const panel = el('div', { id: 'ioriAssistantPanel' });
    panel.innerHTML = `
      <div class="iori-assistant-head">
        <h3>AI 书签 Agent</h3>
        <div class="iori-assistant-head-actions">
          <button type="button" id="ioriAssistantNew" class="iori-assistant-new">新对话</button>
          <button type="button" id="ioriAssistantClose" class="iori-assistant-close">×</button>
        </div>
      </div>
      <div class="iori-assistant-body">
        <div class="iori-assistant-quick">
          <button type="button" data-iori-agent-prompt="读取目前全部书签和分类，分析现有结构问题并给出重新整理方案，先不要修改。">全库分析</button>
          <button type="button" data-iori-agent-prompt="检查我的书签中是否存在完全重复的网址，列出重复项。">查重复</button>
          <button type="button" data-iori-agent-prompt="帮我分析目前没有描述的书签，给出补全描述的建议，先预览。">补描述</button>
          <button type="button" data-iori-agent-prompt="帮我找一个我记不清名字的网站。我接下来会描述它的用途。">找网站</button>
        </div>
        <div id="ioriAssistantConversation">
          <div id="ioriAssistantMessages"></div>
          <div id="ioriAssistantRuntime" style="display:none"></div>
          <div id="ioriAssistantTrace" style="display:none"></div>
          <div id="ioriAssistantPlan" style="display:none"></div>
          <div id="ioriAssistantResults" style="display:none"></div>
          <div id="ioriAssistantActions" style="display:none"></div>
        </div>
        <div class="iori-assistant-input">
          <textarea id="ioriAssistantInput" placeholder="继续追问即可，例如：把刚才那些按用途设计几个二级分类，先别修改。"></textarea>
          <div class="iori-assistant-input-row">
            <div>
              <div class="iori-assistant-hint">同一对话会保留上下文；写操作始终先预览。</div>
              <button type="button" id="ioriAssistantUndo" class="iori-assistant-undo">撤销本次修改</button>
            </div>
            <button type="button" id="ioriAssistantSend" class="iori-assistant-send">发送</button>
          </div>
        </div>
      </div>`;

    document.body.append(fab, panel);
    appendMessage('ai', '你好。你可以直接连续对话，我会按需读取书签库；分析结果、执行过程和匹配列表会折叠显示，不再挤占聊天区域。');

    fab.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });
    document.getElementById('ioriAssistantClose').addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('ioriAssistantNew').addEventListener('click', resetConversation);
    document.getElementById('ioriAssistantSend').addEventListener('click', () => sendMessage());
    document.getElementById('ioriAssistantUndo').addEventListener('click', undoLast);
    document.getElementById('ioriAssistantInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    bindQuickPrompts();
  }

  window.IoriAdminAssistant = { init: buildUi };
  buildUi();
})();
