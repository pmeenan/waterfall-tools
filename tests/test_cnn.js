import { processCDPFileNode } from '../src/inputs/cdp.js';
console.log('starting cnn');
const start = Date.now();
processCDPFileNode('Sample/Data/Chrome Devtools Protocol/www.cnn.com-devtools.json.gz')
  .then(har => console.log('success!', har.log.entries.length, 'dt:', Date.now()-start))
  .catch(err => console.error('fail!', err));
