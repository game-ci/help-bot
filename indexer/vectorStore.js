const { Pinecone } = require('pinecone-client');

const pinecone = new Pinecone();

async function query(question) {
  try {
    // Placeholder implementation; integrate actual vector DB here
    return 'No context available';
  } catch (err) {
    console.error('Vector store error:', err.message);
    return '';
  }
}

module.exports = { query };
