import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { normalizeCategoryName } from '../../lib/validators';

const MAX_BATCH_CATEGORIES = 100;

function asInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeIds(raw, fieldName = 'categoryIds') {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Object.assign(new Error(`${fieldName}不能为空`), { status: 400 });
  }
  if (raw.length > MAX_BATCH_CATEGORIES) {
    throw Object.assign(new Error(`单次最多操作 ${MAX_BATCH_CATEGORIES} 个分类`), { status: 400 });
  }

  const ids = raw.map(asInt);
  if (ids.some(id => !id)) {
    throw Object.assign(new Error(`${fieldName}包含非法分类ID`), { status: 400 });
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    throw Object.assign(new Error(`${fieldName}不能包含重复分类ID`), { status: 400 });
  }
  return unique;
}

function sqlPlaceholders(count) {
  return new Array(count).fill('?').join(',');
}

function createChildrenMap(categories) {
  const children = new Map();
  for (const category of categories) {
    const parentId = Number(category.parent_id) || 0;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(Number(category.id));
  }
  return children;
}

function collectDescendants(childrenMap, rootId) {
  const result = new Set();
  const stack = [...(childrenMap.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenMap.get(id) || []));
  }
  return result;
}

function findPrivateAncestor(categoryId, categoryMap, selectedPublicIds = new Set()) {
  let current = categoryMap.get(categoryId);
  let guard = 0;
  while (current && guard++ < categoryMap.size + 2) {
    const parentId = Number(current.parent_id) || 0;
    if (!parentId) return null;
    const parent = categoryMap.get(parentId);
    if (!parent) return null;
    if (Number(parent.is_private) === 1 && !selectedPublicIds.has(parentId)) return parent;
    current = parent;
  }
  return null;
}

function assertNoCycleForAffected(finalState, affectedIds) {
  for (const id of affectedIds) {
    const visited = new Set([id]);
    let parentId = Number(finalState.get(id)?.parent_id) || 0;
    let guard = 0;
    while (parentId && guard++ < finalState.size + 2) {
      if (visited.has(parentId)) {
        throw Object.assign(new Error(`分类 #${id} 的父级调整会形成循环引用`), { status: 409 });
      }
      visited.add(parentId);
      const parent = finalState.get(parentId);
      if (!parent) {
        throw Object.assign(new Error(`分类 #${id} 指定的父分类不存在`), { status: 409 });
      }
      parentId = Number(parent.parent_id) || 0;
    }
    if (guard >= finalState.size + 2) {
      throw Object.assign(new Error('分类层级异常，已拒绝批量修改'), { status: 409 });
    }
  }
}

function assertAffectedSiblingNamesUnique(finalState, affectedIds) {
  const byKey = new Map();
  for (const category of finalState.values()) {
    const key = `${Number(category.parent_id) || 0}\u0000${String(category.catelog || '')}`;
    const previous = byKey.get(key);
    if (previous && (affectedIds.has(Number(previous.id)) || affectedIds.has(Number(category.id)))) {
      throw Object.assign(
        new Error(`父分类 #${Number(category.parent_id) || 0} 下存在重名分类“${category.catelog}”`),
        { status: 409 }
      );
    }
    if (!previous) byKey.set(key, category);
  }
}

function assertTargetOutsideSelection(targetId, selectedIds, childrenMap) {
  if (!targetId) return;
  const selected = new Set(selectedIds);
  if (selected.has(targetId)) {
    throw Object.assign(new Error('目标分类不能是待操作分类本身'), { status: 409 });
  }
  for (const id of selectedIds) {
    if (collectDescendants(childrenMap, id).has(targetId)) {
      throw Object.assign(new Error('目标分类不能位于待操作分类的后代树中'), { status: 409 });
    }
  }
}

function buildPrivateSubtreeStatements(env, rootIds) {
  if (!rootIds.length) return [];
  const placeholders = sqlPlaceholders(rootIds.length);
  const cte = `
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM category WHERE id IN (${placeholders})
      UNION
      SELECT c.id FROM category c
      INNER JOIN descendants d ON c.parent_id = d.id
    )
  `;
  return [
    env.NAV_DB.prepare(`
      ${cte}
      UPDATE category
      SET is_private = 1, update_time = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM descendants)
    `).bind(...rootIds),
    env.NAV_DB.prepare(`
      ${cte}
      UPDATE sites
      SET is_private = 1, update_time = CURRENT_TIMESTAMP
      WHERE catelog_id IN (SELECT id FROM descendants)
    `).bind(...rootIds),
  ];
}

