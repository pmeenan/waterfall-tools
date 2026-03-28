import { identifyFormat, parsers } from '../inputs/orchestrator.js';

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
}
