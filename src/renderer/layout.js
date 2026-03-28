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
            dns:      ttfbColor,
            connect:  ttfbColor,
            ssl:      ttfbColor,
            ttfb:     ttfbColor,
            download: baseColor,
            js:       [255, 173, 255],
            error:    [255, 96, 96],
            warning:  [255, 255, 96]
        };
    }

    static calculateRows(entries, canvasWidth = 1012) {
        let maxTime = 0;
        
        const processedRows = entries.map((entry, index) => {
            const start = new Date(entry.startedDateTime).getTime();
            let end = start + entry.time;
            
            // if we have proper detailed timings, let's establish exact dates
            let dnsStart = start;
            let connectStart = start;
            let sslStart = start;
            let requestStart = start;
            let ttfb = start;
            
            if (entry.timings) {
                if (entry.timings.dns > 0) connectStart += entry.timings.dns;
                if (entry.timings.connect > 0) sslStart += entry.timings.connect;
                if (entry.timings.ssl > 0) requestStart = sslStart + entry.timings.ssl;
                else requestStart = connectStart;
                
                if (entry.timings.send > 0) requestStart += entry.timings.send;
                if (entry.timings.wait > 0) ttfb = requestStart + entry.timings.wait;
            }

            maxTime = Math.max(maxTime, end);

            const colors = this.getRequestColors(entry.response?.content?.mimeType, entry.request?.url);
            
            return {
                index,
                url: entry.request?.url,
                start,
                end,
                status: entry.response?.status,
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
        
        // Finalize rows with their geometric positions (y values)
        processedRows.forEach((row, index) => {
            row.y1 = index * ROW_HEIGHT + ROW_HEIGHT;
            row.y2 = row.y1 + ROW_HEIGHT - 2;
            row.maxMs = maxTime;
            row.layoutParams = { labelsWidth, dataWidth, widthPerMs, canvasWidth };
        });

        return { 
            rows: processedRows, 
            dimensions: { 
                canvasWidth, 
                canvasHeight: processedRows.length * ROW_HEIGHT + (ROW_HEIGHT * 3), 
                maxTime,
                labelsWidth,
                widthPerMs 
            } 
        };
    }
}
