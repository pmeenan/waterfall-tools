// src/renderer/canvas.js

export class WaterfallCanvas {
    constructor(canvasElement) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d', { alpha: false }); // Opaque for speed
    }

    scaleRgb(rgb, factor) {
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

    // Replicate WPT's GetBarColors to build a linear gradient simulating 3D cylinder
    createBarGradient(x1, y1, y2, colorArr) {
        const height = y2 - y1;
        if (height <= 2) {
            // No gradient needed for tiny height
            return `rgb(${colorArr[0]}, ${colorArr[1]}, ${colorArr[2]})`;
        }

        const gradient = this.ctx.createLinearGradient(x1, y1, x1, y2);
        
        const hi_rgb = this.scaleRgb(colorArr, 0.2);
        const lo_rgb = this.scaleRgb(colorArr, -0.3);
        
        gradient.addColorStop(0, `rgb(${lo_rgb.join(',')})`);
        gradient.addColorStop(0.5, `rgb(${hi_rgb.join(',')})`);
        gradient.addColorStop(1, `rgb(${lo_rgb.join(',')})`);
        
        return gradient;
    }

    drawBar(x1, x2, y1, y2, colorArr, isThick = false) {
        // Enforce a minimum 1 pixel width
        if (x2 <= x1) x2 = x1 + 1;
        
        const fillStyle = isThick ? 
            this.createBarGradient(x1, y1, y2, colorArr) : 
            `rgb(${colorArr.join(',')})`;
            
        this.ctx.fillStyle = fillStyle;
        this.ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    render(rows, dimensions, rawEntries) {
        // Use requestAnimationFrame for smooth drawing
        requestAnimationFrame(() => {
            this.canvas.width = dimensions.canvasWidth;
            this.canvas.height = dimensions.canvasHeight;
            
            // clear background
            this.ctx.fillStyle = "#ffffff";
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // Time grid
            const intervalMs = dimensions.maxTime < 2000 ? 100 : 1000;
            const xScaler = (ms) => dimensions.labelsWidth + (ms * dimensions.widthPerMs);
            
            this.ctx.strokeStyle = '#e0e0e0';
            this.ctx.fillStyle = '#000';
            this.ctx.font = '11px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.beginPath();
            
            for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                const x = Math.floor(xScaler(t)) + 0.5;
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, this.canvas.height);
                // Label
                this.ctx.fillText(`${t / 1000}s`, x, 12);
            }
            this.ctx.stroke();

            // Divider between labels and waterfall
            this.ctx.strokeStyle = '#000000';
            this.ctx.beginPath();
            const divX = Math.floor(dimensions.labelsWidth) + 0.5;
            this.ctx.moveTo(divX, 0);
            this.ctx.lineTo(divX, this.canvas.height);
            this.ctx.stroke();

            this.ctx.textAlign = 'left';

            // Draw entries
            rows.forEach((row, index) => {
                const baseStartMs = rows[0].start; // Normalize
                
                // Draw background row alternating
                if (index % 2 === 1) {
                    this.ctx.fillStyle = "#f8f8f8";
                    this.ctx.fillRect(0, row.y1, this.canvas.width, row.y2 - row.y1 + 1);
                }

                // Error highlighting
                if (row.status >= 400 || row.status === 0) {
                    this.ctx.fillStyle = `rgba(${row.colors.error.join(',')}, 0.2)`;
                    this.ctx.fillRect(0, row.y1, this.canvas.width, row.y2 - row.y1 + 1);
                }

                const sDns = xScaler(row.dnsStart - baseStartMs);
                const sConn = xScaler(row.connectStart - baseStartMs);
                const sSsl = xScaler(row.sslStart - baseStartMs);
                const sTtfb = xScaler(row.ttfbStart - baseStartMs);
                const sDownload = xScaler(row.downloadStart - baseStartMs);
                const eDownload = xScaler(row.downloadEnd - baseStartMs);
                
                const centerY1 = row.y1 + Math.floor((row.y2 - row.y1) / 3);
                const centerY2 = row.y1 + Math.floor(2 * (row.y2 - row.y1) / 3);
                
                // Draw thin bars (state connections)
                if (sDns < sConn) this.drawBar(sDns, sConn, centerY1, centerY2, row.colors.dns, false);
                if (sConn < sSsl) this.drawBar(sConn, sSsl, centerY1, centerY2, row.colors.connect, false);
                if (sSsl < sTtfb) this.drawBar(sSsl, sTtfb, centerY1, centerY2, row.colors.ssl, false);
                
                // Thick bar rendering (TTFB + Download)
                if (row.chunks && row.chunks.length > 0) {
                    // TTFB across whole range (faded)
                    this.drawBar(sTtfb, Math.max(sTtfb+1, eDownload), row.y1, row.y2, row.colors.ttfb, true);
                    
                    // Render individual chunks
                    row.chunks.forEach(chunk => {
                        const chunkStartX = xScaler(chunk.ts - baseStartMs - (chunk.bw_time || 0));
                        const chunkEndX = xScaler(chunk.ts - baseStartMs);
                        this.drawBar(chunkStartX, chunkEndX, row.y1, row.y2, row.colors.download, true);
                    });
                } else {
                    // Standard solid bars
                    this.drawBar(sTtfb, sDownload, row.y1, row.y2, row.colors.ttfb, true);
                    this.drawBar(sDownload, eDownload, row.y1, row.y2, row.colors.download, true);
                }

                // JS Execution Overlay
                if (row.jsTiming && row.jsTiming.length > 0) {
                    const jsHeight = Math.max(2, Math.floor((row.y2 - row.y1) * 0.5));
                    const jsY1 = row.y1 + Math.floor(((row.y2 - row.y1) - jsHeight) / 2);
                    const jsY2 = jsY1 + jsHeight - 1;

                    row.jsTiming.forEach(times => {
                        const startX = xScaler(times[0] - baseStartMs);
                        const endX = xScaler(times[1] - baseStartMs);
                        this.drawBar(startX, endX, jsY1, jsY2, row.colors.js, false);
                    });
                }

                // Label drawing
                this.ctx.fillStyle = "#000";
                const labelText = `${index + 1}. ${row.url || ''}`;
                
                this.ctx.fillText(
                    labelText.length > 50 ? labelText.substring(0, 47) + '...' : labelText,
                    10,
                    row.y2 - 2
                );
            });
            
        });
    }
}
