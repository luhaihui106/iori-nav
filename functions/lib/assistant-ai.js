import { resolveWorkersAiModel } from './workers-ai-models';

export function stripAssistantJsonFence(text) {
  return String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

export function parseAssistantJson(text) {
  const clean = stripAssistantJsonFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    // 兼容模型在 JSON 前后附带少量解释文本的情况。
  }

  const firstObject = clean.indexOf('{');
  const lastObject = clean.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(clean.slice(firstObject, lastObject + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

export async function loadAssistantAiSettings(db) {
  const keys = ['provider', 'apiKey', 'baseUrl', 'model'];
  const { results } = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).bind(...keys).all();

  const settings = {};
  for (const row of results || []) {
    settings[row.key] = row.value;
  }
  return settings;
}

function stringifyStructuredContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

function getMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (content && !Array.isArray(content) && typeof content === 'object') {
    return stringifyStructuredContent(content);
  }
  if (!Array.isArray(content)) return '';

  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return stringifyStructuredContent(part?.text ?? part?.content ?? '');
  }).join('');
}

function extractWorkersAiText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';

  // 传统 Workers AI 文本生成格式：{ response: "..." }
  if (typeof response.response === 'string') return response.response;

  // 部分结构化输出会直接把 JSON 对象放在 response 字段中。
  if (response.response && typeof response.response === 'object') {
    const structured = stringifyStructuredContent(response.response);
    if (structured) return structured;
  }

  // 新版 Chat Completions 风格：{ choices: [{ message: { content } }] }
  const choiceMessage = response.choices?.[0]?.message;
  const choice = getMessageContentText(choiceMessage?.content);
  if (choice) return choice;

  // 兼容其他 Workers AI / Gateway 返回形态。
  const candidates = [
    response.output_text,
    response.generated_text,
    response.text,
    response.result?.response,
    response.result?.output_text,
    response.result?.generated_text,
    response.result?.text,
    response.result?.choices?.[0]?.message?.content,
    response.output?.[0]?.content,
  ];
  for (const candidate of candidates) {
    const text = getMessageContentText(candidate);
    if (text) return text;
  }

  // 如果模型只产出了 reasoning 而没有最终 content，不把 reasoning 当作最终答案，
  // 交由上层重试/报错；这里只附带可诊断的 finish_reason。
  return '';
}

function describeWorkersAiResponse(response) {
  if (!response || typeof response !== 'object') return `type=${typeof response}`;
  const keys = Object.keys(response).slice(0, 12).join(',');
  const finishReason = response.choices?.[0]?.finish_reason || response.result?.choices?.[0]?.finish_reason || '';
  const hasReasoning = Boolean(
    response.choices?.[0]?.message?.reasoning ||
    response.choices?.[0]?.message?.reasoning_content ||
    response.result?.choices?.[0]?.message?.reasoning ||
    response.result?.choices?.[0]?.message?.reasoning_content
  );
  return `keys=[${keys}]${finishReason ? `, finish_reason=${finishReason}` : ''}${hasReasoning ? ', reasoning_only=true' : ''}`;
}

export async function callAssistantAi(env, settings, messages, options = {}) {
  const provider = settings.provider || 'workers-ai';
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.15;

  if (provider === 'workers-ai') {
    if (!env.AI) throw new Error('Workers AI binding (env.AI) not found');
    const model = resolveWorkersAiModel(settings.model, env.WORKERS_AI_MODEL);

    const input = {
      messages,
      temperature,
      max_completion_tokens: 4096,
    };

    // Gemma 4 默认支持 thinking。Agent 的每一轮都要求短小、严格 JSON 的工具调用或最终结果，
    // 开启 thinking 容易出现只返回 reasoning、没有最终 content 的情况。Cloudflare 官方示例也建议
    // 通过 chat_template_kwargs.enable_thinking=false 关闭 thinking。
    if (model.includes('/gemma-4-')) {
      input.chat_template_kwargs = { enable_thinking: false };
    }

    const response = await env.AI.run(model, input);
    const text = extractWorkersAiText(response);
    if (!text) {
      throw new Error(`Workers AI response did not include generated content (${describeWorkersAiResponse(response)})`);
    }
    return text;
  }

  if (provider === 'openai') {
    if (!settings.apiKey) throw new Error('OpenAI API Key 未配置');
    if (!settings.baseUrl) throw new Error('OpenAI Base URL 未配置');

    const response = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        messages,
        temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API Error: ${await response.text()}`);
    }

    const data = await response.json();
    const text = getMessageContentText(data.choices?.[0]?.message?.content);
    if (!text) throw new Error('OpenAI response did not include generated content');
    return text;
  }

  if (provider === 'gemini') {
    if (!settings.apiKey) throw new Error('Gemini API Key 未配置');

    const model = settings.model || 'gemini-1.5-flash';
    const systemMessage = messages.find(message => message.role === 'system')?.content || '';
    const contents = messages
      .filter(message => message.role !== 'system')
      .map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(message.content || '') }],
      }));

    const payload = {
      contents,
      generationConfig: { temperature },
    };
    if (systemMessage) {
      payload.systemInstruction = { parts: [{ text: systemMessage }] };
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Gemini API Error: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
    if (!text) throw new Error('Gemini response did not include generated content');
    return text;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
