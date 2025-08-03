const { OpenAI } = require('openai');
const vectorStore = require('../indexer/vectorStore');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function answerQuestion(question) {
  const context = await vectorStore.query(question);
  const messages = [
    { role: 'system', content: 'You are a helpful assistant for the X open source project.' },
    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('queryEngine error:', err.message);
    return "Sorry, I couldn't get an answer right now.";
  }
}

module.exports = { answerQuestion };
