import { onRequestPost as runAgentChat } from './chat';

const SESSION_PREFIX = 'assistant_session_';
const MAX_PERSISTED_MESSAGES = 40;
const BASE_RECENT_MESSAGES = 10;
const MAX_OLDER_MEMORY_CHARS = 1600;
const MAX_TASK_INDEX = 16;

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(raw) ? raw : '';
}

function cleanMessage(item) {
  if (!item || !['user', 'assistant'].includes(item.role) || !item.content) return null;
  return {
    role: item.role,
    content: String(item.content || '').trim().slice(0, 4000),
  };
}

function cleanHistory(history) {
  return (Array.isArray(history) ? history : []).map(cleanMessage).filter(Boolean);
}

function cleanTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => ({
    index: Number.parseInt(task?.index, 10) || index + 1,
    turnId: String(task?.turnId || '').slice(0, 40),
    user: String(task?.user || '').trim().slice(0, 800),
    reply: String(task?.reply || '').trim().replace(/\s+/g, ' ').slice(0, 900),
    resultIds: (Array.isArray(task?.resultIds) ? task.resultIds : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value > 0)
      .slice(0, 60),
    planTitle: String(task?.planTitle || '').trim().slice(0, 120),
  })).slice(-MAX_TASK_INDEX);
}

