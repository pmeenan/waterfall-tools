import fs from 'fs';
import zlib from 'zlib';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { pick } from 'stream-json/filters/pick.js';

const stream = chain([
  fs.createReadStream('../../Sample/Data/Chrome Traces/trace_www.google.com.json.gz').pipe(zlib.createGunzip()),
  parser(),
  pick({filter: 'traceEvents'}),
  streamArray()
]);

const samples = {};
stream.on('data', ({value: e}) => {
  if (['ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceFinish', 'ResourceReceivedData'].includes(e.name)) {
    if (!samples[e.name]) {
      samples[e.name] = e;
      if (Object.keys(samples).length === 4) {
        console.log(JSON.stringify(samples, null, 2));
        process.exit(0);
      }
    }
  }
});
