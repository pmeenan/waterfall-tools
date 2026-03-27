/**
 * @fileoverview Extended HAR Types definitions for Waterfall Tools
 * Uses JSDoc syntax to provide type safety in IDEs for plain Vanilla JS natively.
 */

/**
 * @typedef {Object} Creator
 * @property {string} name - Name of the creator tool (e.g., waterfall-tools)
 * @property {string} version - Version of the tool
 */

/**
 * @typedef {Object} ExtendedHAREntry
 * @property {string} startedDateTime
 * @property {number} time
 * @property {Object} request
 * @property {Object} response
 * @property {Object} cache
 * @property {Object} timings
 * @property {string} [serverIPAddress]
 * @property {string} [connection]
 * @property {string} [pageref]
 * 
 * -- Waterfall Tools Extended Fields --
 * @property {string} [_id]
 * @property {string} [_request_id]
 * @property {string} [_full_url]
 * @property {string} [_url]
 * @property {string} [_host]
 * @property {string} [_ip_addr]
 * @property {string} [_protocol]
 * @property {number|boolean} [_is_secure]
 * @property {string} [_method]
 * @property {number} [_responseCode]
 * @property {number|string} [_socket]
 * @property {string} [_request_type]
 * @property {number|string} [_type]
 * 
 * @property {number} [_load_start]
 * @property {number} [_load_ms]
 * @property {number} [_load_end]
 * @property {number} [_ttfb_start]
 * @property {number} [_ttfb_ms]
 * @property {number} [_download_start]
 * @property {number} [_download_ms]
 * @property {number} [_dns_start]
 * @property {number} [_dns_end]
 * @property {number} [_connect_start]
 * @property {number} [_connect_end]
 * @property {number} [_ssl_start]
 * @property {number} [_ssl_end]
 * 
 * @property {number} [_bytesIn]
 * @property {number} [_objectSize]
 * @property {number} [_objectSizeUncompressed]
 * @property {string} [_priority]
 * @property {string} [_initial_priority]
 * @property {boolean} [_renderBlocking]
 * @property {boolean} [_is_base_page]
 * @property {boolean} [_final_base_page]
 * 
 * @property {string} [_initiator]
 * @property {string} [_initiator_type]
 * @property {string|number} [_initiator_line]
 * @property {string|number} [_initiator_column]
 */

/**
 * @typedef {Object} ExtendedHARPage
 * @property {string} startedDateTime
 * @property {string} id
 * @property {string} title
 * @property {Object} pageTimings
 * 
 * -- Waterfall Tools Extended Fields --
 * @property {number} [_firstContentfulPaint]
 * @property {number} [_firstPaint]
 * @property {number} [_firstMeaningfulPaint]
 * @property {number} [_domComplete]
 * @property {number} [_fullyLoaded]
 * @property {number} [_visualComplete]
 * @property {number} [_loadEventStart]
 * @property {number} [_loadEventEnd]
 */

/**
 * @typedef {Object} ExtendedHARLog
 * @property {string} version - Standard is "1.2"
 * @property {Creator} creator
 * @property {ExtendedHARPage[]} pages
 * @property {ExtendedHAREntry[]} entries
 */

/**
 * @typedef {Object} ExtendedHAR
 * @property {ExtendedHARLog} log
 */

export {};
