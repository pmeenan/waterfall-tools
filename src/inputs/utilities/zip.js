/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class ZipReader {
    constructor(storage) {
        this.storage = storage;
        this.files = new Map();
    }

    async init() {
        const size = await this.storage.getSize();
        if (size < 22) throw new Error("Invalid Zip: file too small");

        const maxComment = 65535;
        const eocdSize = Math.min(size, maxComment + 22);
        const eocdOffset = size - eocdSize;
        const eocdBuf = await this.storage.read(eocdOffset, eocdSize);
        const dataView = new DataView(eocdBuf.buffer, eocdBuf.byteOffset, eocdBuf.byteLength);

        // Find signature backwards
        let cdOffset = -1;
        let cdSize = -1;
        for (let i = eocdBuf.byteLength - 22; i >= 0; i--) {
            // Little-endian PK\x05\x06 = 0x06054b50
            if (dataView.getUint32(i, true) === 0x06054b50) {
                cdSize = dataView.getUint32(i + 12, true);
                cdOffset = dataView.getUint32(i + 16, true);
                break;
            }
        }

        if (cdOffset === -1) throw new Error("Invalid Zip: EOCD not found");

        const cdBuf = await this.storage.read(cdOffset, cdSize);
        const cdView = new DataView(cdBuf.buffer, cdBuf.byteOffset, cdBuf.byteLength);
        
        let pos = 0;
        const decoder = new TextDecoder('utf-8');
        while (pos + 46 <= cdBuf.byteLength) {
            if (cdView.getUint32(pos, true) !== 0x02014b50) break;

            const method = cdView.getUint16(pos + 10, true);
            const compSize = cdView.getUint32(pos + 20, true);
            const uncompSize = cdView.getUint32(pos + 24, true);
            const nameLen = cdView.getUint16(pos + 28, true);
            const extraLen = cdView.getUint16(pos + 30, true);
            const commentLen = cdView.getUint16(pos + 32, true);
            const localHeaderOffset = cdView.getUint32(pos + 42, true);

            const nameBuf = cdBuf.subarray(pos + 46, pos + 46 + nameLen);
            const name = decoder.decode(nameBuf);

            this.files.set(name, {
                name,
                method,
                compSize,
                uncompSize,
                localHeaderOffset
            });

            pos += 46 + nameLen + extraLen + commentLen;
        }
    }

    async getFileStream(filename) {
        const fileInfo = this.files.get(filename);
        if (!fileInfo) return null;

        // Read Local File Header to find exact data offset
        const lfhBuf = await this.storage.read(fileInfo.localHeaderOffset, 30);
        const lfhView = new DataView(lfhBuf.buffer, lfhBuf.byteOffset, lfhBuf.byteLength);
        
        if (lfhView.getUint32(0, true) !== 0x04034b50) {
            throw new Error(`Invalid Zip: LFH not found for ${filename}`);
        }

        const nameLen = lfhView.getUint16(26, true);
        const extraLen = lfhView.getUint16(28, true);
        
        // Data block immediately follows the LFH variable properties
        const dataOffset = fileInfo.localHeaderOffset + 30 + nameLen + extraLen;
        
        // Chunk reader natively extracting slices
        const storage = this.storage;
        const chunkSize = 65536;
        let bytesRead = 0;
        let stream = new ReadableStream({
            async pull(controller) {
                if (bytesRead >= fileInfo.compSize) {
                    controller.close();
                    return;
                }
                const readLen = Math.min(chunkSize, fileInfo.compSize - bytesRead);
                const chunk = await storage.read(dataOffset + bytesRead, readLen);
                bytesRead += readLen;
                controller.enqueue(chunk);
            }
        });

        // 8 is DEFLATE
        if (fileInfo.method === 8) {
            stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        } else if (fileInfo.method !== 0) {
            throw new Error(`Unsupported zip compression method ${fileInfo.method} for ${filename}`);
        }

        return stream;
    }

    getFileList() {
        return Array.from(this.files.keys());
    }
}
