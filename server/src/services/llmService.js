const config = require('../config');
const { buildJudgePrompt, buildBotQuestionPrompt } = require('../utils/prompts');

const JUDGMENT_LABELS = { yes: '是', no: '不是', irrelevant: '无关' };

function extractJson(text) {
  if (!text) return null;
  // 去除可能的 markdown 代码块
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // 找到第一个 JSON 对象
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callZhipu(messages) {
  if (!config.zhipu.apiKey) {
    throw new Error('ZHIPU_API_KEY not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.zhipu.timeoutMs);
  try {
    const res = await fetch(`${config.zhipu.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.zhipu.apiKey}`,
      },
      body: JSON.stringify({
        model: config.zhipu.model,
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zhipu API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Zhipu API empty content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判定玩家提问
 * @returns {Promise<{judgment: 'yes'|'no'|'irrelevant', judgmentLabel: string, closeToTruth: boolean}>}
 */
async function judgeQuestion(scenario, truth, history, question) {
  const prompt = buildJudgePrompt(scenario, truth, history, question);
  try {
    const content = await callZhipu([{ role: 'user', content: prompt }]);
    const parsed = extractJson(content);
    if (parsed && ['yes', 'no', 'irrelevant'].includes(parsed.judgment)) {
      return {
        judgment: parsed.judgment,
        judgmentLabel: JUDGMENT_LABELS[parsed.judgment],
        closeToTruth: !!parsed.close_to_truth,
      };
    }
    console.warn('[llmService] 无法解析判定结果，降级:', content?.slice(0, 100));
  } catch (err) {
    console.warn('[llmService] judgeQuestion 失败，降级:', err.message);
  }
  // 降级：返回"无关"，不接近真相
  return { judgment: 'irrelevant', judgmentLabel: '无关', closeToTruth: false };
}

/**
 * 让 AI 机器人生成一个提问
 * @returns {Promise<string|null>}
 */
async function generateBotQuestion(scenario, history) {
  const prompt = buildBotQuestionPrompt(scenario, history);
  try {
    const content = await callZhipu([{ role: 'user', content: prompt }]);
    const parsed = extractJson(content);
    if (parsed && typeof parsed.question === 'string' && parsed.question.trim()) {
      return parsed.question.trim();
    }
    console.warn('[llmService] 无法解析 bot 提问，使用兜底:', content?.slice(0, 100));
  } catch (err) {
    console.warn('[llmService] generateBotQuestion 失败，使用兜底:', err.message);
  }
  // 兜底问题池
  const fallbacks = [
    '这件事发生在白天吗？',
    '涉及到的人是男性吗？',
    '事件与天气有关吗？',
    '主角的职业相关吗？',
    '时间是现代吗？',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

module.exports = { judgeQuestion, generateBotQuestion, JUDGMENT_LABELS };
