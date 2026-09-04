(function () {
  if (window.IoriCategoryBatch) return;

  const API = '/api/categories/batch';
  const selectedIds = new Set();
  let lastVisibleSignature = '';
  let modalEl = null;

  function escapeHtml(value) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(String(value ?? ''));
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function categories() {
    return Array.isArray(window.categoriesData) ? window.categoriesData : [];
  }

  function categoryMap() {
    return new Map(categories().map(item => [Number(item.id), item]));
  }

  function getCategory(id) {
    return categoryMap().get(Number(id)) || null;
  }

  function visibleIds() {
    const grid = document.getElementById('categoryGrid');
    if (!grid) return [];
    return [...grid.querySelectorAll('.site-card[data-id]')]
      .map(card => Number(card.dataset.id))
      .filter(Boolean);
  }

  function showMessage(message, type = 'info') {
    if (typeof window.showMessage === 'function') {
      window.showMessage(message, type);
      return;
    }
    alert(message);
  }

  async function postBatch(payload) {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok || data?.code !== 200) {
      const error = new Error(data?.message || `请求失败 (${response.status})`);
      error.status = response.status;
      error.data = data?.data;
      throw error;
    }
    return data.data || {};
  }

  function categoryPathName(id) {
    const map = categoryMap();
    const parts = [];
    let current = map.get(Number(id));
    let guard = 0;
    while (current && guard++ < map.size + 2) {
      parts.unshift(current.catelog || `#${current.id}`);
      const parentId = Number(current.parent_id) || 0;
      current = parentId ? map.get(parentId) : null;
    }
    return parts.join(' / ');
  }

  function isDescendant(candidateId, ancestorId) {
    const map = categoryMap();
    let current = map.get(Number(candidateId));
    let guard = 0;
    while (current && guard++ < map.size + 2) {
      const parentId = Number(current.parent_id) || 0;
      if (!parentId) return false;
      if (parentId === Number(ancestorId)) return true;
      current = map.get(parentId);
    }
    return false;
  }

  function targetOptions({ allowRoot = false, excludeSelectedAndDescendants = false, rowId = 0 } = {}) {
    const selected = new Set([...selectedIds].map(Number));
    const list = [];
    if (allowRoot) list.push('<option value="0">顶级分类</option>');
    for (const category of categories()) {
      const id = Number(category.id);
      if (!id) continue;
      if (rowId && (id === Number(rowId) || isDescendant(id, rowId))) continue;
      if (excludeSelectedAndDescendants) {
        if (selected.has(id)) continue;
        let blocked = false;
        for (const selectedId of selected) {
          if (isDescendant(id, selectedId)) { blocked = true; break; }
        }
        if (blocked) continue;
      }
      list.push(`<option value="${id}">${escapeHtml(categoryPathName(id))} (#${id})</option>`);
    }
    return list.join('');
  }

  function selectedCategories() {
    const map = categoryMap();
    return [...selectedIds].map(id => map.get(Number(id))).filter(Boolean);
  }

  function ensureStyles() {
    if (document.getElementById('ioriCategoryBatchStyles')) return;
    const style = document.createElement('style');
    style.id = 'ioriCategoryBatchStyles';
    style.textContent = `
      #categoryBatchToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px;padding:10px 12px;border:1px solid #e9d5ff;background:#faf5ff;border-radius:12px;position:relative;z-index:20}
      #categoryBatchToolbar .cb-spacer{flex:1}.cb-toolbar-btn{border:1px solid #d8b4fe;background:#fff;color:#6b21a8;border-radius:8px;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}.cb-toolbar-btn:hover{background:#f3e8ff}.cb-toolbar-btn.danger{border-color:#fecaca;color:#b91c1c}.cb-toolbar-btn.danger:hover{background:#fef2f2}.cb-toolbar-btn:disabled{opacity:.45;cursor:not-allowed}
      .category-batch-selector{position:absolute;left:9px;top:9px;z-index:40;width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.96);border:1px solid #d8b4fe;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.08);cursor:pointer}.category-batch-selector input{width:16px;height:16px;accent-color:#7e22ce;cursor:pointer}.category-batch-selected{outline:2px solid #a855f7!important;outline-offset:1px;background:#faf5ff!important}
      #categoryBatchModal{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:5000;display:flex;align-items:center;justify-content:center;padding:18px}.cb-modal-card{width:min(760px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 20px 55px rgba(0,0,0,.25)}.cb-modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #e5e7eb}.cb-modal-head h3{font-size:17px;font-weight:700;margin:0}.cb-modal-close{border:0;background:transparent;font-size:25px;color:#64748b;cursor:pointer}.cb-modal-body{padding:16px 18px}.cb-modal-actions{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid #e5e7eb;position:sticky;bottom:0;background:#fff}.cb-btn{padding:9px 14px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px;font-weight:600}.cb-btn.primary{background:#7e22ce;color:#fff;border-color:#7e22ce}.cb-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626}.cb-btn:disabled{opacity:.5;cursor:not-allowed}.cb-field{margin-bottom:12px}.cb-field label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:5px}.cb-field select,.cb-field input{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px 9px;font-size:13px;background:#fff}.cb-note{font-size:12px;color:#64748b;line-height:1.65}.cb-warning{padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:12px;line-height:1.6}.cb-danger-note{padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#991b1b;font-size:12px;line-height:1.6}.cb-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.cb-summary>div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;text-align:center}.cb-summary strong{display:block;font-size:18px;color:#0f172a}.cb-summary span{font-size:11px;color:#64748b}.cb-edit-table{width:100%;border-collapse:collapse;font-size:12px}.cb-edit-table th,.cb-edit-table td{padding:7px;border-bottom:1px solid #e5e7eb;vertical-align:top}.cb-edit-table th{text-align:left;color:#64748b;background:#f8fafc;position:sticky;top:0}.cb-edit-table input,.cb-edit-table select{width:100%;min-width:110px;border:1px solid #d1d5db;border-radius:6px;padding:6px}.cb-muted{color:#94a3b8;font-size:11px}
      @media(max-width:640px){#categoryBatchToolbar{position:sticky;bottom:8px;box-shadow:0 8px 30px rgba(76,29,149,.18);padding:8px;gap:6px}#categoryBatchToolbar .cb-spacer{display:none}.cb-toolbar-btn{padding:7px 8px;font-size:11px}.cb-summary{grid-template-columns:1fr}.cb-modal-card{max-height:92vh}.cb-edit-table{min-width:680px}.cb-table-wrap{overflow:auto}}
    `;
    document.head.appendChild(style);
  }

  function ensureToolbar() {
    const grid = document.getElementById('categoryGrid');
    if (!grid || document.getElementById('categoryBatchToolbar')) return;
    const toolbar = document.createElement('div');
    toolbar.id = 'categoryBatchToolbar';
    toolbar.innerHTML = `
      <button type="button" class="cb-toolbar-btn" id="categoryBatchSelectAll">全选当前层</button>
      <button type="button" class="cb-toolbar-btn" id="categoryBatchClear">取消选择</button>
      <strong id="categoryBatchCount" style="font-size:12px;color:#6b21a8">已选择 0 个</strong>
      <span class="cb-spacer"></span>
      <button type="button" class="cb-toolbar-btn" data-cb-action="edit">批量编辑</button>
      <button type="button" class="cb-toolbar-btn" data-cb-action="move">移动到</button>
      <button type="button" class="cb-toolbar-btn" data-cb-action="public">设为公开</button>
      <button type="button" class="cb-toolbar-btn" data-cb-action="private">设为私密</button>
      <button type="button" class="cb-toolbar-btn danger" data-cb-action="delete">删除</button>`;
    grid.parentNode.insertBefore(toolbar, grid);

    toolbar.querySelector('#categoryBatchSelectAll').addEventListener('click', () => {
      visibleIds().forEach(id => selectedIds.add(id));
      decorateCards(false);
      updateToolbar();
    });
    toolbar.querySelector('#categoryBatchClear').addEventListener('click', clearSelection);
    toolbar.querySelectorAll('[data-cb-action]').forEach(button => {
      button.addEventListener('click', () => handleToolbarAction(button.dataset.cbAction));
    });
    updateToolbar();
  }

  function updateToolbar() {
    const count = document.getElementById('categoryBatchCount');
    if (count) count.textContent = `已选择 ${selectedIds.size} 个`;
    document.querySelectorAll('#categoryBatchToolbar [data-cb-action]').forEach(button => {
      button.disabled = selectedIds.size === 0;
    });
  }

  function clearSelection() {
    selectedIds.clear();
    decorateCards(false);
    updateToolbar();
  }

  function decorateCards(resetOnLevelChange = true) {
    ensureToolbar();
    const grid = document.getElementById('categoryGrid');
    if (!grid) return;
    const cards = [...grid.querySelectorAll('.site-card[data-id]')];
    const signature = cards.map(card => card.dataset.id).join(',');
    if (resetOnLevelChange && signature !== lastVisibleSignature && lastVisibleSignature) {
      selectedIds.clear();
    }
    if (signature) lastVisibleSignature = signature;

    cards.forEach(card => {
      const id = Number(card.dataset.id);
      if (!id) return;
      let label = card.querySelector('.category-batch-selector');
      if (!label) {
        label = document.createElement('label');
        label.className = 'category-batch-selector';
        label.title = '选择分类';
        label.innerHTML = `<input type="checkbox" aria-label="选择分类 #${id}">`;
        label.addEventListener('click', event => event.stopPropagation());
        label.addEventListener('pointerdown', event => event.stopPropagation());
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedIds.add(id);
          else selectedIds.delete(id);
          card.classList.toggle('category-batch-selected', checkbox.checked);
          updateToolbar();
        });
        card.appendChild(label);
      }
      const checkbox = label.querySelector('input');
      const checked = selectedIds.has(id);
      checkbox.checked = checked;
      card.classList.toggle('category-batch-selected', checked);
    });
    updateToolbar();
  }

  function closeModal() {
    if (modalEl) modalEl.remove();
    modalEl = null;
    document.body.classList.remove('modal-open');
  }

  function openModal({ title, bodyHtml, confirmText = '确认', danger = false, onConfirm, cancelText = '取消' }) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.id = 'categoryBatchModal';
    overlay.innerHTML = `
      <div class="cb-modal-card" role="dialog" aria-modal="true">
        <div class="cb-modal-head"><h3>${escapeHtml(title)}</h3><button type="button" class="cb-modal-close">×</button></div>
        <div class="cb-modal-body">${bodyHtml}</div>
        <div class="cb-modal-actions">
          <button type="button" class="cb-btn cb-cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="cb-btn ${danger ? 'danger' : 'primary'} cb-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');
    modalEl = overlay;
    const cancel = overlay.querySelector('.cb-cancel');
    const close = overlay.querySelector('.cb-modal-close');
    const confirm = overlay.querySelector('.cb-confirm');
    cancel.addEventListener('click', closeModal);
    close.addEventListener('click', closeModal);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeModal(); });
    confirm.addEventListener('click', async () => {
      if (!onConfirm) return closeModal();
      confirm.disabled = true;
      const oldText = confirm.textContent;
      confirm.textContent = '处理中...';
      try {
        await onConfirm(overlay);
      } catch (error) {
        showMessage(error.message || String(error), 'error');
      } finally {
        if (document.body.contains(confirm)) {
          confirm.disabled = false;
          confirm.textContent = oldText;
        }
      }
    });
    return overlay;
  }

  async function refreshAfterOperation(message) {
    closeModal();
    clearSelection();
    showMessage(message, 'success');
    if (typeof window.fetchCategories === 'function') window.fetchCategories();
    if (typeof window.fetchConfigs === 'function') window.fetchConfigs();
    if (typeof window.loadGlobalCategories === 'function') {
      try { await window.loadGlobalCategories(); } catch (error) { console.warn('Failed to refresh global categories:', error); }
    }
  }

  function requireSelection() {
    if (!selectedIds.size) {
      showMessage('请先选择至少一个分类', 'error');
      return false;
    }
    return true;
  }

  function handleToolbarAction(action) {
    if (!requireSelection()) return;
    if (action === 'edit') return openBatchEdit();
    if (action === 'move') return openBatchMove();
    if (action === 'public') return confirmVisibility(false);
    if (action === 'private') return confirmVisibility(true);
    if (action === 'delete') return openBatchDelete();
  }

  function openBatchEdit() {
    const items = selectedCategories();
    const rows = items.map(item => {
      const parentId = Number(item.parent_id) || 0;
      const options = targetOptions({ allowRoot: true, rowId: Number(item.id) })
        .replace(`value="${parentId}"`, `value="${parentId}" selected`);
      const sort = item.sort_order == null || Number(item.sort_order) === 9999 ? '' : Number(item.sort_order);
      return `<tr data-id="${Number(item.id)}">
        <td><strong>#${Number(item.id)}</strong><div class="cb-muted">书签 ${Number(item.site_count || 0)}</div></td>
        <td><input data-field="name" value="${escapeHtml(item.catelog || '')}"></td>
        <td><select data-field="parent">${options}</select></td>
        <td><input data-field="sort" type="number" min="0" max="9999" value="${sort}"></td>
      </tr>`;
    }).join('');

    openModal({
      title: `批量编辑 ${items.length} 个分类`,
      confirmText: '校验并保存',
      bodyHtml: `<div class="cb-note" style="margin-bottom:10px">可逐行修改名称、父分类和排序。后端会整体检查重名和循环引用后再写入。</div><div class="cb-table-wrap"><table class="cb-edit-table"><thead><tr><th>ID</th><th>分类名称</th><th>父分类</th><th>排序</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      onConfirm: async modal => {
        const payloadItems = [...modal.querySelectorAll('tbody tr')].map(row => ({
          id: Number(row.dataset.id),
          catelog: row.querySelector('[data-field="name"]').value.trim(),
          parent_id: Number(row.querySelector('[data-field="parent"]').value || 0),
          sort_order: row.querySelector('[data-field="sort"]').value.trim(),
        }));
        await postBatch({ operation: 'update', items: payloadItems, dryRun: true });
        closeModal();
        openModal({
          title: '确认批量编辑',
          bodyHtml: `<div class="cb-warning">已通过服务器预检。将一次修改 <strong>${payloadItems.length}</strong> 个分类的名称/父级/排序。不会删除书签。</div>`,
          confirmText: '确认保存',
          onConfirm: async () => {
            const result = await postBatch({ operation: 'update', items: payloadItems });
            await refreshAfterOperation(`批量编辑完成：修改分类 ${result.updatedCategories || payloadItems.length} 个`);
          },
        });
      },
    });
  }

  function openBatchMove() {
    const ids = [...selectedIds].map(Number);
    openModal({
      title: `移动 ${ids.length} 个分类`,
      bodyHtml: `<div class="cb-field"><label>目标父分类</label><select id="cbMoveTarget"><option value="0">顶级分类</option>${targetOptions({ excludeSelectedAndDescendants: true })}</select></div><div class="cb-note">所有已选分类会移动到同一个父级。目标不能是所选分类本身或其后代。</div>`,
      confirmText: '预检并继续',
      onConfirm: async modal => {
        const targetParentId = Number(modal.querySelector('#cbMoveTarget').value || 0);
        const preview = await postBatch({ operation: 'move', categoryIds: ids, targetParentId, dryRun: true });
        closeModal();
        openModal({
          title: '确认批量移动',
          bodyHtml: `<div class="cb-warning">将移动 <strong>${preview.movedCategories || ids.length}</strong> 个分类到：<strong>${escapeHtml(preview.targetParentName || '顶级分类')}</strong>。不会删除书签。</div>`,
          confirmText: '确认移动',
          onConfirm: async () => {
            const result = await postBatch({ operation: 'move', categoryIds: ids, targetParentId });
            await refreshAfterOperation(`批量移动完成：${result.movedCategories || ids.length} 个分类`);
          },
        });
      },
    });
  }

  async function confirmVisibility(isPrivate) {
    const ids = [...selectedIds].map(Number);
    try {
      const preview = await postBatch({ operation: 'visibility', categoryIds: ids, isPrivate, dryRun: true });
      openModal({
        title: isPrivate ? '批量设为私密' : '批量设为公开',
        bodyHtml: `<div class="cb-warning">将处理 <strong>${preview.updatedCategories || ids.length}</strong> 个分类。</div><p class="cb-note" style="margin-top:10px">${escapeHtml(preview.note || '')}</p>`,
        confirmText: isPrivate ? '确认设为私密' : '确认设为公开',
        onConfirm: async () => {
          const result = await postBatch({ operation: 'visibility', categoryIds: ids, isPrivate });
          await refreshAfterOperation(`${isPrivate ? '设为私密' : '设为公开'}完成：${result.updatedCategories || ids.length} 个分类`);
        },
      });
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  async function openBatchDelete() {
    const ids = [...selectedIds].map(Number);
    let emptyPreview;
    try {
      emptyPreview = await postBatch({ operation: 'delete_empty', categoryIds: ids, dryRun: true });
    } catch (error) {
      showMessage(error.message, 'error');
      return;
    }

    const ineligibleHtml = (emptyPreview.ineligible || []).slice(0, 10).map(item => `<li>#${item.id} ${escapeHtml(item.name)}：${escapeHtml(item.reason)}</li>`).join('');
    openModal({
      title: `删除 ${ids.length} 个已选分类`,
      danger: true,
      confirmText: '继续',
      bodyHtml: `
        <div class="cb-summary"><div><strong>${emptyPreview.selectedCount || ids.length}</strong><span>已选分类</span></div><div><strong>${emptyPreview.eligibleCount || 0}</strong><span>可直接删除空分类</span></div><div><strong>${(emptyPreview.ineligible || []).length}</strong><span>含内容/子分类</span></div></div>
        ${ineligibleHtml ? `<div class="cb-warning"><strong>不能直接删除：</strong><ul style="margin:6px 0 0 18px">${ineligibleHtml}</ul></div>` : ''}
        <div class="cb-field" style="margin-top:14px"><label>删除方式</label><select id="cbDeleteMode">
          <option value="empty" ${emptyPreview.eligibleCount ? '' : 'disabled'}>仅删除可删除的空分类${emptyPreview.eligibleCount ? `（${emptyPreview.eligibleCount}个）` : ''}</option>
          <option value="migrate">迁移书签和未选中子分类后，删除全部已选分类</option>
        </select></div>
        <div class="cb-field" id="cbDeleteTargetWrap" style="display:${emptyPreview.eligibleCount ? 'none' : 'block'}"><label>迁移到目标分类</label><select id="cbDeleteTarget"><option value="">请选择目标分类</option>${targetOptions({ excludeSelectedAndDescendants: true })}</select></div>
        <div class="cb-danger-note"><strong>安全规则：</strong>本功能不会删除任何书签。选择“迁移后删除”时，所选分类的直接书签会移动到目标分类；未选中的直接子分类会重新挂到目标分类；然后才删除分类。</div>`,
      onConfirm: async modal => {
        const mode = modal.querySelector('#cbDeleteMode').value;
        if (mode === 'empty') {
          const eligibleCount = Number(emptyPreview.eligibleCount || 0);
          if (!eligibleCount) throw new Error('没有可直接删除的空分类');
          closeModal();
          openModal({
            title: '确认删除空分类',
            danger: true,
            confirmText: '确认删除空分类',
            bodyHtml: `<div class="cb-danger-note">将删除 <strong>${eligibleCount}</strong> 个空分类。不会删除书签。${eligibleCount < ids.length ? `其余 ${ids.length - eligibleCount} 个分类将保持不变。` : ''}</div>`,
            onConfirm: async () => {
              const result = await postBatch({ operation: 'delete_empty', categoryIds: ids, onlyEligible: true });
              await refreshAfterOperation(`批量删除完成：删除分类 ${result.deletedCategories || eligibleCount} 个，跳过 ${result.skippedCategories || 0} 个`);
            },
          });
          return;
        }

        const targetCategoryId = Number(modal.querySelector('#cbDeleteTarget').value || 0);
        if (!targetCategoryId) throw new Error('请选择迁移目标分类');
        const preview = await postBatch({ operation: 'delete_and_migrate', categoryIds: ids, targetCategoryId, dryRun: true });
        closeModal();
        openModal({
          title: '确认迁移并删除',
          danger: true,
          confirmText: '确认迁移并删除',
          bodyHtml: `<div class="cb-summary"><div><strong>${preview.deletedCategories || ids.length}</strong><span>删除分类</span></div><div><strong>${preview.movedBookmarks || 0}</strong><span>迁移书签</span></div><div><strong>${preview.reparentedChildren || 0}</strong><span>重新挂载子分类</span></div></div><div class="cb-danger-note">目标分类：<strong>#${preview.targetCategoryId} ${escapeHtml(preview.targetCategoryName || '')}</strong><br>不会删除任何书签。请确认目标分类正确后执行。</div>`,
          onConfirm: async () => {
            const result = await postBatch({ operation: 'delete_and_migrate', categoryIds: ids, targetCategoryId });
            await refreshAfterOperation(`迁移并删除完成：删除分类 ${result.deletedCategories || ids.length} 个，迁移书签 ${result.movedBookmarks || 0} 个，重新挂载子分类 ${result.reparentedChildren || 0} 个`);
          },
        });
      },
    });

    const modeSelect = modalEl?.querySelector('#cbDeleteMode');
    const targetWrap = modalEl?.querySelector('#cbDeleteTargetWrap');
    if (modeSelect && targetWrap) {
      modeSelect.addEventListener('change', () => {
        targetWrap.style.display = modeSelect.value === 'migrate' ? 'block' : 'none';
      });
    }
  }

  function initObserver() {
    const grid = document.getElementById('categoryGrid');
    if (!grid) return false;
    ensureStyles();
    ensureToolbar();
    decorateCards(false);
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        decorateCards(true);
      });
    });
    observer.observe(grid, { childList: true, subtree: true });
    return true;
  }

  function init() {
    if (initObserver()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (initObserver() || tries > 80) clearInterval(timer);
    }, 100);
  }

  window.IoriCategoryBatch = { init, clearSelection, selectedIds };
  init();
})();