function compactOlderMemory(history) {
  const older = history.slice(0, Math.max(0, history.length - BASE_RECENT_MESSAGES)).slice(-12);
  if (!older.length) return '';

  const lines = [];
  let used = 0;
  for (const item of older) {
    const label = item.role === 'user' ? '用户' : '助手';
    const text = String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const line = `${label}：${text}`;
    if (used + line.length > MAX_OLDER_MEMORY_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

function compactTaskIndex(tasks) {
  if (!tasks.length) return '';
  return tasks.slice(-12).map(task => {
    const ids = task.resultIds.length ? `；结果ID=[${task.resultIds.join(',')}]` : '';
    const plan = task.planTitle ? `；方案=${task.planTitle}` : '';
    return `任务${task.index}${task.turnId ? `(${task.turnId})` : ''}：${task.user.slice(0, 180)}；回复摘要=${task.reply.slice(0, 260)}${ids}${plan}`;
  }).join('\n');
}

async function loadRawSession(env, sessionId) {
  try {
    const raw = await env.NAV_AUTH.get(`${SESSION_PREFIX}${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function detectRequestMode(message) {
  const text = String(message || '').replace(/\s+/g, ' ');
  const prepareChanges = /(生成|准备|列出|给出|给我).{0,24}(变更预览|待确认变更|可执行预览|操作预览)|预览.{0,12}(变更|修改)|生成.{0,16}actions?/i.test(text);
  if (prepareChanges) return 'prepare_changes';

  const analysisOnly = /(只给方案|先给方案|仅给方案|先不要修改|不要修改任何数据|不要修改数据|不修改数据|先别修改|仅分析|只分析|先分析|只做分析|不要生成可执行)/.test(text);
  if (analysisOnly) return 'analysis_only';

  return 'normal';
}

function modeInstruction(mode) {
  if (mode === 'analysis_only') {
    return '【本轮安全模式：analysis_only】用户只要求分析/方案。可以读取数据库并给出建议，但最终 JSON 的 actions 必须是空数组 []，不得生成任何可执行变更。';
  }
  if (mode === 'prepare_changes') {
    return '【本轮模式：prepare_changes】允许生成待确认 actions 作为预览，但绝不能直接执行数据库写入；必须等待用户在界面二次确认。';
  }
  return '【本轮模式：normal】根据用户当前指令判断是否需要工具；除非用户明确要求修改或生成变更预览，否则不要产生 actions。';
}

function buildForwardMessage(originalMessage, previousHistory, mode, tasks) {
  const original = String(originalMessage || '').trim().slice(0, 1800);
  const memory = compactOlderMemory(previousHistory);
  const taskIndex = compactTaskIndex(tasks);
  const parts = [original, modeInstruction(mode)];

  if (taskIndex) {
    parts.push(`【本会话稳定任务索引】\n${taskIndex}\n解释序数指代时：用户说“第一个任务/第一条结果/刚才第一条结果”时，优先按这里的任务序号理解；只有明确说“匹配结果里的第一个/搜索结果第一个”时，才按最近匹配卡片排序理解。若仍有歧义，应先追问，不要擅自选择对象。`);
  }

  if (memory) {
    parts.push(`【较早的同一会话记忆，仅用于理解“刚才、之前、那些、第一个”等指代；若与当前数据库状态冲突，以重新调用工具读取的数据为准】\n${memory}`);
  }
  return parts.join('\n\n').slice(0, 5200);
}

function titleFromHistory(history) {
  const firstUser = history.find(item => item.role === 'user' && item.content);
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : '未命名对话';
}

function normalizeActionLabels(actions) {
  const safeActions = Array.isArray(actions) ? actions.map(item => ({ ...item })) : [];
  const created = new Map();
  for (const action of safeActions) {
    if (action.type === 'create_category' && action.tempKey && action.name) {
      created.set(String(action.tempKey), String(action.name));
    }
  }
  for (const action of safeActions) {
    if (action.type === 'move_bookmark' && action.categoryRef) {
      const official = created.get(String(action.categoryRef));
      if (official) action.category = official;
    }
  }
  return safeActions;
}

function applyResponseSafety(responseData, mode) {
  if (!responseData?.data) return responseData;
  responseData.data.mode = mode;
  responseData.data.actions = normalizeActionLabels(responseData.data.actions);

  if (mode === 'analysis_only') {
    const removed = responseData.data.actions.length;
    responseData.data.actions = [];
    responseData.data.writePreviewSuppressed = removed > 0;
    if (removed > 0) {
      responseData.data.reply = `${responseData.data.reply}\n\n（已按“只给方案”模式隐藏 ${removed} 项可执行变更；如需生成待确认预览，请明确说“生成变更预览”。）`;
    }
  }
  return responseData;
}

function rebuildResponse(originalResponse, data) {
  const headers = new Headers(originalResponse.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.NAV_AUTH) return runAgentChat(context);

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return runAgentChat(context);
  }

  const originalMessage = String(body?.message || '').trim();
  const sessionId = normalizeSessionId(body?.sessionId);
  if (!originalMessage || !sessionId) return runAgentChat(context);

  const mode = detectRequestMode(originalMessage);
  const before = await loadRawSession(env, sessionId);
  const previousHistory = cleanHistory(before?.history).slice(-MAX_PERSISTED_MESSAGES);
  const previousTasks = cleanTasks(before?.tasks);
  const forwardedBody = {
    ...body,
    message: buildForwardMessage(originalMessage, previousHistory, mode, previousTasks),
  };

  const forwardedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(forwardedBody),
  });

  const response = await runAgentChat({ ...context, request: forwardedRequest });
  let finalResponse = response;

  try {
    let responseData = await response.clone().json();
    responseData = applyResponseSafety(responseData, mode);

    if (response.ok && responseData?.code === 200 && responseData?.data?.reply) {
      const actualSessionId = normalizeSessionId(responseData.data.sessionId) || sessionId;
      const after = await loadRawSession(env, actualSessionId) || {};
      const fullHistory = [
        ...previousHistory,
        { role: 'user', content: originalMessage.slice(0, 4000) },
        { role: 'assistant', content: String(responseData.data.reply).slice(0, 4000) },
      ].slice(-MAX_PERSISTED_MESSAGES);

      const nextIndex = (previousTasks[previousTasks.length - 1]?.index || 0) + 1;
      const task = {
        index: nextIndex,
        turnId: crypto.randomUUID().slice(0, 8),
        user: originalMessage.slice(0, 800),
        reply: String(responseData.data.reply).replace(/\s+/g, ' ').slice(0, 900),
        resultIds: (Array.isArray(responseData.data.results) ? responseData.data.results : [])
          .map(item => Number.parseInt(item?.id, 10))
          .filter(value => Number.isFinite(value) && value > 0)
          .slice(0, 60),
        planTitle: String(responseData.data.plan?.title || '').slice(0, 120),
      };
      const tasks = [...previousTasks, task].slice(-MAX_TASK_INDEX);

      const now = new Date().toISOString();
      await env.NAV_AUTH.put(`${SESSION_PREFIX}${actualSessionId}`, JSON.stringify({
        ...after,
        title: before?.title || after?.title || titleFromHistory(fullHistory),
        createdAt: before?.createdAt || after?.createdAt || now,
        updatedAt: now,
        history: fullHistory,
        tasks,
        pendingActions: responseData.data.actions || [],
      }), { expirationTtl: 7 * 24 * 60 * 60 });

      responseData.data.taskIndex = nextIndex;
      responseData.data.turnId = task.turnId;
    }

    finalResponse = rebuildResponse(response, responseData);
  } catch (error) {
    console.warn('Failed to apply assistant memory/safety wrapper:', error);
  }

  return finalResponse;
}