async function loadCategoryState(env) {
  const { results = [] } = await env.NAV_DB.prepare(`
    SELECT
      c.id,
      c.catelog,
      c.sort_order,
      c.parent_id,
      c.is_private,
      COUNT(s.id) AS site_count
    FROM category c
    LEFT JOIN sites s ON s.catelog_id = c.id
    GROUP BY c.id, c.catelog, c.sort_order, c.parent_id, c.is_private
  `).all();

  const categories = results.map(row => ({
    ...row,
    id: Number(row.id),
    parent_id: Number(row.parent_id) || 0,
    is_private: Number(row.is_private) || 0,
    site_count: Number(row.site_count) || 0,
  }));
  return {
    categories,
    categoryMap: new Map(categories.map(category => [category.id, category])),
    childrenMap: createChildrenMap(categories),
  };
}

function assertExistingIds(ids, categoryMap) {
  const missing = ids.filter(id => !categoryMap.has(id));
  if (missing.length) {
    throw Object.assign(new Error(`以下分类不存在：${missing.join(', ')}`), { status: 409 });
  }
}

function computeDeleteEmptyPreview(ids, categoryMap, childrenMap) {
  const selected = new Set(ids);
  const memo = new Map();
  const reasonMemo = new Map();

  const canDelete = id => {
    if (memo.has(id)) return memo.get(id);
    const category = categoryMap.get(id);
    if (!category) {
      memo.set(id, false);
      reasonMemo.set(id, '分类不存在');
      return false;
    }
    if (category.site_count > 0) {
      memo.set(id, false);
      reasonMemo.set(id, `包含 ${category.site_count} 个直接书签`);
      return false;
    }
    for (const childId of childrenMap.get(id) || []) {
      if (!selected.has(childId)) {
        memo.set(id, false);
        reasonMemo.set(id, `包含未选中的子分类 #${childId}`);
        return false;
      }
      if (!canDelete(childId)) {
        memo.set(id, false);
        reasonMemo.set(id, `子分类 #${childId} 不满足空分类删除条件`);
        return false;
      }
    }
    memo.set(id, true);
    return true;
  };

  ids.forEach(canDelete);
  const eligibleIds = ids.filter(id => memo.get(id));
  const ineligible = ids
    .filter(id => !memo.get(id))
    .map(id => ({
      id,
      name: categoryMap.get(id)?.catelog || '',
      reason: reasonMemo.get(id) || '不满足删除条件',
    }));

  return {
    selectedCount: ids.length,
    eligibleCount: eligibleIds.length,
    eligibleIds,
    ineligible,
  };
}

function checkTargetSiblingConflicts(targetId, movedIds, excludedIds, categoryMap) {
  const excluded = new Set(excludedIds);
  const moved = new Set(movedIds);
  const names = new Map();

  for (const category of categoryMap.values()) {
    if (excluded.has(category.id) || moved.has(category.id)) continue;
    if ((Number(category.parent_id) || 0) !== targetId) continue;
    names.set(String(category.catelog), category.id);
  }

  for (const id of movedIds) {
    const category = categoryMap.get(id);
    if (!category) continue;
    const name = String(category.catelog || '');
    const conflictId = names.get(name);
    if (conflictId) {
      throw Object.assign(
        new Error(`目标分类下已存在同名分类“${name}”（#${conflictId}），无法安全迁移`),
        { status: 409 }
      );
    }
    names.set(name, id);
  }
}

