// src/renderer/layout.js
const FONT_HEIGHT = 12;

export class Layout {
    static getMimeColor(mime, url = null) {
        if (!mime) return [196, 196, 196]; // other
        
        let contentType = 'other';
        const lowerMime = mime.toLowerCase();
        
        if (lowerMime.includes('javascript') || lowerMime.includes('ecmascript') || lowerMime.startsWith('text/js')) contentType = 'js';
        else if (lowerMime.startsWith('text/css')) contentType = 'css';
        else if (lowerMime.startsWith('text/html')) contentType = 'html';
        else if (lowerMime.startsWith('image/')) contentType = 'image';
        else if (lowerMime.startsWith('video/')) contentType = 'video';
        else if (lowerMime.includes('flash')) contentType = 'flash';
        else if (lowerMime.includes('font')) contentType = 'font';
        else if (url) {
            const extMatch = url.match(/\.([a-zA-Z0-9]+)(\?|$)/);
            if (extMatch) {
                const ext = extMatch[1].toLowerCase();
                if (ext === 'js') contentType = 'js';
                else if (ext === 'css') contentType = 'css';
                else if (ext === 'html' || ext === 'htm') contentType = 'html';
                else if (['png', 'gif', 'jpg', 'jpeg', 'avif', 'jxl'].includes(ext)) contentType = 'image';
                else if (['eot', 'ttf', 'woff', 'woff2', 'otf'].includes(ext)) contentType = 'font';
                else if (['mp4', 'f4v', 'flv'].includes(ext)) contentType = 'video';
                else if (ext === 'swf') contentType = 'flash';
            }
        }
        
        const colors = {
            'html':  [130, 181, 252],
            'js':    [254, 197, 132],
            'css':   [178, 234, 148],
            'image': [196, 154, 232],
            'flash': [45, 183, 193],
            'font':  [255, 82, 62],
            'video': [33, 194, 162],
            'other': [196, 196, 196]
        };
        return colors[contentType] || colors.other;
    }

    static scaleRgb(rgb, factor) {
        factor = Math.max(-1, Math.min(1, factor));
        if (factor >= 0) {
            return [
                Math.floor((255 - rgb[0]) * factor + rgb[0]),
                Math.floor((255 - rgb[1]) * factor + rgb[1]),
                Math.floor((255 - rgb[2]) * factor + rgb[2])
            ];
        } else {
            return [
                Math.floor(rgb[0] * (1.0 + factor)),
                Math.floor(rgb[1] * (1.0 + factor)),
                Math.floor(rgb[2] * (1.0 + factor))
            ];
        }
    }

    static getRequestColors(mime, url) {
        const baseColor = this.getMimeColor(mime, url);
        const ttfbColor = this.scaleRgb(baseColor, 0.65);
        
        return {
            wait:     [255, 254, 214],
            dns:      [0, 123, 132],
            connect:  [255, 123, 0],
            ssl:      [207, 37, 223],
            ttfb:     ttfbColor,
            download: baseColor,
            js:       [255, 173, 255],
            error:    [255, 96, 96],
            warning:  [255, 255, 96]
        };
    }

    static formatUrl(fullUrl, maxLength = 500) {
        if (!fullUrl) return '';
        try {
            const u = new URL(fullUrl);
            const combined = `${u.hostname} - ${u.pathname}`;
            if (combined.length <= maxLength) return combined;
            
            const half = Math.floor((maxLength - 3) / 2);
            return combined.substring(0, half) + '...' + combined.substring(combined.length - half);
        } catch(e) {
            if (fullUrl.length <= maxLength) return fullUrl;
            const half = Math.floor((maxLength - 3) / 2);
            return fullUrl.substring(0, half) + '...' + fullUrl.substring(fullUrl.length - half);
        }
    }

