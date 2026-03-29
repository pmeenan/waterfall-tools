const { processTcpdumpNode } = require('./src/inputs/tcpdump.js');
const fs = require('fs');
const { Readable } = require('stream');

async function test() {
    const stream = Readable.toWeb(fs.createReadStream('Sample/Data/PCAP/www.google.com-tcpdump.cap.gz'));
    const keylog = Readable.toWeb(fs.createReadStream('Sample/Data/PCAP/www.google.com-tcpdump.key_log.txt.gz'));
    
    // We mock console log here or use existing
    global.HTTP3_FRAME_TRACE = true;
    
    try {
        await processTcpdumpNode(stream, { isGz: true, keyLogInput: keylog });
    } catch(e) {}
}

test();