async function handleUpdate(env, body, state) {
  const rawItems = body?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error('items不能为空'), { status: 400 });
  }
  if (rawItems.length > MAX_BATCH_CATEGORIES) {
    throw Object.assign(new Error(`单次最多编辑 ${MAX_BATCH_CATEGORIES} 个分类`), { status: 400 });
  }

  const ids = normalizeIds(rawItems.map(item => item?.id), 'items.id');
  assertExistingIds(ids, state.categoryMap);
  const finalState = new Map([...state.categoryMap.entries()].map(([id, category]) => [id, { ...category }]));
  const normalizedItems = [];

  for (const raw of rawItems) {
    const id = asInt(raw?.id);
    const current = finalState.get(id);
    const nameResult = normalizeCategoryName(raw?.catelog);
    if (!nameResult.ok) {
      throw Object.assign(new Error(`分类 #${id}：${nameResult.message}`), { status: 400 });
    }

    const parentId = raw?.parent_id === undefined || raw?.parent_id === null || raw?.parent_id === ''
      ? Number(current.parent_id) || 0
      : Number.parseInt(raw.parent_id, 10) || 0;
    if (parentId === id) {
      throw Object.assign(new Error(`分类 #${id} 不能设置为自己的父分类`), { status: 409 });
    }
    if (parentId && !finalState.has(parentId)) {
      throw Object.assign(new Error(`分类 #${id} 的目标父分类 #${parentId} 不存在`), { status: 409 });
    }

    const sortOrder = raw?.sort_order === undefined || raw?.sort_order === null || raw?.sort_order === ''
      ? current.sort_order
      : normalizeSortOrder(raw.sort_order);
    const parentPrivate = parentId ? Number(finalState.get(parentId)?.is_private) === 1 : false;
    const next = {
      ...current,
      catelog: nameResult.value,
      parent_id: parentId,
      sort_order: sortOrder,
      is_private: parentPrivate ? 1 : Number(current.is_private) || 0,
    };
    finalState.set(id, next);
    normalizedItems.push({ id, previous: current, next });
  }

  const affectedIds = new Set(ids);
  assertNoCycleForAffected(finalState, affectedIds);
  assertAffectedSiblingNamesUnique(finalState, affectedIds);

  if (body?.dryRun) {
    return {
      dryRun: true,
      updatedCategories: normalizedItems.length,
      changes: normalizedItems.map(({ id, previous, next }) => ({
        id,
        from: { name: previous.catelog, parentId: previous.parent_id, sortOrder: previous.sort_order },
        to: { name: next.catelog, parentId: next.parent_id, sortOrder: next.sort_order },
      })),
    };
  }

  const statements = [];
  const privacyRoots = [];
  for (const { id, previous, next } of normalizedItems) {
    statements.push(env.NAV_DB.prepare(`
      UPDATE category
      SET catelog = ?, sort_order = ?, parent_id = ?, is_private = ?, update_time = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(next.catelog, next.sort_order, next.parent_id, next.is_private, id));

    if (String(previous.catelog) !== String(next.catelog)) {
      statements.push(
        env.NAV_DB.prepare('UPDATE sites SET catelog_name = ?, update_time = CURRENT_TIMESTAMP WHERE catelog_id = ?')
          .bind(next.catelog, id)
      );
    }
    if (next.is_private === 1 && previous.is_private !== 1) privacyRoots.push(id);
  }
  statements.push(...buildPrivateSubtreeStatements(env, [...new Set(privacyRoots)]));
  await env.NAV_DB.batch(statements);
  await markHomeCacheDirty(env, 'all');

  return { updatedCategories: normalizedItems.length };
}

async function handleMove(env, body, state) {
  const ids = normalizeIds(body?.categoryIds);
  assertExistingIds(ids, state.categoryMap);
  const targetParentId = body?.targetParentId === 0 || body?.targetParentId === '0' || body?.targetParentId === '' || body?.targetParentId == null
    ? 0
    : asInt(body.targetParentId);
  if (body?.targetParentId && !targetParentId) {
    throw Object.assign(new Error('目标父分类ID无效'), { status: 400 });
  }
  if (targetParentId && !state.categoryMap.has(targetParentId)) {
    throw Object.assign(new Error('目标父分类不存在'), { status: 409 });
  }

  assertTargetOutsideSelection(targetParentId, ids, state.childrenMap);
  checkTargetSiblingConflicts(targetParentId, ids, ids, state.categoryMap);

  if (body?.dryRun) {
    return {
      dryRun: true,
      movedCategories: ids.length,
      targetParentId,
      targetParentName: targetParentId ? state.categoryMap.get(targetParentId)?.catelog || '' : '顶级分类',
    };
  }

  const placeholders = sqlPlaceholders(ids.length);
  const statements = [
    env.NAV_DB.prepare(`
      UPDATE category
      SET parent_id = ?, update_time = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).bind(targetParentId, ...ids),
  ];

  const targetPrivate = targetParentId ? Number(state.categoryMap.get(targetParentId)?.is_private) === 1 : false;
  if (targetPrivate) statements.push(...buildPrivateSubtreeStatements(env, ids));

  await env.NAV_DB.batch(statements);
  await markHomeCacheDirty(env, 'all');
  return {
    movedCategories: ids.length,
    targetParentId,
    targetParentName: targetParentId ? state.categoryMap.get(targetParentId)?.catelog || '' : '顶级分类',
  };
}

