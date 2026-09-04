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

function getMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function extractWorkersAiText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  if (typeof response.response === 'string') return response.response;
  const choice = getMessageContentText(response.choices?.[0]?.message?.content);
  if (choice) return choice;
  if (typeof response.result?.response === 'string') return response.result.response;
  return '';
}

export async function callAssistantAi(env, settings, messages, options = {}) {
  const provider = settings.provider || 'workers-ai';
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.15;

  if (provider === 'workers-ai') {
    if (!env.AI) throw new Error('Workers AI binding (env.AI) not found');
    const model = resolveWorkersAiModel(settings.model, env.WORKERS_AI_MODEL);
    const response = await env.AI.run(model, { messages });
    const text = extractWorkersAiText(response);
    if (!text) throw new Error('Workers AI response did not include generated content');
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
