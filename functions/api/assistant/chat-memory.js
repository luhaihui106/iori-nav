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
  const explicitNoPreview = /((不要|不用|不需要|先别|暂不).{0,16}预览|不要预览)/.test(text);
  const analysisOnly = /(只给方案|先给方案|仅给方案|先不要修改|不要修改任何数据|不要修改数据|不修改数据|先别修改|仅分析|只分析|先分析|只做分析|不要生成可执行)/.test(text);

  if (explicitNoPreview) return 'analysis_only';

  const mentionsPreview = /预览/.test(text);
  const prepareChanges = mentionsPreview ||
    /(生成|准备|列出|给出|给我).{0,30}(待确认变更|可执行变更|操作清单)|生成.{0,16}actions?/i.test(text);
  if (prepareChanges) return 'prepare_changes';

  if (analysisOnly) return 'analysis_only';
  return 'normal';
}

function modeInstruction(mode) {
  if (mode === 'analysis_only') {
    return '【本轮安全模式：analysis_only】用户只要求分析/方案。可以读取数据库并给出建议，但最终 JSON 的 actions 必须是空数组 []，不得生成任何可执行变更。';
  }
  if (mode === 'prepare_changes') {
    return '【本轮模式：prepare_changes】必须生成可核对的待确认 actions 作为预览，绝不能直接执行数据库写入；如果上下文缺少书签 ID 或分类 ID，先调用工具补齐真实数据。plan.scope 必须用“分类<真实ID>「<数据库正式名称>」”明确写出主要覆盖分类；后端会核对 ID 与名称，任何不一致都会阻止确认。只有确实没有任何有效变更时才允许 actions=[]，并且 reply 必须明确说明“0 项变更”及原因，不得声称已经生成预览。';
  }
  return '【本轮模式：normal】根据用户当前指令判断是否需要工具；除非用户明确要求修改或生成变更预览，否则不要产生 actions。';
}

function statisticalInterpretationHint(message) {
  const text = String(message || '').replace(/\s+/g, ' ');
  if (!/(统计|顶级分类|二级|全部分类)/.test(text)) return '';
  if (!/\d+\s*\/\s*\d+\s*\/\s*\d+/.test(text)) return '';
  return '【统计口径提示】本句中的“数字/数字/数字”表示用户期望核对的统计值，不是分类 ID。只有用户明确写“分类ID/ID为”时才按分类 ID 读取。';
}

function buildForwardMessage(originalMessage, previousHistory, mode, tasks) {
  const original = String(originalMessage || '').trim().slice(0, 1800);
  const memory = compactOlderMemory(previousHistory);
  const taskIndex = compactTaskIndex(tasks);
  const parts = [original, modeInstruction(mode)];
  const statsHint = statisticalInterpretationHint(original);
  if (statsHint) parts.push(statsHint);

  if (taskIndex) {
    parts.push(`【本会话稳定任务索引】\n${taskIndex}\n解释序数指代时：用户说“第一个任务/第一条结果/刚才第一条结果”时，优先按这里的任务序号理解；只有明确说“匹配结果里的第一个/搜索结果第一个”时，才按最近匹配卡片排序理解。若仍有歧义，应先追问，不要擅自选择对象。`);
  }

  if (memory) {
    parts.push(`【较早的同一会话记忆，仅用于理解“刚才、之前、那些、第一个”等指代；若与当前数据库状态冲突，以重新调用工具读取的数据为准】\n${memory}`);
  }
  return parts.join('\n\n').slice(0, 5600);
}