async function handleVisibility(env, body, state) {
  const ids = normalizeIds(body?.categoryIds);
  assertExistingIds(ids, state.categoryMap);
  if (typeof body?.isPrivate !== 'boolean') {
    throw Object.assign(new Error('isPrivate必须为布尔值'), { status: 400 });
  }

  if (body.isPrivate === false) {
    const selected = new Set(ids);
    const blocked = ids
      .map(id => ({ id, ancestor: findPrivateAncestor(id, state.categoryMap, selected) }))
      .filter(item => item.ancestor);
    if (blocked.length) {
      const details = blocked.slice(0, 5).map(item => `#${item.id} 受私密父分类 #${item.ancestor.id} 约束`).join('；');
      throw Object.assign(new Error(`无法批量设为公开：${details}`), { status: 409 });
    }
  }

  if (body?.dryRun) {
    return {
      dryRun: true,
      updatedCategories: ids.length,
      isPrivate: body.isPrivate,
      note: body.isPrivate
        ? '设为私密会递归保护所选分类子树及其中书签'
        : '设为公开仅解除所选分类自身私密标记，不自动公开已有私密书签或未选中子分类',
    };
  }

  let statements = [];
  if (body.isPrivate) {
    statements = buildPrivateSubtreeStatements(env, ids);
  } else {
    const placeholders = sqlPlaceholders(ids.length);
    statements = [
      env.NAV_DB.prepare(`
        UPDATE category
        SET is_private = 0, update_time = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `).bind(...ids),
    ];
  }

  await env.NAV_DB.batch(statements);
  await markHomeCacheDirty(env, 'all');
  return {
    updatedCategories: ids.length,
    isPrivate: body.isPrivate,
    note: body.isPrivate
      ? '已将所选分类及其子树设为私密'
      : '已解除所选分类自身私密标记；已有私密书签和未选中子分类保持原状态',
  };
}

async function handleDeleteEmpty(env, body, state) {
  const ids = normalizeIds(body?.categoryIds);
  assertExistingIds(ids, state.categoryMap);
  const preview = computeDeleteEmptyPreview(ids, state.categoryMap, state.childrenMap);

  if (body?.dryRun) return { dryRun: true, ...preview };

  const onlyEligible = body?.onlyEligible === true;
  if (!onlyEligible && preview.eligibleCount !== preview.selectedCount) {
    throw Object.assign(new Error('部分分类不是空分类，请重新确认可删除项'), { status: 409, data: preview });
  }
  if (!preview.eligibleCount) {
    throw Object.assign(new Error('没有满足条件的空分类可删除'), { status: 409, data: preview });
  }

  const deleteIds = onlyEligible ? preview.eligibleIds : ids;
  const placeholders = sqlPlaceholders(deleteIds.length);
  await env.NAV_DB.batch([
    env.NAV_DB.prepare(`DELETE FROM category WHERE id IN (${placeholders})`).bind(...deleteIds),
  ]);
  await markHomeCacheDirty(env, 'all');

  return {
    deletedCategories: deleteIds.length,
    skippedCategories: preview.selectedCount - deleteIds.length,
    skipped: preview.ineligible,
  };
}

