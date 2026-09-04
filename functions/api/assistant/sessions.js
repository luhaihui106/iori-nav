import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';

const PREFIX = 'assistant_session_';
const MAX_SESSIONS = 30;

function titleFromSession(session) {
  if (session?.title) return String(session.title).slice(0, 80);
  const firstUser = (Array.isArray(session?.history) ? session.history : []).find(item => item?.role === 'user' && item.content);
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : '未命名对话';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);
  if (!env.NAV_AUTH) return errorResponse('NAV_AUTH binding not found', 500);

  try {
    const listed = await env.NAV_AUTH.list({ prefix: PREFIX, limit: 100 });
    const keys = (listed.keys || []).slice(0, 100);
    const sessions = await Promise.all(keys.map(async item => {
      try {
        const raw = await env.NAV_AUTH.get(item.name);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const history = Array.isArray(parsed.history) ? parsed.history : [];
        if (!history.length) return null;
        return {
          sessionId: item.name.slice(PREFIX.length),
          title: titleFromSession(parsed),
          createdAt: parsed.createdAt || '',
          updatedAt: parsed.updatedAt || '',
          messageCount: history.length,
          planTitle: String(parsed.plan?.title || '').slice(0, 80),
        };
      } catch {
        return null;
      }
    }));

    const data = sessions
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, MAX_SESSIONS);

    return jsonResponse({ code: 200, data });
  } catch (error) {
    console.error('Failed to list assistant sessions:', error);
    return errorResponse(`Failed to list assistant sessions: ${error.message}`, 500);
  }
}