function buildPrepareRetryMessage(originalMessage, validationErrors = []) {
  const errorText = validationErrors.length
    ? `\n本次后端预览校验发现：${validationErrors.slice(0, 4).join('；')}。请先通过 list_categories 重新确认真实分类 ID/名称。`
    : '';
  return `${originalMessage}\n\n【prepare_changes 自动校验重试】上一轮没有产生可安全确认的 actions。现在必须重新完成“变更预览”这一步：如果需要书签 ID、当前分类或目标分类 ID，请先重新调用工具读取真实数据；然后返回 final JSON，并把每项可执行修改写入 actions。plan.scope 必须写成“分类<真实ID>「<正式名称>」”。不得只用自然语言声称“已生成预览”。如果经过核对确实没有任何需要修改的项目，则 actions 必须为 []，同时 reply 必须明确写“0 项变更”并说明原因。${errorText}`.slice(0, 3000);
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

function normalizeEstimatedText(value, actionCount) {
  return String(value || '').replace(/(预计(?:变更)?\s*[:：]?\s*(?:约\s*)?)\d+\s*项/g, `$1${actionCount} 项`);
}

function normalizeScopeRefs(scope, categoryMap, validationErrors) {
  const refs = [];
  const pattern = /分类\s*#?\s*(\d+)\s*[「『“"【]([^」』”"】]+)[」』”"】]/g;
  const normalized = String(scope || '').replace(pattern, (full, rawId, claimedName) => {
    const id = Number.parseInt(rawId, 10);
    const claimed = String(claimedName || '').trim();
    const actualName = categoryMap.get(id) || '';
    refs.push({ id, claimedName: claimed, actualName });

    if (!actualName) {
      validationErrors.push(`覆盖范围引用不存在的分类 ID ${id}`);
      return full;
    }
    if (actualName !== claimed) {
      validationErrors.push(`分类 ${id} 名称不匹配：模型写“${claimed}”，数据库为“${actualName}”`);
    }
    return `分类${id}「${actualName}」`;
  });
  return { normalized, refs };
}

async function validatePreparedPreview(responseData, env) {
  if (!responseData?.data || responseData.data.mode !== 'prepare_changes' || !env.NAV_DB) return responseData;

  const data = responseData.data;
  data.actions = Array.isArray(data.actions) ? data.actions : [];

  const { results } = await env.NAV_DB.prepare('SELECT id, catelog FROM category ORDER BY id').all();
  const categoryMap = new Map((results || []).map(row => [Number(row.id), String(row.catelog || '')]));
  const validationErrors = [];
  let planScopeRefs = [];

  if (data.plan && typeof data.plan === 'object') {
    const scope = normalizeScopeRefs(data.plan.scope, categoryMap, validationErrors);
    data.plan.scope = scope.normalized;
    planScopeRefs = scope.refs;
  }

  const validScopeRefs = planScopeRefs.filter(item => item.actualName && item.actualName === item.claimedName);
  const singleScopeId = validScopeRefs.length === 1 ? validScopeRefs[0].id : 0;

  for (const action of data.actions) {
    if (action?.type === 'create_category') {
      const parentId = Number.parseInt(action.parentId, 10) || 0;
      if (parentId > 0) {
        const actualParentName = categoryMap.get(parentId);
        if (!actualParentName) {
          validationErrors.push(`新建分类“${action.name || ''}”引用不存在的父分类 ID ${parentId}`);
          continue;
        }
        action.parentName = actualParentName;
        if (singleScopeId && parentId !== singleScopeId) {
          validationErrors.push(`新建分类“${action.name || ''}”父分类 ID ${parentId} 与方案覆盖分类 ID ${singleScopeId} 不一致`);
        }
      }
    }

    if (action?.type === 'move_bookmark') {
      const categoryId = Number.parseInt(action.categoryId, 10) || 0;
      if (categoryId > 0) {
        const actualName = categoryMap.get(categoryId);
        if (!actualName) validationErrors.push(`移动书签 #${action.siteId || ''} 引用不存在的目标分类 ID ${categoryId}`);
        else action.category = actualName;
      }
    }
  }

  const actionCount = data.actions.length;
  if (data.plan && typeof data.plan === 'object') {
    data.plan.estimatedChanges = actionCount;
    data.plan.summary = normalizeEstimatedText(data.plan.summary, actionCount);
  }
  data.reply = normalizeEstimatedText(data.reply, actionCount);

  data.prepareValidationErrors = [...new Set(validationErrors)].slice(0, 8);
  data.prepareValidationBlocked = data.prepareValidationErrors.length > 0;

  if (data.prepareValidationBlocked) {
    data.actions = [];
    if (data.plan && typeof data.plan === 'object') data.plan.estimatedChanges = 0;
    data.reply = `变更预览已被安全校验拦截，当前为 0 项可执行变更。${data.prepareValidationErrors.join('；')}。系统不会显示确认执行，并将自动尝试重新读取分类映射后生成预览。`;
  }

  return responseData;
}

function ensureTruthfulPrepareResponse(responseData) {
  if (!responseData?.data || responseData.data.mode !== 'prepare_changes') return responseData;
  const actions = Array.isArray(responseData.data.actions) ? responseData.data.actions : [];
  if (responseData.data.plan && typeof responseData.data.plan === 'object') {
    responseData.data.plan.estimatedChanges = actions.length;
  }
  if (actions.length) return responseData;

  responseData.data.prepareChangesEmpty = true;
  const reply = String(responseData.data.reply || '');
  const explicitlyZero = /(0\s*项|零项|没有任何|无需修改|没有需要修改|无有效变更|没有有效变更|安全校验拦截)/.test(reply);
  if (!explicitlyZero) {
    responseData.data.reply = '未能生成可执行变更预览：本轮 prepare_changes 最终返回 0 项有效 actions。系统没有把自然语言声明当作已生成的预览，也不会显示确认执行。请重新读取目标范围后再试，或明确指定要移动、重命名或修改描述的书签。';
  }
  return responseData;
}

function snapshotPrepareAttempt(responseData, attempt) {
  const data = responseData?.data || {};
  return {
    attempt,
    actionCount: Array.isArray(data.actions) ? data.actions.length : 0,
    blocked: Boolean(data.prepareValidationBlocked),
    errors: Array.isArray(data.prepareValidationErrors) ? data.prepareValidationErrors.slice(0, 8) : [],
  };
}

function appendPrepareAudit(responseData, attempts, retryUsed) {
  if (!responseData?.data || responseData.data.mode !== 'prepare_changes') return;
  const data = responseData.data;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const toolsUsed = Array.isArray(data.toolsUsed) ? [...data.toolsUsed] : [];

  for (const item of attempts) {
    const errors = item.errors.length ? `；errors=${item.errors.join(' | ')}` : '';
    toolsUsed.push(`prepare 第${item.attempt}次校验：actionCount=${item.actionCount}；blocked=${item.blocked ? 'yes' : 'no'}${errors}`);
  }

  const everBlocked = attempts.some(item => item.blocked);
  toolsUsed.push(`prepare 最终：attempt=${attempts.length || 1}；retry=${retryUsed ? 'yes' : 'no'}；actionCount=${actions.length}；blocked=${data.prepareValidationBlocked ? 'yes' : 'no'}；everBlocked=${everBlocked ? 'yes' : 'no'}`);

  data.toolsUsed = toolsUsed;
  data.prepareAttempt = attempts.length || 1;
  data.prepareRetryUsed = retryUsed;
  data.prepareFinalActionCount = actions.length;
  data.prepareValidationEverBlocked = everBlocked;
  data.prepareValidationHistory = attempts;

  if (everBlocked && actions.length > 0) {
    data.reply = `首次变更预览未通过安全校验，系统已自动重试并重新校验通过。\n\n${data.reply}`;
  }
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

function buildAgentRequest(request, body) {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

async function parseAgentResponse(response, mode) {
  const data = await response.clone().json();
  return applyResponseSafety(data, mode);
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
    requestMode: mode,
    message: buildForwardMessage(originalMessage, previousHistory, mode, previousTasks),
  };

  let response = await runAgentChat({ ...context, request: buildAgentRequest(request, forwardedBody) });
  let finalResponse = response;

  try {
    let responseData = await parseAgentResponse(response, mode);
    responseData = await validatePreparedPreview(responseData, env);

    let prepareRetryUsed = false;
    const prepareAttempts = [];
    if (mode === 'prepare_changes' && responseData?.code === 200) {
      prepareAttempts.push(snapshotPrepareAttempt(responseData, 1));
    }

    if (
      mode === 'prepare_changes' &&
      response.ok &&
      responseData?.code === 200 &&
      Array.isArray(responseData?.data?.actions) &&
      responseData.data.actions.length === 0
    ) {
      prepareRetryUsed = true;
      const retryBody = {
        ...body,
        requestMode: mode,
        message: buildForwardMessage(
          buildPrepareRetryMessage(originalMessage, responseData?.data?.prepareValidationErrors || []),
          previousHistory,
          mode,
          previousTasks,
        ),
      };
      const retryResponse = await runAgentChat({ ...context, request: buildAgentRequest(request, retryBody) });
      if (retryResponse.ok) {
        response = retryResponse;
        responseData = await parseAgentResponse(retryResponse, mode);
        responseData = await validatePreparedPreview(responseData, env);
        prepareAttempts.push(snapshotPrepareAttempt(responseData, 2));
      }
    }

    if (responseData?.data) {
      responseData = ensureTruthfulPrepareResponse(responseData);
      appendPrepareAudit(responseData, prepareAttempts, prepareRetryUsed);
    }

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
