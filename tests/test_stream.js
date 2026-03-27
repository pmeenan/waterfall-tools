import fs from 'node:fs';
import { parser } from 'stream-json';
import streamArrayPkg from 'stream-json/streamers/stream-array.js';

const readStream = fs.createReadStream('Sample/Data/Chrome Devtools Protocol/www.google.com-devtools.json.gz');
import zlib from 'node:zlib';
const gunzip = zlib.createGunzip();

const p = parser.asStream();
const a = streamArrayPkg.asStream();

readStream.pipe(gunzip).pipe(p).pipe(a);

let i = 0;
a.on('data', data => { i++; if(i === 1) console.log('first element method:', data.value.method); });
a.on('end', () => console.log('end. elements:', i));
a.on('error', e => console.error(e));
