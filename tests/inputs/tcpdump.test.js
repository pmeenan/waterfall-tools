import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { processTcpdumpNode } from '../../src/inputs/tcpdump.js';

test('PcapParser - Parse basic tcpdump file', async () => {
    const inputPath = path.join(process.cwd(), 'Sample/Data/tcpdump/www.engadget.com-tcpdump.cap.gz');
    const packets = await processTcpdumpNode(inputPath);
    
    // We expect exactly 15232 packets with IP + TCP/UDP payloads based on the CLI run
    assert.strictEqual(packets.length, 15232, 'Should parse all matching IP/TCP/UDP packets');
    
    const firstPacket = packets[0];
    assert.ok(firstPacket.time > 0, 'Should have a valid timestamp');
    
    // Check Ethernet extraction
    assert.ok(firstPacket.ethernet.srcMac, 'Should extract source MAC');
    assert.ok(firstPacket.ethernet.dstMac, 'Should extract dest MAC');
    
    // Check IP extraction
    assert.ok(firstPacket.ip, 'Should extract IP header');
    assert.strictEqual(firstPacket.ip.version, 4, 'Should be IPv4');
    assert.ok(firstPacket.ip.srcIP, 'Should have src IP');
    assert.ok(firstPacket.ip.dstIP, 'Should have dest IP');
    
    // Check Transport extraction
    assert.ok(firstPacket.transport, 'Should extract transport header');
    assert.ok(firstPacket.transport.type === 'TCP' || firstPacket.transport.type === 'UDP', 'Should be TCP or UDP');
    assert.ok(firstPacket.transport.srcPort, 'Should have src port');
    assert.ok(firstPacket.transport.dstPort, 'Should have dest port');
    
    if (firstPacket.transport.type === 'TCP') {
        assert.ok(firstPacket.transport.flags, 'TCP should extract flags');
        assert.ok(firstPacket.transport.seq !== undefined, 'TCP should extract sequence number');
    }
});
