import { identifyFormat, identifyFormatFromBuffer, parsers } from '../inputs/orchestrator.js';
import { Readable } from 'stream';

export class Conductor {
    /**
     * Processes a network trace file and returns it as an Extended HAR.
     * @param {string} filePath - Path to the file to process (e.g. .har, .pcap, .json)
     * @param {Object} options - Optional parameters
     * @param {string} [options.format] - Force a specific format. If omitted, orchestrator auto-detects.
     * @param {string} [options.keyLogInput] - (tcpdump only) Path or stream for TLS key log
     * @returns {Promise<Object>} The standard Extended HAR object
     */
    static async processFile(filePath, options = {}) {
        let format = options.format;
        
        if (!format) {
            format = await identifyFormat(filePath);
        }
        
        if (format === 'unknown') {
            throw new Error(`Could not automatically identify format for file: ${filePath}`);
        }
        
        const parser = parsers[format];
        if (!parser) {
            throw new Error(`No parser registered for format: ${format}`);
        }
        
        return await parser(filePath, options);
    }

    /**
     * Processes a network trace Readable stream and returns it as an Extended HAR.
     * @param {Readable} stream - Node.js readable stream of the trace data
     * @param {Object} options - Optional parameters
     * @param {string} options.format - Required for streams: The format of the incoming stream
     * @param {boolean} [options.isGz] - True if the incoming stream is gzipped
     * @param {boolean} [options.hasTraceEventsWrapper] - (chrome-trace only) True if wrapping JSON exists
     * @param {Readable} [options.keyLogInput] - (tcpdump only) Stream for TLS key log
     * @returns {Promise<Object>} The standard Extended HAR object
     */
    static async processStream(stream, options = {}) {
        const format = options.format;
        if (!format) {
            throw new Error('For processStream, you must explicitly provide options.format');
        }
        
        const parser = parsers[format];
        if (!parser) {
            throw new Error(`No parser registered for format: ${format}`);
        }
        
        return await parser(stream, options);
    }

    /**
     * Processes a network trace from a raw Memory Buffer or ArrayBuffer
     * @param {Buffer|ArrayBuffer|Uint8Array} buffer - The raw binary data
     * @param {Object} options - Optional parameters
     * @param {string} options.format - Required: The format of the incoming buffer
     * @param {boolean} [options.isGz] - True if the incoming buffer is gzipped
     * @returns {Promise<Object>} The standard Extended HAR object
     */
    static async processBuffer(buffer, options = {}) {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        let format = options.format;
        let isGz = options.isGz;

        if (!format) {
            const detected = await identifyFormatFromBuffer(buf);
            format = detected.format;
            if (isGz === undefined) {
                isGz = detected.isGz;
            }
            if (format === 'unknown') {
                throw new Error('Could not automatically identify format from buffer');
            }
        }
        
        const stream = Readable.from([buf]);
        const streamOptions = { ...options, format };
        if (isGz !== undefined) streamOptions.isGz = isGz;
        
        return await this.processStream(stream, streamOptions);
    }

    /**
     * Processes an external network trace file by fetching it via URL
     * @param {string} url - The URL to fetch the trace from
     * @param {Object} options - Optional parameters
     * @param {string} options.format - Required: The format of the remote file
     * @param {boolean} [options.isGz] - True if the incoming file is gzipped
     * @returns {Promise<Object>} The standard Extended HAR object
     */
    static async processURL(url, options = {}) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch URL ${url}: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        return await this.processBuffer(arrayBuffer, options);
    }
}