    static calculateRows(entries, canvasWidth = 1012, options = {}) {
        const rowHeight = options.thumbnailView ? 4 : 18;

        if (!entries || entries.length === 0) {
            return { rows: [], dimensions: { canvasWidth, canvasHeight: 0, maxTime: 0, labelsWidth: 0, widthPerMs: 0 }};
        }

        // Apply reqFilter (e.g. "1,2,5-10")
        if (options.reqFilter && typeof options.reqFilter === 'string') {
            const parts = options.reqFilter.split(',').map(s => s.trim());
            const allowedIndices = new Set();
            parts.forEach(p => {
                if (p.includes('-')) {
                    const bounds = p.split('-');
                    const s = parseInt(bounds[0], 10);
                    const e = parseInt(bounds[1], 10);
                    if (!isNaN(s) && !isNaN(e)) {
                        for(let i=s; i<=e; i++) allowedIndices.add(i);
                    }
                } else {
                    const idx = parseInt(p, 10);
                    if (!isNaN(idx)) allowedIndices.add(idx);
                }
            });
            if (allowedIndices.size > 0) {
                // Keep only requests whose native 1-based index is in the set
                entries = entries.filter((_, idx) => allowedIndices.has(idx + 1));
            }
        }

        if (entries.length === 0) {
            return { rows: [], dimensions: { canvasWidth, canvasHeight: 0, maxTime: 0, labelsWidth: 0, widthPerMs: 0 }};
        }

        let maxTime = 0;
        let baseMs = Number.MAX_SAFE_INTEGER;
        
        if (options.startTime !== undefined && options.startTime !== null && options.page && options.page.startedDateTime) {
            baseMs = new Date(options.page.startedDateTime).getTime() + (options.startTime * 1000);
        } else if (options.page && options.page.startedDateTime) {
            baseMs = new Date(options.page.startedDateTime).getTime();
        } else {
            for (let i = 0; i < entries.length; i++) {
                const temp = entries[i].time_start;
                if (temp < baseMs) {
                    baseMs = temp;
                }
            }
        }
        
        let endTimeOverride = null;
        if (options.endTime !== undefined && options.endTime !== null) {
            endTimeOverride = options.endTime * 1000;
        }
        
        const processedRows = entries.map((entry, index) => {
            let start = entry.time_start;
            let timeTotal = 0;
            
            // Allow Absolute timing mapping bypassing standard sequential HAR chaining universally
            let hasAbsoluteTimings = entry._load_start !== undefined || entry._dns_start !== undefined || entry._ttfb_start !== undefined;
            
            let baseEpoch = entry.time_start;
            if (entry._created !== undefined) {
                baseEpoch = entry.time_start - entry._created;
            } else if (hasAbsoluteTimings && entry._load_start !== undefined && entry._load_start >= 0) {
                baseEpoch = entry.time_start - entry._load_start;
            }
            
            let blockedEnd, dnsStart, dnsEnd, connectStart, connectEnd, sslStart, sslEnd, requestStart, ttfb, end;

            if (hasAbsoluteTimings) {
                // Universal Absolute bounds (natively defined by WPT specifications)
                if (entry._dns_start !== undefined && entry._dns_start >= 0 && (baseEpoch + entry._dns_start) < start) {
                    start = baseEpoch + entry._dns_start;
                }
                
                blockedEnd = baseEpoch + (entry._load_start || entry._ttfb_start || 0); // Queue finishes right when the request loads
                
                dnsStart = (entry._dns_start !== undefined && entry._dns_start >= 0) ? baseEpoch + entry._dns_start : blockedEnd;
                dnsEnd = (entry._dns_end !== undefined && entry._dns_end >= 0) ? baseEpoch + entry._dns_end : dnsStart;
                
                connectStart = (entry._connect_start !== undefined && entry._connect_start >= 0) ? baseEpoch + entry._connect_start : dnsEnd;
                connectEnd = (entry._connect_end !== undefined && entry._connect_end >= 0) ? baseEpoch + entry._connect_end : connectStart;
                
                sslStart = (entry._ssl_start !== undefined && entry._ssl_start >= 0) ? baseEpoch + entry._ssl_start : connectEnd;
                sslEnd = (entry._ssl_end !== undefined && entry._ssl_end >= 0) ? baseEpoch + entry._ssl_end : sslStart;
                
                requestStart = baseEpoch + (entry._load_start !== undefined ? entry._load_start : (entry._ttfb_start !== undefined ? entry._ttfb_start : (sslEnd - baseEpoch)));
                ttfb = baseEpoch + (entry._ttfb_end !== undefined ? entry._ttfb_end : (entry._ttfb_start !== undefined ? entry._ttfb_start : (entry._load_start !== undefined ? entry._load_start : (requestStart - baseEpoch))));
                
                end = baseEpoch + (entry._download_end !== undefined ? entry._download_end : (entry._load_end !== undefined ? entry._load_end : (entry._ttfb_end !== undefined ? entry._ttfb_end : (ttfb - baseEpoch))));
                timeTotal = end - start;
                
            } else {
                // Standard sequential HAR Fallback
                if (entry._dnsTimeMs > 0 && entry._dnsTimeMs < start) start = entry._dnsTimeMs;
                if (entry._connectTimeMs > 0 && entry._connectTimeMs < start) start = entry._connectTimeMs;
                
                if (entry.timings && entry.timings.blocked > 0) timeTotal += entry.timings.blocked;
                if (entry.timings && entry.timings.dns > 0) timeTotal += entry.timings.dns;
                if (entry.timings && entry.timings.connect > 0) timeTotal += entry.timings.connect;
                if (entry.timings) timeTotal += entry.timings.send || 0;
                if (entry.timings) timeTotal += entry.timings.wait || 0;
                if (entry.timings) timeTotal += entry.timings.receive || 0;
                
                end = entry.time_start + timeTotal;
                if (entry.time_end && entry.time_end > end) end = entry.time_end;
                
                blockedEnd = entry.time_start;
                if (entry.timings && entry.timings.blocked > 0) blockedEnd = entry.time_start + entry.timings.blocked;
                
                dnsStart = entry._dnsTimeMs > 0 ? entry._dnsTimeMs : blockedEnd;
                dnsEnd = entry._dnsEndTimeMs > 0 ? entry._dnsEndTimeMs : dnsStart + (entry.timings ? Math.max(0, entry.timings.dns) : 0);
                
                connectStart = entry._connectTimeMs > 0 ? entry._connectTimeMs : dnsEnd;
                connectEnd = entry._connectEndTimeMs > 0 ? entry._connectEndTimeMs : connectStart + (entry.timings ? Math.max(0, entry.timings.connect) : 0);
                
                sslStart = entry._sslStartTimeMs > 0 ? entry._sslStartTimeMs : connectEnd;
                sslEnd = sslStart;
                if (entry.timings && entry.timings.ssl > 0) sslEnd = sslStart + entry.timings.ssl;
                
                requestStart = entry._requestTimeMs > 0 ? entry._requestTimeMs : sslEnd + (entry.timings ? Math.max(0, entry.timings.send || 0) : 0);
                
                ttfb = requestStart;
                if (entry.first_data_time > 0) {
                    ttfb = entry.first_data_time;
                } else {
                    ttfb = requestStart + (entry.timings ? Math.max(0, entry.timings.wait || 0) : 0);
                }
            }
            
            // Protect against legacy inversions where connection ends dynamically post request starts
            if (requestStart < connectEnd) {
                requestStart = connectEnd;
                ttfb = Math.max(ttfb, requestStart);
            }

            const colors = this.getRequestColors(entry.mimeType, entry.url);
            
            // Allow bounds filtering to override ending points mathematically
            if (endTimeOverride && end - baseMs > endTimeOverride) {
                // Clamp end time to the user specified bound if it exceeds it globally
            }
            // To ensure maxTime accurately reflects visible elements
            maxTime = Math.max(maxTime, end - baseMs);
            
            return {
                index,
                url: this.formatUrl(entry.url),
                time: timeTotal,
                start,
                end,
                status: entry.status,
                blockedEnd,
                dnsStart, dnsEnd: connectStart,
                connectStart, connectEnd: sslStart,
                sslStart, sslEnd: requestStart,
                ttfbStart: requestStart,
                ttfbEnd: ttfb,
                downloadStart: ttfb,
                downloadEnd: end,
                chunks: entry._chunks || [], // Handle WPT custom chunks natively matching
                jsTiming: entry._js_timing || [], 
                documentURL: entry._documentURL || '',
                renderBlocking: entry._renderBlocking || '',
                colors
            };
        });

        if (endTimeOverride !== null && endTimeOverride > 0) {
            maxTime = Math.max(0, endTimeOverride);
        }

        // Leave room for labels
        let labelsWidth = options.thumbnailView ? (canvasWidth * 0.25) : 250;
        if (options.showLabels === false) {
            labelsWidth = 0;
        }
        
        const dataWidth = canvasWidth - labelsWidth - 5;
        const widthPerMs = maxTime > 0 ? (dataWidth / maxTime) : 0;
        
        let yOffset = options.showLegend ? 35 : 0;

        // Finalize rows with their geometric positions (y values)
        if (options.connectionView) {
            let currentRowIdx = 0;
            const connRowMap = new Map();
            processedRows.forEach((row) => {
                let rIdx = currentRowIdx;
                // Treat requests without connection_id as isolated rows natively
                if (entries[row.index] && entries[row.index].connection_id) {
                    const cid = entries[row.index].connection_id.toString();
                    if (connRowMap.has(cid)) {
                        rIdx = connRowMap.get(cid);
                    } else {
                        connRowMap.set(cid, currentRowIdx);
                        rIdx = currentRowIdx;
                        currentRowIdx++;
                    }
                } else {
                    currentRowIdx++;
                }

                row.y1 = rIdx * rowHeight + rowHeight + yOffset;
                row.y2 = row.y1 + rowHeight - 1;
                row.maxMs = maxTime;
                row.layoutParams = { labelsWidth, dataWidth, widthPerMs, canvasWidth };
            });
            // Update total canvas height to reflect collapsed connection view
            options._totalRows = currentRowIdx;
        } else {
            processedRows.forEach((row, index) => {
                row.y1 = index * rowHeight + rowHeight + yOffset;
                row.y2 = row.y1 + rowHeight - 1;
                row.maxMs = maxTime;
                row.layoutParams = { labelsWidth, dataWidth, widthPerMs, canvasWidth };
            });
            options._totalRows = processedRows.length;
        }

        let pageEvents = {};
        let maxBw = 0;
        if (options.page) {
            const p = options.page;
            if (p._render > 0) pageEvents['render'] = p._render;
            
            if (p._domContentLoadedEventStart > 0 && p._domContentLoadedEventEnd > 0) {
                pageEvents['nav_dom'] = [p._domContentLoadedEventStart, p._domContentLoadedEventEnd];
            } else if (p.pageTimings && p.pageTimings.onContentLoad > 0) {
                pageEvents['nav_dom'] = p.pageTimings.onContentLoad;
            } else if (p._domContentLoadedEventEnd > 0) {
                pageEvents['nav_dom'] = p._domContentLoadedEventEnd;
            }

            if (p._loadEventStart > 0 && p._loadEventEnd > 0) {
                pageEvents['nav_load'] = [p._loadEventStart, p._loadEventEnd];
            } else if (p._loadEventEnd > 0) {
                pageEvents['nav_load'] = [p._loadEventEnd, p._loadEventEnd];
            }
            
            if (p.pageTimings && p.pageTimings.onLoad > 0) {
                pageEvents['load'] = p.pageTimings.onLoad;
            }
            
            if (p._firstContentfulPaint > 0) pageEvents['fcp'] = p._firstContentfulPaint;
            if (p._LargestContentfulPaint > 0) pageEvents['lcp'] = p._LargestContentfulPaint;
            if (p._domInteractive > 0) pageEvents['nav_dom_interactive'] = p._domInteractive;
            
            if (p._bwDown > 0) maxBw = p._bwDown;
            if (options.showCpu && p._utilization && p._utilization.cpu) {
               // Track presence
            }
        }
        
        // Add padding bottom for charts if selected
        let additionalHeight = 0;
        if (options.showCpu || options.showBw) additionalHeight += (options.thumbnailView ? 16 : 50);
        if (options.showMainthread) additionalHeight += (options.thumbnailView ? 16 : 50);
        if (options.showLongtasks) additionalHeight += (options.thumbnailView ? 4 : 18);

        return { 
            rows: processedRows, 
            dimensions: { 
                canvasWidth, 
                canvasHeight: options._totalRows * rowHeight + (rowHeight * 2) + yOffset + additionalHeight, 
                maxTime,
                baseMs,
                labelsWidth,
                widthPerMs,
                maxBw
            },
            pageEvents
        };
    }
}
