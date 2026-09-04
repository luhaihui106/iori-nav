(function () {
  function loadScript(src, datasetKey, readyCheck, errorLabel, onload) {
    if (readyCheck?.()) {
      onload?.();
      return;
    }

    const existing = document.querySelector(`script[${datasetKey}]`);
    if (existing) {
      if (onload) existing.addEventListener('load', onload, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.setAttribute(datasetKey, 'true');
    script.onload = () => onload?.();
    script.onerror = () => console.error(`Failed to load ${errorLabel}`);
    document.body.appendChild(script);
  }

  function loadBuildInfoScript() {
    loadScript(
      '/js/admin-build-info.js',
      'data-iori-build-info',
      () => Boolean(window.IoriBuildInfo),
      'admin build info'
    );
  }

  function loadCategoryBatchScript() {
    loadScript(
      '/js/admin-category-batch.js?v=category-batch-r1-20260905',
      'data-iori-category-batch',
      () => Boolean(window.IoriCategoryBatch),
      'category batch management'
    );
  }

  function loadQualityFixesScript() {
    loadScript(
      '/js/admin-quality-fixes.js',
      'data-iori-quality-fixes',
      () => Boolean(window.IoriAdminQualityFixes),
      'admin quality fixes'
    );
  }

  function loadAssistantWindowStateScript() {
    loadScript(
      '/js/admin-assistant-window-state.js',
      'data-iori-assistant-window-state',
      () => Boolean(window.IoriAssistantWindowStateFix),
      'AI assistant window state fixes',
      loadQualityFixesScript
    );
  }

  function loadAssistantWindowScript() {
    loadScript(
      '/js/admin-assistant-window.js',
      'data-iori-assistant-window',
      () => Boolean(window.IoriAssistantWindow),
      'AI assistant window enhancement',
      loadAssistantWindowStateScript
    );
  }

  function loadAssistantScript() {
    loadScript(
      '/js/admin-assistant.js',
      'data-iori-assistant',
      () => Boolean(window.IoriAdminAssistant),
      'AI assistant script',
      loadAssistantWindowScript
    );
  }

  function loadAssistantMemoryScript() {
    loadScript(
      '/js/admin-assistant-memory.js',
      'data-iori-assistant-memory',
      () => Boolean(window.IoriAssistantMemory),
      'AI assistant memory script',
      loadAssistantScript
    );
  }

  function loadFallbackSettingsScript() {
    loadScript(
      '/js/admin-settings-fallback.js',
      'data-iori-fallback-settings',
      () => Boolean(window.AdminSettings?.fallback),
      'AI fallback settings script'
    );
  }

  function initAdminPage() {
    window.AdminBookmarkList?.init?.();
    window.AdminPending?.init?.();
    window.AdminTabs?.init?.();
    window.AdminBookmarkPrivacy?.init?.();

    window.loadGlobalCategories?.()
      ?.catch?.(err => console.error('Failed to load categories:', err));

    loadBuildInfoScript();
    loadCategoryBatchScript();
    loadFallbackSettingsScript();
    loadAssistantMemoryScript();
  }

  initAdminPage();
})();
