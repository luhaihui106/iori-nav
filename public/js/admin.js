(function () {
  function loadScript(src, datasetKey, readyCheck, errorLabel) {
    if (readyCheck?.() || document.querySelector(`script[${datasetKey}]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.setAttribute(datasetKey, 'true');
    script.onerror = () => console.error(`Failed to load ${errorLabel}`);
    document.body.appendChild(script);
  }

  function loadAssistantScript() {
    loadScript(
      '/js/admin-assistant.js',
      'data-iori-assistant',
      () => Boolean(window.IoriAdminAssistant),
      'AI assistant script'
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

    loadFallbackSettingsScript();
    loadAssistantScript();
  }

  initAdminPage();
})();
