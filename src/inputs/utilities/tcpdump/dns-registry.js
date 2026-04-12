/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class DnsRegistry {
    constructor() {
        this.pending = new Map();
        this.lookups = [];
    }

    /**
     * Store an outgoing DNS Request expecting a matching response
     */
    addRequest(transactionId, time, queries, transportMetadata) {
        const key = `${transactionId}-${transportMetadata.type}-${transportMetadata.ip}`;
        this.pending.set(key, { time, queries, transportMetadata });
    }

    /**
     * Map an incoming response to its corresponding query
     */
    addResponse(transactionId, time, answers, transportMetadata) {
        const key = `${transactionId}-${transportMetadata.type}-${transportMetadata.ip}`;
        const req = this.pending.get(key);
        
        if (req) {
            this.pending.delete(key);
            const domain = req.queries.length > 0 ? req.queries[0].name : '';
            // Only extract valid resolved addresses (A or AAAA)
            const ips = answers.map(a => a.address).filter(Boolean);
            
            this.lookups.push({
                domain,
                ips,
                requestTime: req.time,
                responseTime: time,
                duration: time - req.time,
                transport: req.transportMetadata.type
            });
        }
    }

    /**
     * Bypasses the pending state map to manually inject complete records 
     * (Ideal for DoH tracking paired HTTP request/response lifecycles).
     */
    addCompletedLookup(domain, ips, requestTime, responseTime, transport = 'DoH') {
        this.lookups.push({
            domain,
            ips,
            requestTime,
            responseTime,
            duration: responseTime - requestTime,
            transport
        });
    }

    /**
     * Retrieves all successfully resolved namespace lookups sequentially
     */
    getLookups() {
        return this.lookups.sort((a, b) => a.requestTime - b.requestTime);
    }
}
