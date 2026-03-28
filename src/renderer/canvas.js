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

    interpolateColors(rgb1, rgb2, num) {
        const colors = [];
        if (num >= 1) {
            colors.push(rgb1);
            const steps = [
                (rgb2[0] - rgb1[0]) / (num - 1),
                (rgb2[1] - rgb1[1]) / (num - 1),
                (rgb2[2] - rgb1[2]) / (num - 1)
            ];
            for (let i = 1; i < num - 1; i++) {
                colors.push([
                    Math.floor((steps[0] * i) + rgb1[0]),
                    Math.floor((steps[1] * i) + rgb1[1]),
                    Math.floor((steps[2] * i) + rgb1[2])
                ]);
            }
            if (num >= 2) {
                colors.push(rgb2);
            }
        }
        return colors;
    }

    getBarColors(rgb, num) {
        if (num > 4) {
            const hi_rgb = this.scaleRgb(rgb, 0.3);
            const lo_rgb = this.scaleRgb(rgb, -0.2);
            const colors = this.interpolateColors(hi_rgb, lo_rgb, num - 2);
            const mid_color = colors[Math.floor((num - 2) / 2)];
            return [mid_color, hi_rgb, ...colors];
        } else {
            const hi_rgb = this.scaleRgb(rgb, 0.2);
            const lo_rgb = this.scaleRgb(rgb, -0.3);
            return this.interpolateColors(hi_rgb, lo_rgb, num);
        }
    }

    drawBar(x1, x2, y1, y2, colorArr, isThick = false) {
        // Enforce a minimum 1 pixel width
        if (x2 <= x1) x2 = x1 + 1;
        
        if (isThick) {
            const height = y2 - y1 + 1;
            
            // Fill an opaque base block identically matching the base color before drawing the gradient stripes.
            // This natively prevents any sub-pixel floating point antialiasing seams bleeding the background.
            this.ctx.fillStyle = `rgb(${colorArr.join(',')})`;
            this.ctx.fillRect(x1, y1, x2 - x1, height);
            
            const barColors = this.getBarColors(colorArr, height);
            for (let i = 0; i < barColors.length; i++) {
                this.ctx.fillStyle = `rgb(${barColors[i].join(',')})`;
                this.ctx.fillRect(x1, y1 + i, x2 - x1, 1);
            }
        } else {
            this.ctx.fillStyle = `rgb(${colorArr.join(',')})`;
            this.ctx.fillRect(x1, y1, x2 - x1, y2 - y1 + 1);
        }
    }

    getTimeScaleInterval(maxMs, targetCount) {
        const targetInterval = maxMs / targetCount;
        let interval = targetInterval;
        let diff = targetCount;
        const magnitude = Math.pow(10, Math.floor(Math.log10(targetInterval)));
        const significands = [1, 2, 5, 10];
        
        for (const significand of significands) {
            const inf = significand * magnitude;
            const d = Math.abs(targetCount - (maxMs / inf));
            if (d <= diff) {
                interval = inf;
                diff = d;
            }
        }
        return interval;
    }

    getTimeScaleLabel(ms, interval) {
        let places = 2;
        if (interval >= 1000) places = 0;
        else if (interval >= 100) places = 1;
        
        let val = ms / 1000.0;
        
        if (places === 0) return Math.round(val).toString();
        else return val.toFixed(places);
    }

    drawLegend(dimensions) {
        const legendItems = [
            { label: 'Wait', color: [255, 254, 214], narrow: true },
            { label: 'DNS', color: [0, 123, 132], narrow: true },
            { label: 'Connect', color: [255, 123, 0], narrow: true },
            { label: 'SSL', color: [207, 37, 223], narrow: true },
            { label: 'HTML', color: [130, 181, 252], narrow: false },
            { label: 'JS', color: [254, 197, 132], narrow: false },
            { label: 'CSS', color: [178, 234, 148], narrow: false },
            { label: 'Image', color: [196, 154, 232], narrow: false },
            { label: 'Flash', color: [45, 183, 193], narrow: false },
            { label: 'Font', color: [255, 82, 62], narrow: false },
            { label: 'Video', color: [33, 194, 162], narrow: false },
            { label: 'Other', color: [196, 196, 196], narrow: false }
        ];

        this.ctx.font = '11px sans-serif';
        this.ctx.textAlign = 'left';
        
        let startX = dimensions.labelsWidth + 10;
        const legendY = 15;
        const boxSize = 12;

        for (const item of legendItems) {
            const h = item.narrow ? 6 : boxSize;
            const yOff = item.narrow ? 3 : 0;
            
            this.ctx.fillStyle = `rgb(${item.color.join(',')})`;
            this.ctx.fillRect(startX, legendY + yOff, boxSize, h);
            this.ctx.strokeStyle = '#000';
            this.ctx.strokeRect(startX, legendY + yOff, boxSize, h);

            this.ctx.fillStyle = '#000';
            this.ctx.fillText(item.label, startX + boxSize + 6, legendY + 10);
            startX += boxSize + this.ctx.measureText(item.label).width + 16;
        }
    }

    render(rows, dimensions, rawEntries, pageEvents = {}) {
        requestAnimationFrame(() => {
            const dpr = window.devicePixelRatio || 1;
            this.canvas.style.width = dimensions.canvasWidth + 'px';
            this.canvas.style.height = dimensions.canvasHeight + 'px';
            this.canvas.width = dimensions.canvasWidth * dpr;
            this.canvas.height = dimensions.canvasHeight * dpr;
            
            this.ctx.scale(dpr, dpr);

            // 1. Clear background
            this.ctx.fillStyle = "#ffffff";
            this.ctx.fillRect(0, 0, dimensions.canvasWidth, dimensions.canvasHeight);

            // 2. Draw row backgrounds
            rows.forEach((row, index) => {
                if (index % 2 === 1) {
                    this.ctx.fillStyle = "#f0f0f0";
                    this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, row.y2 - row.y1 + 1);
                }
                if (row.status >= 400 || row.status === 0) {
                    this.ctx.fillStyle = `rgba(${row.colors.error.join(',')}, 0.2)`;
                    this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, row.y2 - row.y1 + 1);
                }
            });

            const baseStartMs = rows.length > 0 ? rows.reduce((min, row) => Math.min(min, row.start), Number.MAX_SAFE_INTEGER) : 0;
            const topOffset = rows.length > 0 && rows[0].y1 > 35 ? 35 : 0;
            const rowHeight = 18;
            
            // Determine primary document URL to identify cross-document iframes natively
            let mainDocUrl = '';
            if (rawEntries && rawEntries.length > 0 && rawEntries[0]) {
                const rawEntry = rawEntries[0];
                const docUrl = rawEntry._documentURL || rawEntry.request?.url || '';
                mainDocUrl = docUrl.split('?')[0].split('#')[0];
            }
            
            // 3. Frame Borders and Dividers
            this.ctx.strokeStyle = '#000000';
            this.ctx.beginPath();
            this.ctx.rect(0, topOffset, dimensions.canvasWidth - 1, dimensions.canvasHeight - topOffset - 1);
            
            const divX = Math.floor(dimensions.labelsWidth) + 0.5;
            this.ctx.moveTo(divX, topOffset);
            this.ctx.lineTo(divX, dimensions.canvasHeight - 1);
            this.ctx.stroke();

            // 4. Time Grid lines
            const targetCount = (dimensions.canvasWidth - dimensions.labelsWidth) / 40.0;
            const intervalMs = this.getTimeScaleInterval(dimensions.maxTime, targetCount);
            const xScaler = (ms) => Math.floor(dimensions.labelsWidth + (ms * dimensions.widthPerMs));
            
            const gridY1 = topOffset + rowHeight + 1;
            const gridY2 = dimensions.canvasHeight - rowHeight;

            this.ctx.strokeStyle = 'rgb(192,192,192)';
            this.ctx.beginPath();
            
            for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                const x = Math.floor(xScaler(t)) + 0.5;
                this.ctx.moveTo(x, gridY1);
                this.ctx.lineTo(x, gridY2);
            }
            this.ctx.stroke();

            this.ctx.fillStyle = '#000';
            this.ctx.font = '11px sans-serif';
            this.ctx.textAlign = 'center';

            for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                const x = Math.floor(xScaler(t)) + 0.5;
                const labelText = this.getTimeScaleLabel(t, intervalMs) + 's';
                this.ctx.fillText(labelText, x, topOffset + 14);
                this.ctx.fillText(labelText, x, dimensions.canvasHeight - rowHeight + 13);
            }

            // 5. Page Event Lines (DOM loaded, LCP, Start Render)
            const eventColors = {
                'render': [40, 188, 0],
                'lcp': [0, 128, 0],
                'dom_element': [242, 131, 0],
                'load': [0, 0, 255],
                'nav_load': [192, 192, 255],
                'nav_dom': [216, 136, 223],
                'fcp': [57, 230, 0],
                'nav_dom_interactive': [255, 198, 26],
                'aft': [255, 0, 0]
            };
            
            Object.keys(pageEvents).forEach(eventName => {
                const eventVal = pageEvents[eventName];
                if (eventColors[eventName] && eventVal) {
                    if (Array.isArray(eventVal)) {
                        const startMs = eventVal[0];
                        const endMs = eventVal[1];
                        if (endMs > 0) {
                            const x1 = Math.floor(xScaler(startMs));
                            let x2 = Math.floor(xScaler(endMs));
                            if (x1 === x2) x2 = x1 + 1; // Mimic WPT PHP forcing minimum 1px bounds increment
                            
                            this.ctx.fillStyle = `rgb(${eventColors[eventName].join(',')})`;
                            // Note: PHP imagefilledrectangle bounds are inclusive (width = x2 - x1 + 1)
                            this.ctx.fillRect(x1, topOffset + rowHeight + 1, (x2 - x1) + 1, dimensions.canvasHeight - topOffset - rowHeight - 2);
                        }
                    } else if (eventVal > 0) {
                        const x = Math.floor(xScaler(eventVal)) + 0.5;
                        this.ctx.strokeStyle = `rgb(${eventColors[eventName].join(',')})`;
                        this.ctx.lineWidth = 2; // WPT draws exactly 2px metric indicator lines 
                        this.ctx.beginPath();
                        if (eventName === 'lcp') this.ctx.setLineDash([5, 5]);
                        else this.ctx.setLineDash([]);
                        this.ctx.moveTo(x, topOffset + rowHeight + 1);
                        this.ctx.lineTo(x, dimensions.canvasHeight - 1);
                        this.ctx.stroke();
                        this.ctx.lineWidth = 1;
                        this.ctx.setLineDash([]);
                    }
                }
            });

            // 6. Draw Requests
            this.ctx.textAlign = 'left';

            rows.forEach((row, index) => {
                let sWait = xScaler(row.start - baseStartMs);
                let sDns = xScaler(row.dnsStart - baseStartMs);
                let sDnsEnd = xScaler(row.dnsEnd - baseStartMs);
                let sConn = xScaler(row.connectStart - baseStartMs);
                let sConnEnd = xScaler(row.connectEnd - baseStartMs);
                let sSsl = xScaler(row.sslStart - baseStartMs);
                let sSslEnd = xScaler(row.sslEnd - baseStartMs);
                let sTtfb = xScaler(row.ttfbStart - baseStartMs);
                let sTtfbEnd = xScaler(row.ttfbEnd - baseStartMs);
                let sDownload = xScaler(row.downloadStart - baseStartMs);
                let eDownload = xScaler(Math.max(row.end, row.downloadEnd) - baseStartMs);

                const rawEntry = rawEntries[index];
                if (rawEntry) {
                    if (rawEntry._created !== undefined) sWait = xScaler(rawEntry._created);
                    if (rawEntry._dns_start !== undefined) sDns = xScaler(rawEntry._dns_start);
                    if (rawEntry._dns_end !== undefined) sDnsEnd = xScaler(rawEntry._dns_end);
                    if (rawEntry._connect_start !== undefined) sConn = xScaler(rawEntry._connect_start);
                    if (rawEntry._connect_end !== undefined) sConnEnd = xScaler(rawEntry._connect_end);
                    if (rawEntry._ssl_start !== undefined) sSsl = xScaler(rawEntry._ssl_start);
                    if (rawEntry._ssl_end !== undefined) sSslEnd = xScaler(rawEntry._ssl_end);
                    if (rawEntry._ttfb_start !== undefined) sTtfb = xScaler(rawEntry._ttfb_start);
                    if (rawEntry._ttfb_end !== undefined) sTtfbEnd = xScaler(rawEntry._ttfb_end);
                    if (rawEntry._download_start !== undefined) sDownload = xScaler(rawEntry._download_start);
                    if (rawEntry._download_end !== undefined) eDownload = xScaler(rawEntry._download_end);
                    else if (rawEntry._all_end !== undefined) eDownload = xScaler(rawEntry._all_end);
                }
                
                const barHeight = row.y2 - row.y1 + 1;
                const stateHeight = Math.max(2, Math.floor(barHeight / 2));
                const stateY1 = row.y1 + Math.floor((barHeight - stateHeight) / 2);
                const stateY2 = stateY1 + stateHeight - 1;
                
                const barY1 = row.y1 + 1;
                const barY2 = row.y2 - 1;
                
                // State lines (wait -> dns -> connect -> ssl)
                if (sWait < sTtfb) this.drawBar(sWait, sTtfb, stateY1, stateY2, row.colors.wait, true);
                if (sDns < sDnsEnd) this.drawBar(sDns, sDnsEnd, stateY1, stateY2, row.colors.dns, true);
                if (sConn < sConnEnd) this.drawBar(sConn, sConnEnd, stateY1, stateY2, row.colors.connect, true);
                if (sSsl < sSslEnd) this.drawBar(sSsl, sSslEnd, stateY1, stateY2, row.colors.ssl, true);
                
                // Request bodies
                if (rawEntry && rawEntry._chunks && rawEntry._chunks.length > 0) {
                    // WPT logic: draw TTFB gradient across entire download range if chunks are detailed
                    // To do this mathematically, we trace the full bounds of the request by anchoring `bgStart` safely...
                    let bgStart = sTtfb;
                    if (rawEntry._ttfb_start !== undefined) bgStart = xScaler(rawEntry._ttfb_start);
                    else if (rawEntry._download_start !== undefined) bgStart = xScaler(rawEntry._download_start);
                    
                    // ...and dynamically extending `bgEndMs` outwards. We deliberately process the boundaries natively
                    // entirely as `ms` relative integers ensuring math operators aren't comparing scaled Canvas dimensions to raw timestamp ms.
                    let bgEndMs = Math.max(row.end, row.downloadEnd) - baseStartMs;
                    if (rawEntry._download_end !== undefined) bgEndMs = rawEntry._download_end;
                    else if (rawEntry._all_end !== undefined) bgEndMs = rawEntry._all_end;
                    
                    // Crucially, expand `bgEndMs` to encompass `_ttfb_end` just natively if it lingers past typical download conclusions.
                    if (rawEntry._ttfb_end !== undefined && rawEntry._ttfb_end > bgEndMs) bgEndMs = rawEntry._ttfb_end;
                    
                    // Finally serialize the verified boundary into geometric pixel X-coordinates and draw the entire backing.
                    const bgEnd = xScaler(bgEndMs);
                    this.drawBar(bgStart, Math.max(bgStart + 1, bgEnd), barY1, barY2, row.colors.ttfb, true);
                    
                    let minMs = 0;
                    if (rawEntry._download_start !== undefined) minMs = rawEntry._download_start;
                    else if (rawEntry._ttfb_end !== undefined) minMs = rawEntry._ttfb_end;
                    else if (rawEntry._ttfb_start !== undefined) minMs = rawEntry._ttfb_start;
                    else minMs = row.downloadStart - baseStartMs;
                    
                    // Overlay chunks
                    rawEntry._chunks.forEach(chunk => {
                        if (chunk.ts !== undefined) {
                            let startMs = chunk.ts;
                            let maxBw = dimensions.maxBw || 0;
                            
                            if (maxBw > 0 && chunk.bytes !== undefined) {
                                const chunkTime = chunk.bytes / (maxBw / 8.0);
                                if (chunkTime > 0) {
                                    startMs -= chunkTime;
                                }
                            }
                            
                            startMs = Math.max(minMs, startMs);
                            
                            const chunkStartX = xScaler(startMs);
                            const chunkEndX = xScaler(chunk.ts);
                            
                            this.drawBar(chunkStartX, chunkEndX, barY1, barY2, row.colors.download, true);
                        }
                    });
                } else {
                    if (sTtfb < sTtfbEnd) {
                        this.drawBar(sTtfb, sTtfbEnd, barY1, barY2, row.colors.ttfb, true);
                    } else if (sTtfb === sTtfbEnd && sTtfb < sDownload) {
                        this.drawBar(sTtfb, sDownload, barY1, barY2, row.colors.ttfb, true);
                    }
                    
                    if (sDownload < eDownload) {
                        this.drawBar(sDownload, eDownload, barY1, barY2, row.colors.download, true);
                    }
                }
                
                // 7. Request timing label
                let labelStr = Math.round(row.time) + ' ms';
                if (row.status >= 300 || row.status < 0) {
                    labelStr += ` (${row.status})`;
                } else if (row.status === 0) {
                    labelStr += ' (request canceled)';
                }
                
                this.ctx.font = '11px sans-serif';
                const metrics = this.ctx.measureText(labelStr);
                const labelWidth = metrics.width;
                
                let labelX = eDownload + 5;
                if (labelX + labelWidth > dimensions.canvasWidth) {
                    labelX = sWait - 5 - labelWidth;
                }
                
                if (labelX >= dimensions.labelsWidth) {
                    // Opaque background layer perfectly blocking vertical grid lines
                    this.ctx.fillStyle = index % 2 === 1 ? "#f0f0f0" : "#ffffff";
                    const rectHeight = row.y2 - row.y1 + 1;
                    this.ctx.fillRect(labelX - 1, row.y1, labelWidth + 2, rectHeight);
                    
                    if (row.status >= 400 || row.status === 0) {
                        this.ctx.fillStyle = `rgba(${row.colors.error.join(',')}, 0.2)`;
                        this.ctx.fillRect(labelX - 1, row.y1, labelWidth + 2, rectHeight);
                    }
                    
                    this.ctx.fillStyle = '#000';
                    this.ctx.fillText(labelStr, labelX, row.y1 + 13);
                }

                // JS Execution
                if (rawEntry && rawEntry._js_timing && rawEntry._js_timing.length > 0) {
                    const jsHeight = Math.max(2, Math.floor(barHeight * 0.5));
                    const jsY1 = row.y1 + Math.floor((barHeight - jsHeight) / 2);
                    const jsY2 = jsY1 + jsHeight - 1;

                    rawEntry._js_timing.forEach(times => {
                        const startX = xScaler(times[0]);
                        const endX = xScaler(times[1]);
                        this.drawBar(startX, endX, jsY1, jsY2, row.colors.js, false);
                    });
                }

                // URL Text Label
                let textColor = '#000';
                if (rawEntry && rawEntry._documentURL) {
                    const reqDocUrl = rawEntry._documentURL.split('?')[0].split('#')[0];
                    if (reqDocUrl && mainDocUrl && reqDocUrl !== mainDocUrl) {
                        textColor = '#0000ff'; // Blue for distinct document contexts
                    }
                }
                
                let textX = 10;
                
                // Draw Render Blocking Indicator
                if (rawEntry && rawEntry._renderBlocking === 'blocking') {
                    const iconY = row.y1 + 2;
                    const iconW = 14;
                    
                    // Orange warning circle
                    this.ctx.fillStyle = '#ff9900';
                    this.ctx.beginPath();
                    this.ctx.arc(textX + iconW / 2, iconY + iconW / 2, iconW / 2, 0, 2 * Math.PI);
                    this.ctx.fill();
                    
                    // White X cross lines
                    this.ctx.strokeStyle = '#ffffff';
                    this.ctx.lineWidth = 1.5;
                    this.ctx.beginPath();
                    this.ctx.moveTo(textX + 4, iconY + 4);
                    this.ctx.lineTo(textX + iconW - 4, iconY + iconW - 4);
                    this.ctx.moveTo(textX + iconW - 4, iconY + 4);
                    this.ctx.lineTo(textX + 4, iconY + iconW - 4);
                    this.ctx.stroke();
                    this.ctx.lineWidth = 1;

                    textX += iconW + 4;
                }

                this.ctx.fillStyle = textColor;
                const labelText = `${index + 1}. ${row.url || ''}`;
                this.ctx.fillText(labelText, textX, row.y2 - 2);
            });

            // 7. Legend
            if (rows.length > 0 && rows[0].y1 > 30) {
                this.drawLegend(dimensions);
            }
        });
    }
}
