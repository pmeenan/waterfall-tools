export class TcpFlow {
    constructor(direction) {
        this.direction = direction; // 'client' or 'server'
        this.nextExpectedSeq = null;
        this.outOfOrderBuffer = [];
        this.contiguousChunks = []; // Array of { time, seq, bytes }
        this.seqSynced = false;
        
        this.diagnostics = {
            totalPackets: 0,
            duplicatePackets: 0,
            duplicateBytes: 0,
            outOfOrderPackets: 0
        };
        // Keep tracking frames for overlap logic / waterfall flags
        this.allFrames = [];
    }

    processPacket(packet) {
        const flags = packet.transport.flags;
        let seq = packet.transport.seq;
        let payload = packet.payload;

        const payloadLength = payload ? payload.length : 0;
        
        let frameRecord = {
            time: packet.time,
            seq: seq,
            length: payloadLength,
            flags: flags,
            duplicate: false,
            duplicateBytes: 0,
            ignored: false
        };

        this.allFrames.push(frameRecord);
        this.diagnostics.totalPackets++;

        if (flags.SYN) {
            // SYN consumes 1 sequence number
            // Initial sequence number set
            this.nextExpectedSeq = (seq + 1) >>> 0;
            this.seqSynced = true;
            // A SYN can also carry payload (e.g. TFO - TCP Fast Open)
            if (payloadLength > 0) {
                // The payload technically starts at ISN + 1
                seq = (seq + 1) >>> 0;
            } else {
                return; // Normal SYN, no data
            }
        } else if (!this.seqSynced && payloadLength > 0) {
            // Mid-stream pickup (e.g. missed handshake)
            this.nextExpectedSeq = seq;
            this.seqSynced = true;
        }

        if (payloadLength === 0) {
            return;
        }

        if (!this.seqSynced) return;

        // Sequence arithmetic handling 32-bit wrap around.
        const seqDiff = (seq - this.nextExpectedSeq) | 0;

        if (seqDiff < 0) {
            // This packet starts *before* our next expected byte.
            const overlap = -seqDiff;
            
            if (overlap >= payloadLength) {
                // Entirely duplicate or old retransmit
                this.diagnostics.duplicatePackets++;
                this.diagnostics.duplicateBytes += payloadLength;
                
                frameRecord.duplicate = true;
                frameRecord.duplicateBytes = payloadLength;
                frameRecord.ignored = true;
                return;
            } else {
                // Partial overlap. Trim the payload.
                this.diagnostics.duplicatePackets++;
                this.diagnostics.duplicateBytes += overlap;
                
                frameRecord.duplicate = true;
                frameRecord.duplicateBytes = overlap;
                
                payload = payload.subarray(overlap);
                const actualSeq = (seq + overlap) >>> 0;
                this._insertOrMerge(actualSeq, payload, packet.time);
            }
        } else {
            if (seqDiff > 0) {
                this.diagnostics.outOfOrderPackets++;
            }
            this._insertOrMerge(seq, payload, packet.time);
        }

        this._flushBuffer();
    }

    _insertOrMerge(seq, payload, time) {
        let inserted = false;
        for (let i = 0; i < this.outOfOrderBuffer.length; i++) {
            const diff = (seq - this.outOfOrderBuffer[i].seq) | 0;
            if (diff < 0) {
                this.outOfOrderBuffer.splice(i, 0, { seq, payload, time });
                inserted = true;
                break;
            } else if (diff === 0) {
                // Same starting sequence.
                if (payload.length > this.outOfOrderBuffer[i].payload.length) {
                    this.outOfOrderBuffer[i].payload = payload;
                    this.outOfOrderBuffer[i].time = time;
                }
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this.outOfOrderBuffer.push({ seq, payload, time });
        }
    }

    _flushBuffer() {
        while (this.outOfOrderBuffer.length > 0) {
            const next = this.outOfOrderBuffer[0];
            const diff = (next.seq - this.nextExpectedSeq) | 0;

            if (diff <= 0) {
                this.outOfOrderBuffer.shift();

                const overlap = -diff;
                if (overlap >= next.payload.length) {
                    continue; // Fully consumed already
                }

                const actualPayload = overlap > 0 ? next.payload.subarray(overlap) : next.payload;
                
                this.contiguousChunks.push({
                    time: next.time,
                    seq: this.nextExpectedSeq,
                    bytes: actualPayload
                });

                this.nextExpectedSeq = (this.nextExpectedSeq + actualPayload.length) >>> 0;
            } else {
                // Hole in sequence, waiting for missing packets
                break;
            }
        }
    }
}

export class TcpConnection {
    constructor(id, clientIp, clientPort, serverIp, serverPort) {
        this.id = id;
        this.clientIp = clientIp;
        this.clientPort = clientPort;
        this.serverIp = serverIp;
        this.serverPort = serverPort;

        this.clientFlow = new TcpFlow('client'); // client to server
        this.serverFlow = new TcpFlow('server'); // server to client

        this.state = 'ESTABLISHED';
        this.clientFin = false;
        this.serverFin = false;
        this.rst = false;
    }

    isClosed() {
        return this.rst || (this.clientFin && this.serverFin);
    }

    processPacket(packet, isClient) {
        const flow = isClient ? this.clientFlow : this.serverFlow;
        const flags = packet.transport.flags;

        if (flags.RST) {
            this.rst = true;
            this.state = 'CLOSED';
        }

        if (flags.FIN) {
            if (isClient) this.clientFin = true;
            else this.serverFin = true;
            if (this.clientFin && this.serverFin) {
                this.state = 'CLOSED';
            }
        }

        flow.processPacket(packet);
    }
}

export class TcpReconstructor {
    constructor() {
        this.connections = new Map();
        this.closedConnections = [];
    }

    push(packet) {
        if (!packet.ip || !packet.transport || packet.transport.type !== 'TCP') {
            return;
        }

        // Canonical keys based on ordered IP:port to group both directions of the flow into one connection
        const ipA = packet.ip.srcIP;
        const portA = packet.transport.srcPort;
        const ipB = packet.ip.dstIP;
        const portB = packet.transport.dstPort;

        let connectionKey = '';
        let isClient = false;

        // Ensure a deterministic string representation for the 4-tuple.
        if (ipA < ipB || (ipA === ipB && portA < portB)) {
            connectionKey = `${ipA}:${portA}-${ipB}:${portB}`;
            isClient = true; // The sender is A
        } else {
            connectionKey = `${ipB}:${portB}-${ipA}:${portA}`;
            isClient = false; // The sender is B
        }

        let connection = this.connections.get(connectionKey);

        // Check port reuse logic
        if (packet.transport.flags.SYN && connection && connection.isClosed()) {
            this.closedConnections.push(connection);
            connection = null; // Forces creation of a new connection state
        }

        if (!connection) {
            let trueClientIp, trueClientPort, trueServerIp, trueServerPort;
            if (packet.transport.flags.SYN) {
                // The source of the SYN is always the true client
                trueClientIp = ipA;
                trueClientPort = portA;
                trueServerIp = ipB;
                trueServerPort = portB;
            } else {
                // If we hop in mid-stream, fallback symmetrically to canonical order
                trueClientIp = ipA;
                trueClientPort = portA;
                trueServerIp = ipB;
                trueServerPort = portB;
            }

            connection = new TcpConnection(connectionKey, trueClientIp, trueClientPort, trueServerIp, trueServerPort);
            this.connections.set(connectionKey, connection);
        }

        const sendsAsClient = (ipA === connection.clientIp && portA === connection.clientPort);
        
        connection.processPacket(packet, sendsAsClient);
    }

    getConnections() {
        return [...this.closedConnections, ...this.connections.values()];
    }
}
