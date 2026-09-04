(function () {
  if (window.IoriAdminQualityFixes) return;

  function fixActionLabels() {
    document.querySelectorAll('#ioriAssistantActionList .iori-assistant-action-row').forEach(row => {
      const text = row.textContent || '';
      if (text.startsWith('移动分类 #')) {
        row.textContent = text.replace(/^移动分类 #/, '移动书签 #');
      }
    });
  }

  function fixEmptyPagination() {
    const totalPages = document.getElementById('totalPages');
    const currentPage = document.getElementById('currentPage');
    const grid = document.getElementById('configGrid');
    if (!totalPages || !currentPage || !grid) return;

    const total = Number.parseInt(totalPages.textContent || '0', 10) || 0;
    const hasCards = Boolean(grid.querySelector('.site-card'));
    if (total === 0 && !hasCards) {
      if (currentPage.textContent !== '0') currentPage.textContent = '0';
      if (totalPages.textContent !== '0') totalPages.textContent = '0';
      const prev = document.getElementById('prevPage');
      const next = document.getElementById('nextPage');
      if (prev && !prev.disabled) prev.disabled = true;
      if (next && !next.disabled) next.disabled = true;
    }
  }

  function install() {
    const observer = new MutationObserver(() => {
      fixActionLabels();
      fixEmptyPagination();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    fixActionLabels();
    fixEmptyPagination();
  }

  window.IoriAdminQualityFixes = { install };
  install();
})();
