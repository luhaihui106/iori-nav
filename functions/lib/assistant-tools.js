const DEFAULT_PAGE_SIZE = 80;
const MAX_PAGE_SIZE = 120;
const MAX_SEARCH_TERMS = 8;
const MAX_DUPLICATE_GROUPS = 50;

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function compactBookmark(site) {
  return {
    id: Number(site.id),
    name: site.name || '',
    url: site.url || '',
    desc: site.desc || '',
    categoryId: Number(site.catelog_id) || 0,
    category: site.catelog_name || '',
    private: Number(site.is_private) === 1,
  };
}

function normalizeSearchTerms(query) {
  const text = String(query || '')
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()（）\[\]【】"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stopWords = new Set([
    '帮我', '一下', '网站', '网址', '书签', '收藏', '那个', '一个', '这个', '相关', '有关',
    '以前', '之前', '记得', '可能', '好像', '可以', '找到', '查找', '搜索', '我的', '里面',
  ]);

  const terms = [];
  for (const part of text.split(' ')) {
    if (!part) continue;

    const ascii = part.match(/[a-z0-9._:/-]{2,40}/gi) || [];
    terms.push(...ascii);

    const chinese = part.match(/[\u4e00-\u9fff]{2,8}/g) || [];
    for (const item of chinese) {
      if (!stopWords.has(item)) terms.push(item);
    }
  }

  return [...new Set(terms.map(term => term.trim()).filter(term => term.length >= 2))].slice(0, MAX_SEARCH_TERMS);
}

async function libraryStats(db) {
  const [siteStats, categoryStats] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END) AS private_count,
        SUM(CASE WHEN COALESCE(desc, '') = '' THEN 1 ELSE 0 END) AS no_desc_count,
        COUNT(DISTINCT LOWER(TRIM(url))) AS unique_urls
      FROM sites
    `).first(),
    db.prepare('SELECT COUNT(*) AS total FROM category').first(),
  ]);

  const total = Number(siteStats?.total || 0);
  const uniqueUrls = Number(siteStats?.unique_urls || 0);
  return {
    totalBookmarks: total,
    totalCategories: Number(categoryStats?.total || 0),
    privateBookmarks: Number(siteStats?.private_count || 0),
    bookmarksWithoutDescription: Number(siteStats?.no_desc_count || 0),
    duplicateUrlCountEstimate: Math.max(0, total - uniqueUrls),
  };
}

async function listCategories(db) {
  const { results } = await db.prepare(`
    SELECT c.id, c.catelog, c.parent_id, c.sort_order, c.is_private, COUNT(s.id) AS site_count
    FROM category c
    LEFT JOIN sites s ON s.catelog_id = c.id
    GROUP BY c.id, c.catelog, c.parent_id, c.sort_order, c.is_private
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();

  const rows = results || [];
  const nameMap = new Map(rows.map(row => [Number(row.id), row.catelog]));
  return rows.map(row => {
    const parentId = Number(row.parent_id) || 0;
    return {
      id: Number(row.id),
      name: row.catelog || '',
      parentId,
      parentName: parentId ? (nameMap.get(parentId) || '') : '',
      count: Number(row.site_count || 0),
      private: Number(row.is_private) === 1,
    };
  });
}

