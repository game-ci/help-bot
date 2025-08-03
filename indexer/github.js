const { Octokit } = require('@octokit/rest');

async function fetchIssues(repo = process.env.GITHUB_REPO) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, name] = repo.split('/');
  const { data } = await octokit.rest.issues.listForRepo({ owner, repo: name, state: 'all' });
  return data;
}

module.exports = { fetchIssues };
