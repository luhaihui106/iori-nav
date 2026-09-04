import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';

const MAX_HISTORY_MESSAGES = 40;
const MAX_RESULTS = 20;
const MAX_ACTIONS = 250;

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(raw) ? raw : '';
}

function safeHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter(item => item && ['user', 'assistant'].includes(item.role) && item.content)
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      content: String(item.content || '').slice(0, 4000),
    }));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);
  if (!env.NAV_AUTH) return errorResponse('NAV_AUTH binding not found', 500);

  const url = new URL(request.url);
  const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));
  if (!sessionId) return errorResponse('Invalid sessionId', 400);

  try {
    const raw = await env.NAV_AUTH.get(`assistant_session_${sessionId}`);
    if (!raw) {
      return jsonResponse({ code: 200, data: { sessionId, exists: false, history: [] } });
    }

    const parsed = JSON.parse(raw);
    return jsonResponse({
      code: 200,
      data: {
        sessionId,
        exists: true,
        title: String(parsed.title || '').slice(0, 120),
        createdAt: parsed.createdAt || '',
        updatedAt: parsed.updatedAt || '',
        history: safeHistory(parsed.history),
        lastResults: (Array.isArray(parsed.lastResults) ? parsed.lastResults : []).slice(0, MAX_RESULTS),
        pendingActions: (Array.isArray(parsed.pendingActions) ? parsed.pendingActions : []).slice(0, MAX_ACTIONS),
        plan: parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : null,
      },
    });
  } catch (error) {
    console.error('Failed to load assistant session:', error);
    return errorResponse(`Failed to load assistant session: ${error.message}`, 500);
  }
}
