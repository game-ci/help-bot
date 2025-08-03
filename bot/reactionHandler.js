function handleReaction(reaction, user) {
  if (user.bot) return;
  console.log(`Reaction ${reaction.emoji.name} by ${user.tag} on message ${reaction.message.id}`);
}

module.exports = { handleReaction };