async function listBookmarks(db, args = {}) {
  const page = clampInteger(args.page, 1, 1, 100000);
  const pageSize = clampInteger(args.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const categoryId = Number.parseInt(args.categoryId, 10);
  const hasCategory = Number.isFinite(categoryId) && categoryId > 0;

  const where = hasCategory ? 'WHERE catelog_id = ?' : '';
  const countQuery = hasCategory
    ? db.prepare('SELECT COUNT(*) AS total FROM sites WHERE catelog_id = ?').bind(categoryId)
    : db.prepare('SELECT COUNT(*) AS total FROM sites');
  const dataQuery = hasCategory
    ? db.prepare(`
        SELECT id, name, url, desc, catelog_id, catelog_name, is_private
        FROM sites ${where}
        ORDER BY sort_order ASC, update_time DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(categoryId, pageSize, offset)
    : db.prepare(`
        SELECT id, name, url, desc, catelog_id, catelog_name, is_private
        FROM sites
        ORDER BY sort_order ASC, update_time DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(pageSize, offset);

  const [count, data] = await Promise.all([countQuery.first(), dataQuery.all()]);
  const total = Number(count?.total || 0);
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: offset + pageSize < total,
    bookmarks: (data.results || []).map(compactBookmark),
  };
}

async function searchBookmarks(db, args = {}) {
  const query = String(args.query || '').trim().slice(0, 300);
  const limit = clampInteger(args.limit, 40, 1, 80);
  const terms = normalizeSearchTerms(query);

  if (!terms.length) {
    const data = await listBookmarks(db, { page: 1, pageSize: Math.min(limit, MAX_PAGE_SIZE) });
    return { query, terms: [], totalReturned: data.bookmarks.length, bookmarks: data.bookmarks };
  }

  const clauses = [];
  const params = [];
  for (const term of terms) {
    clauses.push(`(
      INSTR(LOWER(COALESCE(name, '')), ?) > 0 OR
      INSTR(LOWER(COALESCE(url, '')), ?) > 0 OR
      INSTR(LOWER(COALESCE(desc, '')), ?) > 0 OR
      INSTR(LOWER(COALESCE(catelog_name, '')), ?) > 0
    )`);
    params.push(term, term, term, term);
  }

  params.push(limit);
  const { results } = await db.prepare(`
    SELECT id, name, url, desc, catelog_id, catelog_name, is_private
    FROM sites
    WHERE ${clauses.join(' OR ')}
    ORDER BY update_time DESC, id DESC
    LIMIT ?
  `).bind(...params).all();

  return {
    query,
    terms,
    totalReturned: (results || []).length,
    bookmarks: (results || []).map(compactBookmark),
  };
}

async function getBookmarksByIds(db, args = {}) {
  const ids = [...new Set((Array.isArray(args.ids) ? args.ids : [])
    .map(value => Number.parseInt(value, 10))
    .filter(value => Number.isFinite(value) && value > 0))]
    .slice(0, 100);

  if (!ids.length) return { bookmarks: [] };
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`
    SELECT id, name, url, desc, catelog_id, catelog_name, is_private
    FROM sites WHERE id IN (${placeholders})
  `).bind(...ids).all();

  const map = new Map((results || []).map(site => [Number(site.id), compactBookmark(site)]));
  return { bookmarks: ids.map(id => map.get(id)).filter(Boolean) };
}

async function findDuplicates(db, args = {}) {
  const limit = clampInteger(args.limit, 20, 1, MAX_DUPLICATE_GROUPS);
  const { results: groups } = await db.prepare(`
    SELECT LOWER(TRIM(url)) AS normalized_url, COUNT(*) AS item_count
    FROM sites
    WHERE TRIM(COALESCE(url, '')) <> ''
    GROUP BY LOWER(TRIM(url))
    HAVING COUNT(*) > 1
    ORDER BY item_count DESC, normalized_url ASC
    LIMIT ?
  `).bind(limit).all();

  const output = [];
  for (const group of groups || []) {
    const { results } = await db.prepare(`
      SELECT id, name, url, desc, catelog_id, catelog_name, is_private
      FROM sites WHERE LOWER(TRIM(url)) = ? ORDER BY id ASC LIMIT 20
    `).bind(group.normalized_url).all();
    output.push({
      url: group.normalized_url,
      count: Number(group.item_count || 0),
      bookmarks: (results || []).map(compactBookmark),
    });
  }
  return { groups: output };
}

export const ASSISTANT_TOOL_GUIDE = `
你可以通过 JSON 请求后端工具读取真实书签数据。不要假设数据库内容。
可用工具：
1. library_stats {}：获取书签总数、分类数、无描述数量、重复 URL 估算。
2. list_categories {}：读取全部分类、父子关系和每个分类的书签数量。
3. list_bookmarks {"page":1,"pageSize":80,"categoryId":可选}：分页读取书签，pageSize 最大 120。
4. search_bookmarks {"query":"自然语言关键词","limit":40}：在名称、URL、描述、分类中做字面检索。
5. get_bookmarks {"ids":[1,2,3]}：按 ID 读取书签详情。
6. find_duplicates {"limit":20}：查找完全相同 URL 的重复收藏。

需要工具时严格返回：
{"type":"tool_calls","calls":[{"name":"library_stats","arguments":{}},{"name":"list_categories","arguments":{}}]}
一次最多请求 6 个工具。收到 TOOL_RESULTS 后继续思考；如果还有必要继续读取，继续请求工具。
当用户要求分析“全部/所有/整个书签库”时，必须先调用 library_stats 和 list_categories；随后按页调用 list_bookmarks，直到覆盖全部书签，或明确告诉用户本轮只完成了部分扫描。不要把局部候选冒充全库分析。
`;

export async function executeAssistantTool(env, name, args = {}) {
  if (!env.NAV_DB) throw new Error('NAV_DB binding not found');

  if (name === 'library_stats') return libraryStats(env.NAV_DB);
  if (name === 'list_categories') return listCategories(env.NAV_DB);
  if (name === 'list_bookmarks') return listBookmarks(env.NAV_DB, args);
  if (name === 'search_bookmarks') return searchBookmarks(env.NAV_DB, args);
  if (name === 'get_bookmarks') return getBookmarksByIds(env.NAV_DB, args);
  if (name === 'find_duplicates') return findDuplicates(env.NAV_DB, args);

  throw new Error(`未知工具: ${name}`);
}
