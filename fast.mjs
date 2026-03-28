import { processWPTFileNode } from './src/inputs/wpt-json.js';

console.log('START FAST CNN TEST');
console.time('Processing');
processWPTFileNode('Sample/Data/WebPageTest JSON/www.cnn.com-wpt.json.gz', { isGz: true })
    .then(har => {
        console.timeEnd('Processing');
        console.log('Finished. Entries:', har.log.entries.length);
        process.exit(0);
    }).catch(err => {
        console.error('Crash!', err);
        process.exit(1);
    });
