(function () {
  const ns = window.AdminSettings = window.AdminSettings || {};
  const DEFAULT_FALLBACK_MODEL = '@cf/google/gemma-4-26b-a4b-it';
  let initialized = false;

  function boolValue(value, defaultValue = true) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function ensureUi() {
    if (document.getElementById('aiFallbackSettings')) return;
    const tab = document.getElementById('ai-settings');
    if (!tab) return;

    const card = document.createElement('div');
    card.id = 'aiFallbackSettings';
    card.style.cssText = 'margin-top:18px;padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;';
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px;">
        <div>
          <div style="font-weight:700;color:#111827;font-size:14px;">AI Agent 备用模型</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;line-height:1.5;">主模型异常时自动切换。备用模型目前使用 Cloudflare Workers AI，需要部署环境已绑定 <code>AI</code>。</div>
        </div>
        <label class="switch" title="启用备用模型">
          <input type="checkbox" id="aiFallbackEnabled">
          <span class="slider round"></span>
        </label>
      </div>

      <div id="aiFallbackBody">
        <label class="form-label" for="aiFallbackProvider">备用提供商</label>
        <select id="aiFallbackProvider" class="form-input" style="margin-bottom:12px;">
          <option value="workers-ai">Cloudflare Workers AI</option>
        </select>

        <label class="form-label" for="aiFallbackModel">备用模型</label>
        <input id="aiFallbackModel" class="form-input" type="text" autocomplete="off" placeholder="${DEFAULT_FALLBACK_MODEL}" style="margin-bottom:12px;">
        <div style="font-size:11px;color:#64748b;margin-top:-7px;margin-bottom:14px;">建议：${DEFAULT_FALLBACK_MODEL}</div>

        <div style="font-weight:600;color:#334155;font-size:13px;margin-bottom:8px;">自动切换条件</div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;font-size:12px;color:#475569;">
          <label style="display:flex;align-items:center;gap:7px;"><input type="checkbox" id="aiFallbackOnTimeout"> 请求超时 / 网络错误</label>
          <label style="display:flex;align-items:center;gap:7px;"><input type="checkbox" id="aiFallbackOn5xx"> 上游 5xx 错误</label>
          <label style="display:flex;align-items:center;gap:7px;"><input type="checkbox" id="aiFallbackOnEmpty"> 模型空响应</label>
          <label style="display:flex;align-items:center;gap:7px;"><input type="checkbox" id="aiFallbackOnFormat"> Agent JSON 格式错误</label>
        </div>

        <div id="aiFallbackStatus" style="margin-top:14px;padding:9px 10px;border-radius:8px;background:#eef2ff;color:#3730a3;font-size:11px;line-height:1.5;"></div>
      </div>`;

    const bulkButton = document.getElementById('batchCompleteDescBtn');
    const bulkSection = bulkButton?.closest('div');
    if (bulkSection && bulkSection.parentElement === tab) {
      tab.insertBefore(card, bulkSection);
    } else {
      tab.appendChild(card);
    }
  }

  function refs() {
    return {
      enabled: document.getElementById('aiFallbackEnabled'),
      body: document.getElementById('aiFallbackBody'),
      provider: document.getElementById('aiFallbackProvider'),
      model: document.getElementById('aiFallbackModel'),
      timeout: document.getElementById('aiFallbackOnTimeout'),
      server: document.getElementById('aiFallbackOn5xx'),
      empty: document.getElementById('aiFallbackOnEmpty'),
      format: document.getElementById('aiFallbackOnFormat'),
      status: document.getElementById('aiFallbackStatus'),
    };
  }

  function syncEnabledState() {
    const r = refs();
    if (!r.enabled || !r.body) return;
    r.body.style.opacity = r.enabled.checked ? '1' : '.48';
    r.body.style.pointerEvents = r.enabled.checked ? 'auto' : 'none';
    if (r.status) {
      const mainProvider = document.getElementById('providerSelector')?.value || 'workers-ai';
      const mainModel = document.getElementById('modelName')?.value.trim() || '默认模型';
      const fallbackModel = r.model?.value.trim() || DEFAULT_FALLBACK_MODEL;
      r.status.textContent = r.enabled.checked
        ? `主模型：${mainProvider} / ${mainModel}；备用：Workers AI / ${fallbackModel}。发生已勾选故障时自动切换。`
        : '备用模型已关闭；主模型故障时 Agent 会直接返回错误。';
    }
  }

  function applyServerSettings(serverSettings, currentSettings) {
    const keys = [
      'ai_fallback_enabled', 'ai_fallback_provider', 'ai_fallback_model',
      'ai_fallback_on_timeout', 'ai_fallback_on_5xx', 'ai_fallback_on_empty', 'ai_fallback_on_format'
    ];
    keys.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(serverSettings || {}, key)) {
        currentSettings[key] = serverSettings[key];
      }
    });
  }

  function updateUI(settings = {}) {
    ensureUi();
    const r = refs();
    if (!r.enabled) return;

    r.enabled.checked = boolValue(settings.ai_fallback_enabled, true);
    if (r.provider) r.provider.value = settings.ai_fallback_provider || 'workers-ai';
    if (r.model) r.model.value = settings.ai_fallback_model || DEFAULT_FALLBACK_MODEL;
    if (r.timeout) r.timeout.checked = boolValue(settings.ai_fallback_on_timeout, true);
    if (r.server) r.server.checked = boolValue(settings.ai_fallback_on_5xx, true);
    if (r.empty) r.empty.checked = boolValue(settings.ai_fallback_on_empty, true);
    if (r.format) r.format.checked = boolValue(settings.ai_fallback_on_format, true);
    syncEnabledState();
  }

  function collect(settings) {
    ensureUi();
    const r = refs();
    if (!r.enabled) return settings;

    settings.ai_fallback_enabled = r.enabled.checked ? '1' : '0';
    settings.ai_fallback_provider = r.provider?.value || 'workers-ai';
    settings.ai_fallback_model = r.model?.value.trim() || DEFAULT_FALLBACK_MODEL;
    settings.ai_fallback_on_timeout = r.timeout?.checked ? '1' : '0';
    settings.ai_fallback_on_5xx = r.server?.checked ? '1' : '0';
    settings.ai_fallback_on_empty = r.empty?.checked ? '1' : '0';
    settings.ai_fallback_on_format = r.format?.checked ? '1' : '0';
    return settings;
  }

  function bindEvents() {
    const r = refs();
    r.enabled?.addEventListener('change', syncEnabledState);
    r.provider?.addEventListener('change', syncEnabledState);
    r.model?.addEventListener('input', syncEnabledState);
    r.timeout?.addEventListener('change', syncEnabledState);
    r.server?.addEventListener('change', syncEnabledState);
    r.empty?.addEventListener('change', syncEnabledState);
    r.format?.addEventListener('change', syncEnabledState);
    document.getElementById('providerSelector')?.addEventListener('change', syncEnabledState);
    document.getElementById('modelName')?.addEventListener('input', syncEnabledState);
  }

  function init() {
    if (initialized) return;
    ensureUi();
    if (!document.getElementById('aiFallbackSettings')) return;
    initialized = true;
    bindEvents();
    updateUI(ns.currentSettings || {});
  }

  ns.fallback = { init, applyServerSettings, updateUI, collect };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