async function buildDeleteAndMigratePreview(body, state) {
  const ids = normalizeIds(body?.categoryIds);
  assertExistingIds(ids, state.categoryMap);
  const targetCategoryId = asInt(body?.targetCategoryId);
  if (!targetCategoryId || !state.categoryMap.has(targetCategoryId)) {
    throw Object.assign(new Error('请选择有效的迁移目标分类'), { status: 400 });
  }

  assertTargetOutsideSelection(targetCategoryId, ids, state.childrenMap);
  const selected = new Set(ids);
  const reparentedChildren = state.categories.filter(category => selected.has(category.parent_id) && !selected.has(category.id));
  checkTargetSiblingConflicts(
    targetCategoryId,
    reparentedChildren.map(category => category.id),
    ids,
    state.categoryMap
  );

  const movedBookmarks = ids.reduce((sum, id) => sum + Number(state.categoryMap.get(id)?.site_count || 0), 0);
  const target = state.categoryMap.get(targetCategoryId);
  return {
    ids,
    target,
    reparentedChildren,
    summary: {
      deletedCategories: ids.length,
      movedBookmarks,
      reparentedChildren: reparentedChildren.length,
      targetCategoryId,
      targetCategoryName: target.catelog,
      targetPrivate: Number(target.is_private) === 1,
    },
  };
}

async function handleDeleteAndMigrate(env, body, state) {
  const preview = await buildDeleteAndMigratePreview(body, state);
  if (body?.dryRun) return { dryRun: true, ...preview.summary };

  const { ids, target, reparentedChildren, summary } = preview;
  const placeholders = sqlPlaceholders(ids.length);
  const statements = [];

  if (summary.movedBookmarks > 0) {
    statements.push(env.NAV_DB.prepare(`
      UPDATE sites
      SET catelog_id = ?,
          catelog_name = ?,
          is_private = CASE WHEN ? = 1 THEN 1 ELSE is_private END,
          update_time = CURRENT_TIMESTAMP
      WHERE catelog_id IN (${placeholders})
    `).bind(target.id, target.catelog, Number(target.is_private) || 0, ...ids));
  }

  if (reparentedChildren.length) {
    const childIds = reparentedChildren.map(category => category.id);
    const childPlaceholders = sqlPlaceholders(childIds.length);
    statements.push(env.NAV_DB.prepare(`
      UPDATE category
      SET parent_id = ?, update_time = CURRENT_TIMESTAMP
      WHERE id IN (${childPlaceholders})
    `).bind(target.id, ...childIds));
    if (Number(target.is_private) === 1) {
      statements.push(...buildPrivateSubtreeStatements(env, childIds));
    }
  }

  statements.push(env.NAV_DB.prepare(`DELETE FROM category WHERE id IN (${placeholders})`).bind(...ids));
  await env.NAV_DB.batch(statements);
  await markHomeCacheDirty(env, 'all');

  return summary;
}

function sendOperationError(error) {
  const status = Number(error?.status) || 500;
  if (error?.data) {
    return jsonResponse({ code: status, message: error.message, data: error.data }, status);
  }
  return errorResponse(status >= 500 ? `批量分类操作失败: ${error.message}` : error.message, status);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  if (!env?.NAV_DB) return errorResponse('NAV_DB binding not found', 500);

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse('Invalid request body', 400);
    }

    const operation = String(body.operation || '').trim();
    const allowed = new Set(['update', 'move', 'visibility', 'delete_empty', 'delete_and_migrate']);
    if (!allowed.has(operation)) {
      return errorResponse('不支持的批量分类操作', 400);
    }

    const state = await loadCategoryState(env);
    let data;
    if (operation === 'update') data = await handleUpdate(env, body, state);
    else if (operation === 'move') data = await handleMove(env, body, state);
    else if (operation === 'visibility') data = await handleVisibility(env, body, state);
    else if (operation === 'delete_empty') data = await handleDeleteEmpty(env, body, state);
    else data = await handleDeleteAndMigrate(env, body, state);

    return jsonResponse({
      code: 200,
      message: body.dryRun ? '批量操作预检通过' : '批量分类操作完成',
      data,
    });
  } catch (error) {
    console.error('Category batch operation failed:', error);
    return sendOperationError(error);
  }
}
