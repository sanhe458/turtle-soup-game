function buildJudgePrompt(scenario, truth, history, question) {
  const historyText = history && history.length > 0
    ? history.map(h => `Q: ${h.question}\nA: ${h.judgmentLabel}`).join('\n')
    : '（暂无历史）';

  return `你是海龟汤游戏主持人。

汤面：${scenario}
汤底（真相）：${truth}

历史问答：
${historyText}

玩家新提问：${question}

请判断：
1. 该问题针对汤底的答案是「是」「不是」还是「无关」？
2. 玩家是否在接近真相（提问方向触及汤底核心要素）？

严格只返回如下 JSON（不要 markdown 代码块、不要任何额外文字）：
{"judgment": "yes|no|irrelevant", "close_to_truth": true|false}`;
}

function buildBotQuestionPrompt(scenario, history) {
  const historyText = history && history.length > 0
    ? history.map(h => `Q: ${h.question}\nA: ${h.judgmentLabel}`).join('\n')
    : '（暂无历史）';

  return `你是海龟汤游戏的 AI 玩家。

汤面：${scenario}
历史问答：
${historyText}

请提出一个有助于推理的问题，必须能用「是/不是/无关」回答。

严格只返回如下 JSON（不要 markdown 代码块、不要任何额外文字）：
{"question": "你的问题"}`;
}

module.exports = { buildJudgePrompt, buildBotQuestionPrompt };
