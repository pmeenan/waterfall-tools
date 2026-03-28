import fs from 'node:fs';
import { processWPTFileNode } from './src/inputs/wpt-json.js';

console.log('START PROCESSING WPT');
const inputPath = 'Sample/Data/WebPageTest JSON/www.google.com-wpt.json.gz';
const refPath = 'tests/fixtures/wpt-google.har.json';
const result = await processWPTFileNode(inputPath);
console.log('DONE PROCESSING');

if (!fs.existsSync(refPath)) {
    console.log('No ref path found. Exiting.');
    process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

const scrubbedResult = JSON.parse(JSON.stringify(result));
scrubbedResult.log.pages.forEach(p => p.startedDateTime = 'SCRUBBED');
ref.log.pages.forEach(p => p.startedDateTime = 'SCRUBBED');
scrubbedResult.log.entries.forEach(e => e.startedDateTime = 'SCRUBBED');
ref.log.entries.forEach(e => e.startedDateTime = 'SCRUBBED');

console.log('Result length:', JSON.stringify(scrubbedResult).length);
console.log('Ref length:', JSON.stringify(ref).length);
console.log('Result entries:', scrubbedResult.log.entries.length);
console.log('Ref entries:', ref.log.entries.length);

if (JSON.stringify(scrubbedResult) === JSON.stringify(ref)) {
    console.log('EXACT MATCH');
} else {
    console.log('MISMATCH DETECTED. Printing first 100 diff chars...');
    const sResult = JSON.stringify(scrubbedResult);
    const sRef = JSON.stringify(ref);
    for(let i=0; i<Math.max(sResult.length, sRef.length); i++) {
        if(sResult[i] !== sRef[i]) {
            console.log('Diff at ' + i + ': ', sResult.substring(Math.max(0, i-50), i+50));
            console.log('             VS ', sRef.substring(Math.max(0, i-50), i+50));
            break;
        }
    }
}
process.exit(0);
