import { JSONParser } from '@streamparser/json';
import fs from 'node:fs';
import zlib from 'node:zlib';

console.time('FastParser');

const parser = new JSONParser({
    paths: [
        '$.data.runs.*.firstView', 
        '$.data.runs.*.repeatView', 
        '$.data.median.firstView', 
        '$.data.median.repeatView'
    ],
    keepStack: false
});

let entriesCount = 0;

parser.onValue = ({ value, key, parent, stack }) => {
    // Strips strings or internal arrays explicitly mapped during parsing iteration
    if (key === 'response_body' || key === 'generated-html' || key === 'almanac') {
        return undefined; 
    }
    
    // When exactly matched `firstView` or `repeatView` wraps up:
    if ((key === 'firstView' || key === 'repeatView') && value && value.requests) {
        if (entriesCount === 0) {
            console.log("FIRST MATCH STACK:", stack.map(s => s.key));
            console.log("KEY:", key);
        }
        entriesCount += value.requests.length;
        return undefined; // flush!
    }
    return value;
};

const readStream = fs.createReadStream('Sample/Data/WebPageTest JSON/www.cnn.com-wpt.json.gz');
const z = zlib.createGunzip();

readStream.pipe(z).on('data', chunk => {
    parser.write(chunk.toString('utf8'));
}).on('end', () => {
    console.timeEnd('FastParser');
    console.log('Total entries:', entriesCount);
    process.exit(0);
});
