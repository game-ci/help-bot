const fs = require('fs');
const path = require('path');
const marked = require('marked');

function readCodeFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

module.exports = { readCodeFile };
