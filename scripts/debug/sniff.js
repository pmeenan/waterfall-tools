const fs = require('node:fs');
const zlib = require('node:zlib');

function sniffGzip(filePath) {
    return new Promise((resolve) => {
        const rs = fs.createReadStream(filePath, { start: 0, end: 1024 });
        const gs = rs.pipe(zlib.createGunzip());
        const chunks = [];
        gs.on('data', (d) => {
            chunks.push(d);
            if (chunks.length > 0) {
               const str = Buffer.concat(chunks).toString('utf-8');
               if (str.length > 100) {
                  gs.removeAllListeners('data');
                  rs.close();
                  resolve(str.slice(0, 100));
               }
            }
        });
    });
}
sniffGzip('../../Sample/Data/Chrome Traces/trace_www.google.com.json.gz').then(console.log);
