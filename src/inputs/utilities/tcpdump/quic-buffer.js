/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class QuicBuffer {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    get remaining() {
        return this.buffer.length - this.offset;
    }

    readUInt8() {
        return this.buffer[this.offset++];
    }

    readBytes(len) {
        if (this.offset + len > this.buffer.length) return null;
        const b = this.buffer.subarray(this.offset, this.offset + len);
        this.offset += len;
        return b;
    }

    readVarInt() {
        if (this.remaining < 1) return null;
        const firstByte = this.buffer[this.offset];
        const lenIndicator = (firstByte & 0xC0) >> 6;
        
        let val = BigInt(firstByte & 0x3F);
        this.offset++;

        const lengths = [0, 1, 3, 7];
        const bytesToRead = lengths[lenIndicator];
        
        if (this.remaining < bytesToRead) return null;

        for (let i = 0; i < bytesToRead; i++) {
            val = (val << 8n) | BigInt(this.buffer[this.offset++]);
        }
        return Number(val);
    }
}
