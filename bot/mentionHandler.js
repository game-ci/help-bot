const questionRouter = require('./questionRouter');
const queryEngine = require('./queryEngine');

async function handleMention(message, client) {
  const botId = client.user.id;
  const question = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  const onTopic = await questionRouter.routeQuestion(question);
  if (!onTopic) {
    await message.reply("I’m here to help with the X tool. That’s outside my scope 🧑‍🔧");
    return;
  }

  const answer = await queryEngine.answerQuestion(question);
  await message.reply(answer);
}

module.exports = { handleMention };
