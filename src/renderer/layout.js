// src/renderer/layout.js
const ROW_HEIGHT = 18;
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
        if (!entries || entries.length === 0) {
            return { rows: [], dimensions: { canvasWidth, canvasHeight: 0, maxTime: 0, labelsWidth: 0, widthPerMs: 0 }};
        }

        let maxTime = 0;
        let baseMs = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < entries.length; i++) {
            const temp = new Date(entries[i].startedDateTime).getTime();
            if (temp < baseMs) {
                baseMs = temp;
            }
        }
        
        const processedRows = entries.map((entry, index) => {
            const start = new Date(entry.startedDateTime).getTime();
            let end = start + entry.time;
            
            let dnsStart = start;
            let connectStart = start;
            let sslStart = start;
            let requestStart = start;
            let ttfb = start;
            let blockedEnd = start;

            if (entry.timings) {
                if (entry.timings.blocked > 0) blockedEnd = start + entry.timings.blocked;
                else blockedEnd = start;
                
                dnsStart = blockedEnd;
                connectStart = dnsStart + Math.max(0, entry.timings.dns);
                sslStart = connectStart;
                
                requestStart = connectStart + Math.max(0, entry.timings.connect);
                if (entry.timings.ssl > 0) {
                    sslStart = requestStart - entry.timings.ssl; // SSL happens at end of connect
                }
                
                requestStart += Math.max(0, entry.timings.send);
                ttfb = requestStart + Math.max(0, entry.timings.wait);
            }

            maxTime = Math.max(maxTime, end - baseMs);

            const colors = this.getRequestColors(entry.response?.content?.mimeType, entry.request?.url);
            
            return {
                index,
                url: this.formatUrl(entry.request?.url),
                time: entry.time,
                start,
                end,
                status: entry.response?.status,
                blockedEnd,
                dnsStart, dnsEnd: connectStart,
                connectStart, connectEnd: sslStart,
                sslStart, sslEnd: requestStart,
                ttfbStart: requestStart,
                ttfbEnd: ttfb,
                downloadStart: ttfb,
                downloadEnd: end,
                chunks: entry._chunks || [], // Handle WPT custom chunks if they exist
                jsTiming: entry._js_timing || [], // Handle script executions overlapping
                colors
            };
        });

        // Compute scaling logic
        // Leave room for labels
        const labelsWidth = Math.max(30, canvasWidth * 0.25);
        const dataWidth = canvasWidth - labelsWidth - 5;
        const widthPerMs = maxTime > 0 ? (dataWidth / maxTime) : 0;
        
        let yOffset = options.showLegend ? 35 : 0;

        // Finalize rows with their geometric positions (y values)
        processedRows.forEach((row, index) => {
            row.y1 = index * ROW_HEIGHT + ROW_HEIGHT + yOffset;
            row.y2 = row.y1 + ROW_HEIGHT - 2;
            row.maxMs = maxTime;
            row.layoutParams = { labelsWidth, dataWidth, widthPerMs, canvasWidth };
        });

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
        }

        return { 
            rows: processedRows, 
            dimensions: { 
                canvasWidth, 
                canvasHeight: processedRows.length * ROW_HEIGHT + (ROW_HEIGHT * 3) + yOffset, 
                maxTime,
                labelsWidth,
                widthPerMs,
                maxBw
            },
            pageEvents
        };
    }
}
