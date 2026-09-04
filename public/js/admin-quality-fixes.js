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

  function fixRuntimeReason() {
    const box = document.getElementById('ioriAssistantRuntime');
    if (!box) return;
    const text = box.textContent || '';
    if (!text.startsWith('⚠ 主模型发生异常')) return;

    const detail = box.title || '';
    const mappings = [
      ['因超时', '⚠ 主模型发生超时'],
      ['因网络错误', '⚠ 主模型发生网络异常'],
      ['因服务端错误', '⚠ 主模型发生服务端异常'],
      ['因空响应', '⚠ 主模型返回空响应'],
      ['因格式错误', '⚠ 主模型发生格式异常'],
    ];
    const matched = mappings.find(([needle]) => detail.includes(needle));
    if (matched) box.textContent = text.replace('⚠ 主模型发生异常', matched[1]);
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
      fixRuntimeReason();
      fixEmptyPagination();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    fixActionLabels();
    fixRuntimeReason();
    fixEmptyPagination();
  }

  window.IoriAdminQualityFixes = { install };
  install();
})();
