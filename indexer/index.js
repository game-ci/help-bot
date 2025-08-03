async function build() {
  console.log('Starting content indexing');

  let fetchIssues;
  try {
    ({ fetchIssues } = require('./github'));
    if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
      const issues = await fetchIssues();
      console.log(`Fetched ${issues.length} GitHub issues`);
    } else {
      console.log('Skipping GitHub fetch: missing GITHUB_TOKEN or GITHUB_REPO');
    }
  } catch (err) {
    console.log('Skipping GitHub fetch:', err.message);
  }

  let fetchDocs;
  try {
    ({ fetchDocs } = require('./site'));
    if (process.env.DOCS_URL) {
      const docs = await fetchDocs(process.env.DOCS_URL);
      console.log(`Fetched docs text length: ${docs.length}`);
    } else {
      console.log('Skipping docs fetch: missing DOCS_URL');
    }
  } catch (err) {
    console.log('Skipping docs fetch:', err.message);
  }

  let readCodeFile;
  try {
    ({ readCodeFile } = require('./codebase'));
    const sample = readCodeFile(__filename);
    console.log(`Read sample code file length: ${sample.length}`);
  } catch (err) {
    console.log('Skipping codebase read:', err.message);
  }

  let query;
  try {
    ({ query } = require('./vectorStore'));
    await query('hello');
    console.log('Vector store query complete');
  } catch (err) {
    console.log('Skipping vector store query:', err.message);
  }

  console.log('Index build complete');
}

build();
