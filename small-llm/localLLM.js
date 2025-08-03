const fetch = require('node-fetch');

async function classify(prompt) {
  const url = process.env.LLM_STUDIO_URL;
  const body = {
    model: 'tinyllama',
    messages: [{ role: 'user', content: prompt }]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return json.choices[0].message.content;
}

module.exports = { classify };
