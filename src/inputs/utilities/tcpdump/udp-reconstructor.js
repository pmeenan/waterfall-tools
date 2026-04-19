/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class UdpFlow {
    constructor(direction) {
        this.direction = direction; // 'client' or 'server'
        // Unlike TCP, UDP just collects independent datagram frames in temporal order
        this.frames = []; 
    }

    processPacket(packet, isClient) {
        if (!packet.payload || packet.payload.length === 0) {
            return;
        }

        this.frames.push({
            time: packet.time,
            bytes: packet.payload,
            isClient: isClient
        });
    }
}

export class UdpConnection {
    constructor(id, clientIp, clientPort, serverIp, serverPort) {
        this.id = id;
        this.clientIp = clientIp;
        this.clientPort = clientPort;
        this.serverIp = serverIp;
        this.serverPort = serverPort;

        this.clientFlow = new UdpFlow('client'); // client to server
        this.serverFlow = new UdpFlow('server'); // server to client
    }

    processPacket(packet, isClient) {
        const flow = isClient ? this.clientFlow : this.serverFlow;
        flow.processPacket(packet, isClient);
    }
}

export class UdpReconstructor {
    constructor() {
        this.connections = new Map();
    }

    push(packet) {
        if (!packet.ip || !packet.transport || packet.transport.type !== 'UDP') {
            return;
        }

        const ipA = packet.ip.srcIP;
        const portA = packet.transport.srcPort;
        const ipB = packet.ip.dstIP;
        const portB = packet.transport.dstPort;

        let connectionKey;

        // Canonical key ordering based on IP:port.
        if (ipA < ipB || (ipA === ipB && portA < portB)) {
            connectionKey = `${ipA}:${portA}-${ipB}:${portB}`;
        } else {
            connectionKey = `${ipB}:${portB}-${ipA}:${portA}`;
        }

        let connection = this.connections.get(connectionKey);

        if (!connection) {
            // For UDP, we assume the very first packet seen on a 4-tuple is the Client pinging the Server. 
            // e.g., DNS query or initial QUIC handshake.
            connection = new UdpConnection(connectionKey, ipA, portA, ipB, portB);
            this.connections.set(connectionKey, connection);
        }

        const sendsAsClient = (ipA === connection.clientIp && portA === connection.clientPort);
        
        connection.processPacket(packet, sendsAsClient);
    }

    getConnections() {
        // Because UDP is connectionless, we never intentionally "close" connections mid-trace.
        return Array.from(this.connections.values());
    }
}
