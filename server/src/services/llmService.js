const aiRouter = require('./aiRouter');
const { buildJudgePrompt, buildAssessPrompt, buildBotQuestionPrompt } = require('../utils/prompts');

const JUDGMENT_LABELS = {
  yes: '是',
  no: '不是',
  irrelevant: '无关',
  perhaps_yes: '或许是',
  perhaps_no: '或许不是',
};

// 熔断器：按用户记录连续 close_to_truth=true 次数，防止作弊刷「接近真相」
const userCloseStreak = new Map();
const CLOSE_STREAK_THRESHOLD = 3;

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

/**
 * 熔断：对成功解析的判定结果按用户施加 close_to_truth 连续计数。
 * 连续达到阈值则强制降级为 false；出现 false 则重置计数。
 * @param {string} userId
 * @param {{judgment:string, judgmentLabel:string, closeToTruth:boolean}} result
 * @returns {object} 处理后的结果（可能已降级）
 */
function applyCloseCircuitBreaker(userId, result) {
  if (!userId) return result;
  const streak = userCloseStreak.get(userId) || 0;
  if (result.closeToTruth) {
    const newStreak = streak + 1;
    userCloseStreak.set(userId, newStreak);
    if (newStreak >= CLOSE_STREAK_THRESHOLD) {
      console.warn(`[llmService] 用户 ${userId} 连续 close_to_truth 触发熔断降级`);
      return { ...result, closeToTruth: false };
    }
  } else {
    userCloseStreak.set(userId, 0);
  }
  return result;
}

/**
 * 判定玩家提问（角色：judge）
 * @param {string} userId - 提问玩家 ID，用于熔断计数
 * @returns {Promise<{judgment: 'yes'|'no'|'irrelevant'|'perhaps_yes'|'perhaps_no', judgmentLabel: string, closeToTruth: boolean}>
 */
async function judgeQuestion(scenario, truth, history, question, userId, judgeNote) {
  const { systemPrompt, userMessage } = buildJudgePrompt(scenario, truth, history, question, judgeNote);
  try {
    const content = await aiRouter.callRole(
      'judge',
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content);
    if (parsed && ['yes', 'no', 'irrelevant', 'perhaps_yes', 'perhaps_no'].includes(parsed.judgment)) {
      const result = {
        judgment: parsed.judgment,
        judgmentLabel: JUDGMENT_LABELS[parsed.judgment],
        closeToTruth: !!parsed.close_to_truth,
      };
      return applyCloseCircuitBreaker(userId, result);
    }
    console.warn('[llmService] 无法解析判定结果，已降级处理');
  } catch (err) {
    console.warn('[llmService] LLM 调用失败，已降级');
  }
  // 降级：返回"无关"，不接近真相
  return { judgment: 'irrelevant', judgmentLabel: '无关', closeToTruth: false };
}

/**
 * 让 AI 机器人生成一个提问（角色：bot_question）
 * @returns {Promise<string|null>}
 */
async function generateBotQuestion(scenario, history) {
  const { systemPrompt, userMessage } = buildBotQuestionPrompt(scenario, history);
  try {
    const content = await aiRouter.callRole(
      'bot_question',
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content);
    if (parsed && typeof parsed.question === 'string' && parsed.question.trim()) {
      return parsed.question.trim();
    }
    console.warn('[llmService] 无法解析 bot 提问，已使用兜底');
  } catch (err) {
    console.warn('[llmService] LLM 调用失败，已使用兜底');
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

/**
 * 评估当前游戏进度（角色：assessor）
 * @returns {Promise<{assessment: 'nowhere_near'|'getting_closer'|'spotted_the_truth'}>}
 */
async function assessProgress(scenario, truth, history, judgeNote) {
  const { systemPrompt, userMessage } = buildAssessPrompt(scenario, truth, history, judgeNote);
  try {
    const content = await aiRouter.callRole(
      'assessor',
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content);
    if (parsed && ['nowhere_near', 'getting_closer', 'spotted_the_truth'].includes(parsed.assessment)) {
      return { assessment: parsed.assessment };
    }
    console.warn('[llmService] 无法解析评估结果，已降级');
  } catch (err) {
    console.warn('[llmService] LLM 评估调用失败，已降级');
  }
  return { assessment: 'getting_closer' };
}

module.exports = { judgeQuestion, generateBotQuestion, assessProgress, JUDGMENT_LABELS };
