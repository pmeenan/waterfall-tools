import { processCDPFileNode } from '../src/inputs/cdp.js';

processCDPFileNode('Sample/Data/Chrome Devtools Protocol/www.google.com-devtools.json.gz')
  .then(har => console.log('success!', har.log.entries.length, JSON.stringify(har.log.entries[0])))
  .catch(err => console.error('fail!', err));
