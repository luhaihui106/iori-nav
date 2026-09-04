(function () {
  function loadAssistantScript() {
    if (window.IoriAdminAssistant || document.querySelector('script[data-iori-assistant]')) return;
    const script = document.createElement('script');
    script.src = '/js/admin-assistant.js';
    script.async = true;
    script.dataset.ioriAssistant = 'true';
    script.onerror = () => console.error('Failed to load AI assistant script');
    document.body.appendChild(script);
  }

  function initAdminPage() {
    window.AdminBookmarkList?.init?.();
    window.AdminPending?.init?.();
    window.AdminTabs?.init?.();
    window.AdminBookmarkPrivacy?.init?.();

    window.loadGlobalCategories?.()
      ?.catch?.(err => console.error('Failed to load categories:', err));

    loadAssistantScript();
  }

  initAdminPage();
})();
