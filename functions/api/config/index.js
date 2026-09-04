// functions/api/config/index.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { escapeLikePattern, buildFaviconUrl, getUrlMatchCandidates, normalizeUrlForStorage, parsePagination } from '../../lib/utils';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeBookmarkName, normalizeBookmarkUrl } from '../../lib/validators';

const MAX_CONFIG_SEARCH_KEYWORD_LENGTH = 100;

function booleanParam(value, fallback = true) {
  if (value === null || value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const catalog = url.searchParams.get('catalog');
  const catalogId = url.searchParams.get('catalogId');
  const includeDescendants = booleanParam(url.searchParams.get('includeDescendants'), true);
  const { page, pageSize, offset } = parsePagination(url.searchParams, { maxPageSize: 200 });
  const keyword = (url.searchParams.get('keyword') || '').trim();

  if (keyword.length > MAX_CONFIG_SEARCH_KEYWORD_LENGTH) {
    return errorResponse(`搜索关键词不能超过 ${MAX_CONFIG_SEARCH_KEYWORD_LENGTH} 个字符`, 400);
  }

  const isAuthenticated = await isAdminAuthenticated(request, env);
  const includePrivate = isAuthenticated ? 1 : 0;

  try {
    let cte = '';
    let cteBindParams = [];
    let queryBase = `FROM sites s WHERE (s.is_private = 0 OR ? = 1)`;
    let queryBindParams = [includePrivate];
    let categoryScope = null;

    if (catalogId) {
      if (includeDescendants) {
        cte = `WITH RECURSIVE category_scope(id) AS (
          SELECT id FROM category WHERE id = ?
          UNION ALL
          SELECT c.id FROM category c JOIN category_scope cs ON c.parent_id = cs.id
        )`;
        cteBindParams.push(catalogId);
        queryBase += ` AND s.catelog_id IN (SELECT id FROM category_scope)`;

        const scopeRows = await env.NAV_DB.prepare(`
          WITH RECURSIVE category_scope(id, catelog, parent_id) AS (
            SELECT id, catelog, parent_id FROM category WHERE id = ?
            UNION ALL
            SELECT c.id, c.catelog, c.parent_id FROM category c JOIN category_scope cs ON c.parent_id = cs.id
          )
          SELECT id, catelog, parent_id FROM category_scope ORDER BY id
        `).bind(catalogId).all();
        const rows = scopeRows.results || [];
        categoryScope = {
          requestedId: Number(catalogId),
          requestedName: rows[0]?.catelog || '',
          includedIds: rows.map(row => Number(row.id)),
          descendantCount: Math.max(0, rows.length - 1),
        };
      } else {
        queryBase += ` AND s.catelog_id = ?`;
        queryBindParams.push(catalogId);
      }
    } else if (catalog) {
      queryBase += ` AND s.catelog_name = ?`;
      queryBindParams.push(catalog);
    }

    if (keyword) {
      const escaped = escapeLikePattern(keyword);
      queryBase += ` AND (name LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR catelog_name LIKE ? ESCAPE '\\' OR s.desc LIKE ? ESCAPE '\\')`;
      queryBindParams.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }

    const query = `${cte} SELECT * ${queryBase} ORDER BY sort_order ASC, create_time DESC LIMIT ? OFFSET ?`;
    const countQuery = `${cte} SELECT COUNT(*) as total ${queryBase}`;

    const baseBindParams = [...cteBindParams, ...queryBindParams];
    const fullBindParams = [...baseBindParams, pageSize, offset];
    const { results } = await env.NAV_DB.prepare(query).bind(...fullBindParams).all();
    const countResult = await env.NAV_DB.prepare(countQuery).bind(...baseBindParams).first();
    const total = Number(countResult?.total || 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const safePage = total === 0 ? 0 : Math.min(page, totalPages);

    return jsonResponse({
      code: 200,
      data: results,
      total,
      page: safePage,
      pageSize,
      totalPages,
      includeDescendants: Boolean(catalogId && includeDescendants),
      categoryScope,
    });
  } catch (e) {
    return errorResponse(`Failed to fetch config data: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelogId, sort_order, is_private } = config;
    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';

    const nameResult = normalizeBookmarkName(name);
    if (!nameResult.ok) return errorResponse(nameResult.message, 400);

    const urlResult = normalizeBookmarkUrl(url);
    if (!urlResult.ok) return errorResponse(urlResult.message, 400);

    const logoResult = normalizeBookmarkLogo(logo, { nullIfEmpty: true });
    if (!logoResult.ok) return errorResponse(logoResult.message, 400);

    const descResult = normalizeBookmarkDesc(desc, { nullIfEmpty: true });
    if (!descResult.ok) return errorResponse(descResult.message, 400);

    const sanitizedName = nameResult.value;
    const rawUrl = urlResult.value;
    const sanitizedUrl = normalizeUrlForStorage(rawUrl);
    let sanitizedLogo = logoResult.value;
    const sanitizedDesc = descResult.value;
    const sortOrderValue = normalizeSortOrder(sort_order);
    const isPrivateValue = is_private ? 1 : 0;

    if (!catelogId) {
      return errorResponse('Catelog is required', 400);
    }

    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const urlCandidates = getUrlMatchCandidates(rawUrl);
    const placeholders = urlCandidates.map(() => '?').join(',');
    const existingSite = await env.NAV_DB.prepare(`SELECT id FROM sites WHERE url IN (${placeholders})`).bind(...urlCandidates).first();
    if (existingSite) {
      return errorResponse('该 URL 已存在，请勿重复添加', 409);
    }

    sanitizedLogo = buildFaviconUrl(sanitizedUrl, sanitizedLogo, iconAPI);
    const categoryResult = await env.NAV_DB.prepare('SELECT catelog, is_private FROM category WHERE id = ?').bind(catelogId).first();

    if (!categoryResult) {
      return errorResponse('Category not found.', 400);
    }

    let finalIsPrivate = isPrivateValue;
    if (categoryResult.is_private === 1) {
      finalIsPrivate = 1;
    }

    const insert = await env.NAV_DB.prepare(`
      INSERT INTO sites (name, url, logo, desc, catelog_id, catelog_name, sort_order, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, catelogId, categoryResult.catelog, sortOrderValue, finalIsPrivate).run();

    await markHomeCacheDirty(env, finalIsPrivate ? 'private' : 'all');

    return jsonResponse({
      code: 201,
      message: 'Config created successfully',
      insert
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to create config: ${e.message}`, 500);
  }
}
