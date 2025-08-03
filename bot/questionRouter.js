const localLLM = require('../small-llm/localLLM');

async function routeQuestion(question) {
  const prompt = `Is this an open-source support question about the X project? Answer yes or no.\nQuestion: "${question}"`;
  try {
    const result = await localLLM.classify(prompt);
    return /^yes/i.test(result.trim());
  } catch (err) {
    console.error('Small LLM error:', err.message);
    return false;
  }
}

module.exports = { routeQuestion };
