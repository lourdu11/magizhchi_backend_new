const fs = require('fs');
const path = 'd:/magizhchi/frontend/src/pages/admin/AdminSettings.jsx';
let c = fs.readFileSync(path, 'utf8');
const lines = c.split('\n');

// Find all lines with 'testLoading. (single-quoted testLoading = broken)
lines.forEach((l, i) => {
  if (l.includes("'testLoading.")) {
    console.log('BROKEN Line ' + (i+1) + ':', l.substring(200, 500));
  }
});
