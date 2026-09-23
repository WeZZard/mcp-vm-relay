// Uploaded integration fixture: non-interactive file output, no UI input.
const fs = require('node:fs');
fs.writeFileSync('result.json', JSON.stringify({ uploadedScript: true, runtime: process.version, platform: process.platform }, null, 2));
console.log('uploaded script wrote result.json');
