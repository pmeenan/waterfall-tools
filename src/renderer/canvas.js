// src/renderer/canvas.js

import { Layout } from './layout.js';

export class WaterfallCanvas {
    constructor(parentContainer, options = {}) {
        this.container = typeof parentContainer === 'string' ? document.getElementById(parentContainer) : parentContainer;
        this.options = Object.assign({
            minWidth: 800,
            showLegend: true
        }, options);
        
        this.rawEntries = [];
        this.pageObj = null;
        this.pendingRender = null;
        this.drawnRows = null;
        this.lastHoveredIndex = null;
        
        if (this.container) {
            // Remove existing canvas children natively if reloading dynamically
            while(this.container.firstChild) {
                this.container.removeChild(this.container.firstChild);
            }

            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d', { alpha: false }); // Opaque for speed
            
            this._bindEvents();
            
            this.resizeObserver = new ResizeObserver(() => {
                this._requestRender();
            });
            this.resizeObserver.observe(this.container);
        } else if (this.options.canvas) {
            this.canvas = this.options.canvas;
            this.ctx = this.canvas.getContext('2d', { alpha: false });
        }
    }
    
    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    _bindEvents() {
        this.canvas.addEventListener('mousemove', (e) => {
            const target = this._getInteractionTarget(e.offsetX, e.offsetY);
            let hoverChanged = false;
            
            if (target) {
                if (this.lastHoveredIndex !== target.index) {
                    this.lastHoveredIndex = target.index;
                    hoverChanged = true;
                } else if (typeof this.options.onHover === 'function') {
                    // Update location smoothly while inside the row!
                    this.options.onHover({ index: target.index, request: this.rawEntries[target.index], event: e });
                }
            } else {
                if (this.lastHoveredIndex !== null) {
                    this.lastHoveredIndex = null;
                    hoverChanged = true;
                }
            }
            
            if (hoverChanged && typeof this.options.onHover === 'function') {
                this.options.onHover(target ? { index: target.index, request: this.rawEntries[target.index], event: e } : null);
            }
        });

        this.canvas.addEventListener('mouseleave', (e) => {
            if (this.lastHoveredIndex !== null) {
                this.lastHoveredIndex = null;
                if (typeof this.options.onHover === 'function') {
                    this.options.onHover(null);
                }
            }
        });

        this.canvas.addEventListener('click', (e) => {
            if (typeof this.options.onClick === 'function') {
                const target = this._getInteractionTarget(e.offsetX, e.offsetY);
                this.options.onClick(target ? { index: target.index, request: this.rawEntries[target.index], event: e } : null);
            }
        });

        this.canvas.addEventListener('dblclick', (e) => {
            if (typeof this.options.onDoubleClick === 'function') {
                const target = this._getInteractionTarget(e.offsetX, e.offsetY);
                this.options.onDoubleClick(target ? { index: target.index, request: this.rawEntries[target.index], event: e } : null);
            }
        });
    }

    _getInteractionTarget(x, y) {
        if (!this.drawnRows || !this.drawnRows.rows || this.drawnRows.rows.length === 0) return null;

        const dim = this.drawnRows.dimensions;
        const rowHeight = this.options.thumbnailView ? 4 : 18;
        const topOffset = this.drawnRows.rows[0].y1 > 35 ? 35 : 0;
        const bottomY = dim.totalRows * rowHeight + rowHeight + topOffset;
        
        if (y < topOffset + rowHeight || y > bottomY) return null;

        const baseStartMs = dim.baseMs || (this.drawnRows.rows.length > 0 ? this.drawnRows.rows[0].start : 0);
        const xScaler = (ms) => Math.floor(dim.labelsWidth + (ms * dim.widthPerMs));

        let hitRow = null;

        // Iterate backwards to hit the topmost visual layer securely natively resolving overlapping coordinates
        for (let i = this.drawnRows.rows.length - 1; i >= 0; i--) {
            const row = this.drawnRows.rows[i];
            
            if (y >= row.y1 && y <= row.y2) {
                if (!this.options.connectionView) {
                    // Waterfall view: entire row stripe (label + empty space + bars) interacts uniformly
                    hitRow = row;
                    break;
                } else {
                    // Connection view: Constrain mapped hits physically bridging absolute drawing coordinates resolving empty grid offsets organically
                    const minMs = Math.min(row.start || Number.MAX_SAFE_INTEGER, row.dnsStart || Number.MAX_SAFE_INTEGER, row.connectStart || Number.MAX_SAFE_INTEGER, row.sslStart || Number.MAX_SAFE_INTEGER, row.ttfbStart || Number.MAX_SAFE_INTEGER, row.downloadStart || Number.MAX_SAFE_INTEGER);
                    const maxMs = Math.max(row.end || 0, row.dnsEnd || 0, row.connectEnd || 0, row.sslEnd || 0, row.ttfbEnd || 0, row.downloadEnd || 0);

                    let barStartX = xScaler(minMs - baseStartMs) - 3; // padding for thin rects mapping safely
                    let barEndX = xScaler(maxMs - baseStartMs) + 3;

                    // Labels represent full origins in connection view; explicitly prevent interactive states there
                    let isBarHit = (x >= barStartX && x <= barEndX);

                    if (isBarHit) {
                        hitRow = row;
                        break;
                    }
                }
            }
        }
        
        return hitRow || null;
    }

    render(pageData) {
        this.pageData = pageData;
        
        // Ensure an iterable array of requests natively matching legacy structures internally purely for the render phase
        this.rawEntries = [];
        if (pageData && pageData.requests) {
            this.rawEntries = Object.values(pageData.requests);
            const getSortEpoch = (req) => {
                let hasAbsoluteTimings = req._load_start !== undefined || req._start !== undefined || req._dns_start !== undefined || req._ttfb_start !== undefined;
                if (hasAbsoluteTimings) {
                    let baseEpoch = 0; // Relative sorting
                    let startOrigin = req._load_start !== undefined ? req._load_start : (req._start !== undefined ? req._start : undefined);
                    let blockedEnd = baseEpoch + (startOrigin !== undefined ? startOrigin : (req._ttfb_start !== undefined ? req._ttfb_start : 0));
                    let dnsStart = (req._dns_start !== undefined && req._dns_start >= 0) ? baseEpoch + req._dns_start : blockedEnd;
                    let dnsEnd = (req._dns_end !== undefined && req._dns_end >= 0) ? baseEpoch + req._dns_end : dnsStart;
                    let connectStart = (req._connect_start !== undefined && req._connect_start >= 0) ? baseEpoch + req._connect_start : dnsEnd;
                    let connectEnd = (req._connect_end !== undefined && req._connect_end >= 0) ? baseEpoch + req._connect_end : connectStart;
                    let sslStart = (req._ssl_start !== undefined && req._ssl_start >= 0) ? baseEpoch + req._ssl_start : connectEnd;
                    let sslEnd = (req._ssl_end !== undefined && req._ssl_end >= 0) ? baseEpoch + req._ssl_end : sslStart;
                    let requestStart = baseEpoch + (startOrigin !== undefined ? startOrigin : (req._ttfb_start !== undefined ? req._ttfb_start : (sslEnd - baseEpoch)));
                    return Math.max(requestStart, connectEnd);
                }
                
                let delay = 0;
                if (req.timings) {
                    if (req.timings.blocked > 0) delay += req.timings.blocked;
                    if (req.timings.dns > 0) delay += req.timings.dns;
                    if (req.timings.connect > 0) delay += req.timings.connect;
                    if (req.timings.send > 0) delay += req.timings.send;
                }
                return req.time_start + delay;
            };

            // Enforce visually correct chronology blocking multiplexed socket dependencies visually seamlessly
            this.rawEntries.sort((a, b) => getSortEpoch(a) - getSortEpoch(b));
        }
        
        this._requestRender();
    }
    
    _requestRender() {
        if (this.pendingRender) {
            if (typeof cancelAnimationFrame !== 'undefined') {
                cancelAnimationFrame(this.pendingRender);
            } else {
                clearTimeout(this.pendingRender);
            }
        }
        
        const renderLogic = () => {
            if (!this.rawEntries || this.rawEntries.length === 0) return;
            
            const clientWidth = this.container ? this.container.clientWidth : (this.options.width || 800);
            const minW = this.options.thumbnailView ? 0 : this.options.minWidth;
            const canvasWidth = Math.max(minW, clientWidth);
            
            const layoutOptions = Object.assign({}, this.options, { page: this.pageData });
            this.drawnRows = Layout.calculateRows(this.rawEntries, canvasWidth, layoutOptions);
            
            this.draw(this.drawnRows.rows, this.drawnRows.dimensions, this.drawnRows.pageEvents);
        };
        
        if (typeof requestAnimationFrame !== 'undefined') {
            this.pendingRender = requestAnimationFrame(renderLogic);
        } else if (typeof setTimeout !== 'undefined') {
            this.pendingRender = setTimeout(renderLogic, 0);
        } else {
            // Synchronous fallback natively if env supports neither completely
            renderLogic();
        }
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

        for (const item of legendItems) {
            const h = item.narrow ? 8 : 14;
            const yOff = item.narrow ? 3 : 0;
            const itemBoxSize = item.narrow ? 14 : 20;
            
            if (item.narrow) {
                this.drawBar(startX, startX + itemBoxSize, legendY + yOff, legendY + yOff + h - 1, item.color, true);
            } else {
                const ttfbColor = this.scaleRgb(item.color, 0.65);
                this.drawBar(startX, startX + itemBoxSize / 2, legendY, legendY + h - 1, ttfbColor, true);
                this.drawBar(startX + itemBoxSize / 2, startX + itemBoxSize, legendY, legendY + h - 1, item.color, true);
            }

            this.ctx.fillStyle = '#000';
            this.ctx.fillText(item.label, startX + itemBoxSize + 6, legendY + 11);
            startX += itemBoxSize + this.ctx.measureText(item.label).width + 16;
        }
    }

    draw(rows, dimensions, pageEvents = {}) {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        if (this.canvas.style) {
            this.canvas.style.width = dimensions.canvasWidth + 'px';
            this.canvas.style.height = dimensions.canvasHeight + 'px';
        }
        this.canvas.width = dimensions.canvasWidth * dpr;
        this.canvas.height = dimensions.canvasHeight * dpr;
        
        this.ctx.scale(dpr, dpr);

        // 1. Clear background
        this.ctx.fillStyle = "#ffffff";
        this.ctx.fillRect(0, 0, dimensions.canvasWidth, dimensions.canvasHeight);

            // Inherit structured relational time base preventing timeline disconnects intrinsically
            const baseStartMs = dimensions.baseMs || (rows.length > 0 ? rows[0].start : 0);
            const topOffset = rows.length > 0 && rows[0].y1 > 35 ? 35 : 0;
            const rowHeight = this.options.thumbnailView ? 4 : 18;

            // 2. Draw row backgrounds
            const drawnYSet = new Set();
            rows.forEach((row) => {
                if (row.isTornEdge) {
                    // Draw Vector Tear Background
                    const yMid = row.y1 + (row.y2 - row.y1) / 2;
                    const tearHeight = this.options.thumbnailView ? 2 : 4;
                    const segments = 45; // high jagged density
                    const segmentWidth = dimensions.canvasWidth / segments;
                    
                    this.ctx.fillStyle = '#fafafa';
                    this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, row.y2 - row.y1 + 1);
                    
                    this.ctx.beginPath();
                    this.ctx.moveTo(0, yMid - tearHeight);
                    
                    for (let s = 1; s <= segments; s++) {
                        const nextX = s * segmentWidth;
                        const nextY = yMid + (s % 2 === 0 ? -tearHeight : tearHeight);
                        this.ctx.lineTo(nextX, nextY);
                    }
                    this.ctx.strokeStyle = '#cccccc';
                    this.ctx.lineWidth = 1;
                    this.ctx.stroke();
                    
                    // add slight shadow underneath
                    this.ctx.beginPath();
                    this.ctx.moveTo(0, yMid - tearHeight + 1);
                    for (let s = 1; s <= segments; s++) {
                        const nextX = s * segmentWidth;
                        const nextY = yMid + (s % 2 === 0 ? -tearHeight : tearHeight) + 1;
                        this.ctx.lineTo(nextX, nextY);
                    }
                    this.ctx.strokeStyle = 'rgba(0,0,0,0.08)';
                    this.ctx.stroke();
                    return;
                }

                if (!drawnYSet.has(row.y1)) {
                    drawnYSet.add(row.y1);
                    const logicalIdx = Math.round((row.y1 - topOffset - rowHeight) / rowHeight);
                    if (logicalIdx % 2 === 1) {
                        this.ctx.fillStyle = "#f0f0f0";
                        this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, rowHeight);
                    }
                }

                if (row.status >= 400 || row.status === 0) {
                    this.ctx.fillStyle = `rgb(${row.colors.error.join(',')})`;
                    this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, row.y2 - row.y1 + 1);
                } else if (row.status >= 300 && row.status < 400 && row.status !== 304) {
                    this.ctx.fillStyle = `rgb(${row.colors.warning.join(',')})`;
                    this.ctx.fillRect(0, row.y1, dimensions.canvasWidth, row.y2 - row.y1 + 1);
                }
            });
            
            // Determine primary document URL to identify cross-document iframes natively
            let mainDocUrl = '';
            if (rows && rows.length > 0 && rows[0]) {
                const docUrl = rows[0].documentURL || rows[0].url || '';
                mainDocUrl = docUrl.split('?')[0].split('#')[0];
            }
            
            // 3. Frame Borders and Dividers
            this.ctx.strokeStyle = this.options.thumbnailView ? 'rgb(192,192,192)' : '#000000';
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
            
            const requestBottomY = dimensions.totalRows * rowHeight + rowHeight + topOffset;
            const gridY1 = topOffset + rowHeight + 1;
            const gridY2 = requestBottomY;

            // Start Clipping for graph visualization rendering
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(dimensions.labelsWidth, 0, dimensions.canvasWidth - dimensions.labelsWidth, dimensions.canvasHeight);
            this.ctx.clip();

            // Safety: if maxTime is 0 or intervalMs is 0, skip grid drawing to prevent infinite loops
            if (dimensions.maxTime > 0 && intervalMs > 0) {
                this.ctx.strokeStyle = this.options.thumbnailView ? 'rgb(208,208,208)' : 'rgb(192,192,192)';
                this.ctx.beginPath();
                
                for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                    const x = Math.floor(xScaler(t)) + 0.5;
                    this.ctx.moveTo(x, gridY1);
                    this.ctx.lineTo(x, gridY2);
                }
                this.ctx.stroke();

            }

            // 5. Standard Page Event Lines (always drawn: DOM loaded, LCP, Start Render, etc.)
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
            
            if (this.options.showPageMetrics !== false) {
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
                                this.ctx.fillRect(x1, topOffset + rowHeight + 1, (x2 - x1) + 1, requestBottomY - topOffset - rowHeight - 1);
                            }
                        } else if (eventVal > 0) {
                            const x = Math.floor(xScaler(eventVal)) + 0.5;
                            this.ctx.strokeStyle = `rgb(${eventColors[eventName].join(',')})`;
                            this.ctx.lineWidth = 2; // WPT draws exactly 2px metric indicator lines 
                            this.ctx.beginPath();
                            if (eventName === 'lcp') this.ctx.setLineDash([5, 5]);
                            else this.ctx.setLineDash([]);
                            this.ctx.moveTo(x, topOffset + rowHeight + 1);
                            this.ctx.lineTo(x, requestBottomY);
                            this.ctx.stroke();
                            this.ctx.lineWidth = 1;
                            this.ctx.setLineDash([]);
                        }
                    }
                });
            }

            // 5.5 User Timing Marks
            if (this.options.showMarks !== false && this.pageData) {
                // WPT uses RGB(105, 0, 158) for user timing marks
                this.ctx.strokeStyle = 'rgb(105, 0, 158)';
                this.ctx.lineWidth = 1;
                
                const drawMarks = (marksObj) => {
                    if (!marksObj) return;
                    Object.keys(marksObj).forEach(markName => {
                        let markTimeMs = marksObj[markName];
                        if (typeof markTimeMs === 'object' && markTimeMs.time) markTimeMs = markTimeMs.time;
                        if (markTimeMs > 0 && markTimeMs <= dimensions.maxTime) {
                            const x = Math.floor(xScaler(markTimeMs)) + 0.5;
                            this.ctx.beginPath();
                            this.ctx.moveTo(x, topOffset + rowHeight + 1);
                            this.ctx.lineTo(x, requestBottomY);
                            this.ctx.stroke();
                        }
                    });
                };
                
                drawMarks(this.pageData._userTimes);
                drawMarks(this.pageData._userTimingMeasures);
                drawMarks(this.pageData._user_timing);
            }

            // 5.8 Time Scale Labels (Rendered last so they draw on top of lines, with opaque backgrounds)
            if (!this.options.thumbnailView && dimensions.maxTime > 0 && intervalMs > 0) {
                let bottomScaleY = dimensions.totalRows * rowHeight + rowHeight + topOffset;

                // Fill opaque white background specifically for the bottom time scale row
                const fillX = Math.floor(dimensions.labelsWidth) + 1;
                const fillW = dimensions.canvasWidth - fillX - 1;
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(fillX, bottomScaleY, fillW, rowHeight - 1);

                this.ctx.fillStyle = '#000';
                this.ctx.font = `11px sans-serif`;
                this.ctx.textAlign = 'center';

                const timeOffsetMs = this.options.startTime ? this.options.startTime * 1000 : 0;
                const fontYOffset = 14;
                for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                    const x = Math.floor(xScaler(t)) + 0.5;
                    const labelText = this.getTimeScaleLabel(t + timeOffsetMs, intervalMs) + 's';
                    
                    // Top scale label
                    this.ctx.fillText(labelText, x, Math.max(fontYOffset, topOffset + fontYOffset));
                    
                    // Bottom scale label
                    this.ctx.fillText(labelText, x, bottomScaleY + fontYOffset);
                }
            }
            // 6. Draw Requests - Pass 1: State lines and TTFB Backgrounds
            this.ctx.textAlign = 'left';

            rows.forEach((row, index) => {
                if (row.isTornEdge) return;
                
                let sWait = xScaler(row.start - baseStartMs);
                let sDns = xScaler(row.dnsStart - baseStartMs);
                let sDnsEnd = xScaler(row.dnsEnd - baseStartMs);
                let sConn = xScaler(row.connectStart - baseStartMs);
                let sConnEnd = xScaler(row.connectEnd - baseStartMs);
                let sSsl = xScaler(row.sslStart - baseStartMs);
                let sSslEnd = xScaler(row.sslEnd - baseStartMs);
                let sTtfb = xScaler(row.ttfbStart - baseStartMs);
                let sTtfbEnd = xScaler(row.ttfbEnd - baseStartMs);
                
                let drawY1 = row.y1;
                let drawY2 = row.y2;
                
                if (!this.options.thumbnailView) {
                    drawY1 += 1;
                    drawY2 -= 1;
                }
                
                const reqBarHeight = drawY2 - drawY1 + 1;
                const stateHeight = Math.max(2, Math.floor(reqBarHeight / 2));
                const stateY1 = drawY1 + Math.floor((reqBarHeight - stateHeight) / 2);
                const stateY2 = stateY1 + stateHeight - 1;
                
                const barY1 = drawY1;
                const barY2 = Math.max(barY1 + 1, drawY2);
                
                // State lines (wait -> dns -> connect -> ssl)
                if (this.options.showWait !== false && !this.options.connectionView && sWait < sTtfb) this.drawBar(sWait, sTtfb, stateY1, stateY2, row.colors.wait, true);
                if (sDns < sDnsEnd) this.drawBar(sDns, sDnsEnd, stateY1, stateY2, row.colors.dns, true);
                if (sConn < sConnEnd) this.drawBar(sConn, sConnEnd, stateY1, stateY2, row.colors.connect, true);
                if (sSsl < sSslEnd) this.drawBar(sSsl, sSslEnd, stateY1, stateY2, row.colors.ssl, true);
                
                // TTFB block
                let ttfbDrawEnd = sTtfbEnd;
                if (!this.options.connectionView) {
                    ttfbDrawEnd = xScaler(Math.max(row.end, row.downloadEnd) - baseStartMs);
                }
                
                if (sTtfb < ttfbDrawEnd) {
                    this.drawBar(sTtfb, ttfbDrawEnd, barY1, barY2, row.colors.ttfb, true);
                }
            });

            // 6. Draw Requests - Pass 2: Downloads & Overlaps
            const solidDownloadsByRow = new Map();
            rows.forEach((row, index) => {
                if (row.isTornEdge) return;
                const hasBandwidth = dimensions.maxBw && dimensions.maxBw > 0;
                const hasChunks = row.chunks && row.chunks.length > 0;
                // If chunk timings and bandwidth are available, always use them
                const useChunks = hasChunks && (hasBandwidth || this.options.showChunks !== false);
                
                if (!useChunks) {
                    const rowKey = row.y1;
                    if (!solidDownloadsByRow.has(rowKey)) solidDownloadsByRow.set(rowKey, []);
                    
                    let sDownload = xScaler(row.downloadStart - baseStartMs);
                    let eDownload = xScaler(Math.max(row.end, row.downloadEnd) - baseStartMs);
                    
                    if (sDownload < eDownload) {
                        solidDownloadsByRow.get(rowKey).push({ row, sDownload, eDownload, colors: row.colors.download });
                    }
                }
            });

            // Draw solid downloads natively with 3px time-slicing for overlapping streams
            for (const [y1, downloads] of solidDownloadsByRow.entries()) {
                if (downloads.length === 0) continue;
                
                let drawY1 = y1;
                let drawY2 = y1 + rowHeight - 1;
                if (!this.options.thumbnailView) {
                    drawY1 += 1;
                    drawY2 -= 1;
                }
                const barY1 = drawY1;
                const barY2 = Math.max(barY1 + 1, drawY2);
                
                if (downloads.length === 1 || !this.options.connectionView) {
                    downloads.forEach(dl => {
                        this.drawBar(dl.sDownload, dl.eDownload, barY1, barY2, dl.colors, true);
                    });
                    continue;
                }
                
                const minX = Math.floor(Math.min(...downloads.map(dl => dl.sDownload)));
                const maxX = Math.ceil(Math.max(...downloads.map(dl => dl.eDownload)));
                
                // Track drawn bounds mathematically avoiding overlap completely by interleaving
                for (let x = minX; x <= maxX; x += 3) {
                    const active = downloads.filter(dl => (x + 3) > dl.sDownload && x < dl.eDownload);
                    if (active.length > 0) {
                        // Alternate proportionally across active streams
                        const activeIdx = Math.floor(x / 3) % active.length;
                        const dl = active[activeIdx];
                        
                        const drawStartX = Math.max(x, dl.sDownload);
                        const drawEndX = Math.min(x + 3, dl.eDownload);
                        
                        this.drawBar(drawStartX, drawEndX, barY1, barY2, dl.colors, true);
                    }
                }
            }

            // 6. Draw Requests - Pass 3: Chunked Downloads + Labels + JS
            rows.forEach((row, index) => {
                if (row.isTornEdge) return;
                let sWait = xScaler(row.start - baseStartMs);
                let eDownload = xScaler(Math.max(row.end, row.downloadEnd) - baseStartMs);
                
                let drawY1 = row.y1;
                let drawY2 = row.y2;
                if (!this.options.thumbnailView) {
                    drawY1 += 1;
                    drawY2 -= 1;
                }
                const reqBarHeight = drawY2 - drawY1 + 1;
                const barY1 = drawY1;
                const barY2 = Math.max(barY1 + 1, drawY2);
                
                const hasBandwidth = dimensions.maxBw && dimensions.maxBw > 0;
                const hasChunks = row.chunks && row.chunks.length > 0;
                // If chunk timings and bandwidth are available, always use them
                const useChunks = hasChunks && (hasBandwidth || this.options.showChunks !== false);
                
                if (useChunks) {
                    let minMs = row.downloadStart - baseStartMs;
                    let maxBw = dimensions.maxBw || 0;
                    
                    row.chunks.forEach(chunk => {
                        if (chunk.ts !== undefined) {
                            let cTs = chunk.ts;
                            if (cTs > 1000000000000) cTs -= baseStartMs;
                            else cTs -= (this.options.startTime ? this.options.startTime * 1000 : 0);
                            
                            let startMs = cTs;
                            if (maxBw > 0 && chunk.bytes !== undefined) {
                                // dimensions.maxBw represents Kbps organically from WPT inputs
                                const maxBwBps = maxBw * 1000.0;
                                // chunkTime natively calculates seconds correctly derived from Mbps wire limits
                                const chunkTime = (chunk.bytes / (maxBwBps / 8.0)) * 1000.0;
                                if (chunkTime > 0) startMs -= chunkTime;
                            }
                            
                            startMs = Math.max(minMs, startMs);
                            cTs = Math.max(startMs, cTs);
                            
                            const chunkStartX = xScaler(startMs);
                            let chunkEndX = xScaler(cTs);
                            
                            // Emulate legacy 1px fallback if bandwidth implies instantaneous (maxBw == 0 or infinitesimally small rendering gaps)
                            if (chunkEndX - chunkStartX < 1) {
                                chunkEndX = chunkStartX + 1;
                            }
                            
                            this.drawBar(chunkStartX, chunkEndX, barY1, barY2, row.colors.download, true);
                        }
                    });
                }
                
                // 7. Request timing label
                if (!this.options.thumbnailView && !this.options.connectionView) {
                    let labelStr = Math.round(row.time) + ' ms';
                    if (row.status >= 300 || row.status < 0) {
                        labelStr += ` (${row.status})`;
                    } else if (row.status === 0) {
                        labelStr += ' (request canceled)';
                    }
                    
                    this.ctx.font = `11px sans-serif`;
                    const metrics = this.ctx.measureText(labelStr);
                    const labelWidth = metrics.width;
                    
                    let labelX = eDownload + 5;
                    if (labelX + labelWidth > dimensions.canvasWidth) {
                        labelX = sWait - 5 - labelWidth;
                    }
                    
                    if (labelX >= dimensions.labelsWidth) {
                        const rectHeight = row.y2 - row.y1 + 1;
                        if (row.status >= 400 || row.status === 0) {
                            this.ctx.fillStyle = `rgb(${row.colors.error.join(',')})`;
                            this.ctx.fillRect(labelX - 1, row.y1, labelWidth + 2, rectHeight);
                        } else if (row.status >= 300 && row.status < 400 && row.status !== 304) {
                            this.ctx.fillStyle = `rgb(${row.colors.warning.join(',')})`;
                            this.ctx.fillRect(labelX - 1, row.y1, labelWidth + 2, rectHeight);
                        } else {
                            const rIdx = Math.round((row.y1 - topOffset - rowHeight) / rowHeight);
                            this.ctx.fillStyle = rIdx % 2 === 1 ? "#f0f0f0" : "#ffffff";
                            this.ctx.fillRect(labelX - 1, row.y1, labelWidth + 2, rectHeight);
                        }
                        
                        this.ctx.fillStyle = '#000';
                        this.ctx.fillText(labelStr, labelX, row.y1 + 13);
                    }
                }

                // JS Execution
                if (this.options.showJsTiming !== false && !this.options.connectionView && row.jsTiming && row.jsTiming.length > 0) {
                    const jsHeight = Math.max(2, Math.floor(reqBarHeight * 0.5));
                    const jsY1 = drawY1 + Math.floor((reqBarHeight - jsHeight) / 2);
                    const jsY2 = jsY1 + jsHeight - 1;

                    row.jsTiming.forEach(times => {
                        const startX = xScaler(times[0]);
                        const endX = xScaler(times[1]);
                        this.drawBar(startX, endX, jsY1, jsY2, row.colors.js, false);
                    });
                }
            });

            // 7. Legend
            if (rows.length > 0 && rows[0].y1 > 30 && this.options.showLegend !== false && !this.options.thumbnailView) {
                this.drawLegend(dimensions);
            }

            // 8. Advanced Metrics Graphs (CPU, BW, Main Thread, Long Tasks)
            let chartYOffset = dimensions.totalRows * rowHeight + (rowHeight * 2) + topOffset;

            const page = this.pageData;
            if (page) {
                const drawChartFrame = (title, y, h, colorLine, line2Title, line2Color, showBands = true, showGrid = true) => {
                    this.ctx.restore(); // Briefly suspend clipping
                    
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.fillRect(dimensions.labelsWidth, y, dimensions.canvasWidth - dimensions.labelsWidth, h);
                    
                    if (showBands !== false) {
                        this.ctx.fillStyle = '#f0f0f0';
                        const bandH = (h - 2) / 4;
                        this.ctx.fillRect(dimensions.labelsWidth, y + 1, dimensions.canvasWidth - dimensions.labelsWidth, bandH);
                        this.ctx.fillRect(dimensions.labelsWidth, y + 1 + bandH * 2, dimensions.canvasWidth - dimensions.labelsWidth, bandH);
                    }

                    this.ctx.lineWidth = 1;
                    this.ctx.strokeStyle = this.options.thumbnailView ? 'rgb(192,192,192)' : '#000000';
                    this.ctx.strokeRect(dimensions.labelsWidth + 0.5, y + 0.5, dimensions.canvasWidth - dimensions.labelsWidth - 1, h - 1);
                    
                    
                    if (showGrid !== false && dimensions.maxTime > 0 && typeof intervalMs !== 'undefined' && typeof xScaler !== 'undefined') {
                        this.ctx.strokeStyle = this.options.thumbnailView ? 'rgb(208,208,208)' : 'rgb(192,192,192)';
                        this.ctx.beginPath();
                        for (let t = intervalMs; t <= dimensions.maxTime; t += intervalMs) {
                            const x = Math.floor(xScaler(t)) + 0.5;
                            if (x > dimensions.labelsWidth) {
                                this.ctx.moveTo(x, y);
                                this.ctx.lineTo(x, y + h);
                            }
                        }
                        this.ctx.stroke();
                        this.ctx.strokeStyle = '#000000'; // reset
                    }
                    
                    if (dimensions.labelsWidth > 0) {
                        if (title) {
                            this.ctx.fillStyle = '#333';
                            const fontSize = this.options.thumbnailView ? 6 : 11;
                            this.ctx.font = `${fontSize}px sans-serif`;
                            this.ctx.textAlign = 'right';
                            this.ctx.fillText(title, dimensions.labelsWidth - 10, y + (h / 2));
                            
                            if (colorLine) {
                                this.ctx.beginPath();
                                this.ctx.strokeStyle = colorLine;
                                this.ctx.lineWidth = 2;
                                const textWidth = this.ctx.measureText(title).width;
                                const lineEx = dimensions.labelsWidth - 10 - textWidth - 5;
                                const lineSx = Math.max(10, lineEx - 25);
                                this.ctx.moveTo(lineSx, y + (h / 2) - 4);
                                this.ctx.lineTo(lineEx, y + (h / 2) - 4);
                                this.ctx.stroke();
                            }
                        }

                        if (line2Title && line2Color) {
                            this.ctx.fillStyle = '#333';
                            const fontSize = this.options.thumbnailView ? 6 : 11;
                            this.ctx.font = `${fontSize}px sans-serif`;
                            this.ctx.textAlign = 'right';
                            this.ctx.fillText(line2Title, dimensions.labelsWidth - 10, y + (h / 2) + 12);
                            this.ctx.beginPath();
                            this.ctx.strokeStyle = line2Color;
                            this.ctx.lineWidth = 2;
                            const textWidth = this.ctx.measureText(line2Title).width;
                            const lineEx = dimensions.labelsWidth - 10 - textWidth - 5;
                            const lineSx = Math.max(10, lineEx - 25);
                            this.ctx.moveTo(lineSx, y + (h / 2) + 8);
                            this.ctx.lineTo(lineEx, y + (h / 2) + 8);
                            this.ctx.stroke();
                        }
                    }
                    
                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.rect(dimensions.labelsWidth, 0, dimensions.canvasWidth - dimensions.labelsWidth, dimensions.canvasHeight);
                    this.ctx.clip();
                };

                const hasCpu = this.options.showCpu && page._utilization && page._utilization.cpu;
                const hasBw = this.options.showBw && page._utilization && page._utilization.bw;

                // Draw CPU & BW Combined Loop
                if (hasCpu || hasBw) {
                    const blockHeight = this.options.thumbnailView ? 16 : 50;
                    const cpuColor = 'rgb(255, 153, 0)'; // Orange
                    const bwColor = 'rgb(0, 128, 0)'; // Dark Green
                    
                    const cpuTitle = (hasCpu && !this.options.thumbnailView) ? 'CPU Utilization (%)' : null;
                    const cpuLineColor = hasCpu ? cpuColor : null;
                    
                    let bwTitle = null;
                    if (hasBw && !this.options.thumbnailView) {
                        let maxBw = page._utilization.bwMax || (Array.isArray(page._utilization.bw) && page._utilization.bw.max) ? (page._utilization.bwMax || page._utilization.bw.max) : (page._bwDown || 0);

                        if (maxBw > 0) {
                            if (maxBw >= 1000) {
                                let mbps = maxBw / 1000;
                                bwTitle = `BW (0 - ${mbps % 1 === 0 ? mbps : mbps.toFixed(1)} mbps)`;
                            } else {
                                bwTitle = `BW (0 - ${maxBw} kbps)`;
                            }
                        } else {
                            bwTitle = 'BW Utilization';
                        }
                    }
                    const bwLineColor = hasBw ? bwColor : null;
                    
                    drawChartFrame(cpuTitle, chartYOffset, blockHeight, cpuLineColor, bwTitle, bwLineColor);
                    
                    if (hasCpu) {
                        let rawCpu = page._utilization.cpu;
                        if (typeof rawCpu === 'string') {
                            try { rawCpu = JSON.parse(rawCpu); } catch (e) { rawCpu = []; }
                        }
                        if (Array.isArray(rawCpu) && rawCpu.length > 0 && typeof rawCpu[0] === 'object' && !Array.isArray(rawCpu[0])) {
                            rawCpu = rawCpu[0];
                        }
                        
                        let cpuData = [];
                        if (Array.isArray(rawCpu)) cpuData = rawCpu;
                        else if (typeof rawCpu === 'object' && rawCpu !== null) {
                            for (const [key, val] of Object.entries(rawCpu)) {
                                if (val && typeof val === 'object' && val.time !== undefined) cpuData.push(val);
                                else cpuData.push({ time: parseFloat(key), value: parseFloat(val) });
                            }
                            cpuData.sort((a, b) => a.time - b.time);
                        }
                        
                        this.ctx.beginPath();
                        this.ctx.strokeStyle = cpuColor;
                        this.ctx.lineWidth = 2;
                        let firstCpu = true;
                        let lastCpuX = dimensions.labelsWidth;
                        if (cpuData.length > 0) {
                            this.ctx.moveTo(dimensions.labelsWidth, chartYOffset + blockHeight);
                            firstCpu = false;
                        }
                        
                        cpuData.forEach(point => {
                            let ts = point.time !== undefined ? point.time : (point.ts !== undefined ? point.ts : (Array.isArray(point) ? point[0] : null));
                            let val = point.value !== undefined ? point.value : (point.v !== undefined ? point.v : (Array.isArray(point) ? point[1] : null));
                            if (ts === null || val === null) return;
                            
                            let internalTs = ts;
                            if (internalTs > 1000000000000000) internalTs = internalTs / 1000;
                            if (internalTs > 1000000000 && internalTs < 1000000000000) internalTs = internalTs * 1000;
                            if (internalTs > 1000000000000) internalTs -= baseStartMs;
                            if (internalTs > dimensions.maxTime * 50) internalTs = internalTs / 1000; 
                            
                            const x = xScaler(internalTs);
                            const y = chartYOffset + blockHeight - ((val || 0) * blockHeight / 100);
                            
                            if (internalTs >= 0 && internalTs <= dimensions.maxTime && isFinite(x) && isFinite(y)) {
                                if (firstCpu) {
                                    this.ctx.moveTo(x, y);
                                    firstCpu = false;
                                    lastCpuX = x;
                                } else {
                                    this.ctx.lineTo(lastCpuX, y);
                                    this.ctx.lineTo(x, y);
                                    lastCpuX = x;
                                }
                            }
                        });
                        this.ctx.stroke();
                    }

                    if (hasBw) {
                        let rawBw = page._utilization.bw;
                        if (typeof rawBw === 'string') {
                            try { rawBw = JSON.parse(rawBw); } catch (e) { rawBw = []; }
                        }
                        if (Array.isArray(rawBw) && rawBw.length > 0 && typeof rawBw[0] === 'object' && !Array.isArray(rawBw[0])) {
                            rawBw = rawBw[0];
                        }
                        
                        let bwData = [];
                        if (Array.isArray(rawBw)) bwData = rawBw;
                        else if (typeof rawBw === 'object' && rawBw !== null) {
                            for (const [key, val] of Object.entries(rawBw)) {
                                if (val && typeof val === 'object' && val.time !== undefined) bwData.push(val);
                                else bwData.push({ time: parseFloat(key), value: parseFloat(val) });
                            }
                            bwData.sort((a, b) => a.time - b.time);
                        }
                        
                        this.ctx.beginPath();
                        this.ctx.strokeStyle = bwColor;
                        this.ctx.lineWidth = 2;
                        let firstBw = true;
                        let lastBwX = dimensions.labelsWidth;
                        if (bwData.length > 0) {
                            this.ctx.moveTo(dimensions.labelsWidth, chartYOffset + blockHeight);
                            firstBw = false;
                        }
                        
                        bwData.forEach(point => {
                            let ts = point.time !== undefined ? point.time : (point.ts !== undefined ? point.ts : (Array.isArray(point) ? point[0] : null));
                            let val = point.value !== undefined ? point.value : (point.v !== undefined ? point.v : (Array.isArray(point) ? point[1] : null));
                            if (ts === null || val === null) return;

                            if (ts > 1000000000000000) ts = ts / 1000;
                            if (ts > 1000000000 && ts < 1000000000000) ts = ts * 1000;
                            if (ts > 1000000000000) ts -= baseStartMs;
                            if (ts > dimensions.maxTime * 50) ts = ts / 1000; 
                            
                            const x = xScaler(ts);
                            const y = chartYOffset + blockHeight - ((val || 0) * blockHeight / 100);
                            
                            if (ts >= 0 && ts <= dimensions.maxTime && isFinite(x) && isFinite(y)) {
                                if (firstBw) {
                                    this.ctx.moveTo(x, y);
                                    firstBw = false;
                                    lastBwX = x;
                                } else {
                                    this.ctx.lineTo(lastBwX, y);
                                    this.ctx.lineTo(x, y);
                                    lastBwX = x;
                                }
                            }
                        });
                        this.ctx.stroke();
                    }
                    
                    this.ctx.lineWidth = 1;
                    chartYOffset += blockHeight;
                }
                
                // Draw Main Thread & Long Tasks (WPT format often has browser_main_thread)
                // Also track generic `_mainThreadEvents` we will add from chrome-trace.js
                const mtEvents = page._browser_main_thread || page._mainThreadEvents || [];
                if (this.options.showMainthread && mtEvents.length > 0) {
                    const blockHeight = this.options.thumbnailView ? 16 : 50;
                    const mtTitle = !this.options.thumbnailView ? 'Main Thread' : null;
                    drawChartFrame(mtTitle, chartYOffset, blockHeight);
                    
                    mtEvents.forEach(evt => {
                        let ts = evt.time;
                        // Auto normalize format
                        if (ts > 1000000000000) ts -= baseStartMs;
                        if (ts < 0 || ts > dimensions.maxTime) return;
                        
                        const duration = evt.duration || 0;
                        const src = evt.source || evt.type || '';
                        
                        let color = [200, 200, 200];
                        if (src.toLowerCase().includes('script')) color = [255, 190, 80];
                        else if (src.toLowerCase().includes('layout') || src.toLowerCase().includes('style')) color = [150, 100, 255];
                        else if (src.toLowerCase().includes('paint')) color = [80, 200, 100];
                        else if (src.toLowerCase().includes('parse')) color = [120, 180, 255];
                        
                        const sx = xScaler(ts);
                        const ex = Math.max(sx + 1, xScaler(ts + duration));
                        
                        this.ctx.fillStyle = `rgb(${color.join(',')})`;
                        const padding = this.options.thumbnailView ? 0 : 10;
                        this.ctx.fillRect(sx, chartYOffset + padding, ex - sx, blockHeight - (padding * 2));
                    });
                    
                    chartYOffset += blockHeight;
                }

                const longTasks = page._longTasks || [];
                if (this.options.showLongtasks && (longTasks.length > 0 || mtEvents.length > 0)) {
                    const blockHeight = this.options.thumbnailView ? 4 : 18;
                    const ltTitle = !this.options.thumbnailView ? 'Long Tasks' : null;
                    drawChartFrame(ltTitle, chartYOffset, blockHeight, null, null, null, false, false); // showBands = false, showGrid = false
                    
                    let startEventTs = 0;
                    if (page._firstContentfulPaint > 0) startEventTs = page._firstContentfulPaint;
                    else if (page._render > 0) startEventTs = page._render;
                    
                    let startEventX = Math.floor(xScaler(startEventTs));
                    
                    if (startEventX < dimensions.canvasWidth) {
                        // Draw Interactive Background (Green) from FCP onwards
                        this.ctx.fillStyle = 'rgb(178, 234, 148)';
                        const startX = Math.max(dimensions.labelsWidth + 1, startEventX);
                        this.ctx.fillRect(startX, chartYOffset + 1, dimensions.canvasWidth - startX, blockHeight - 2);
                    }
                    
                    const longTasks = page._longTasks || [];
                    if (longTasks.length > 0) {
                        longTasks.forEach(period => {
                            const sx = Math.floor(xScaler(period[0]));
                            const ex = Math.floor(Math.max(sx + 1, xScaler(period[1])));
                            
                            if (ex > dimensions.labelsWidth) {
                                const drawSx = Math.max(dimensions.labelsWidth + 1, startEventX, sx);
                                const drawEx = Math.min(dimensions.canvasWidth - 1, ex);
                                
                                if (drawEx > drawSx) {
                                    this.ctx.fillStyle = 'rgb(255, 82, 62)'; // Blocked (Red/Orange)
                                    this.ctx.fillRect(drawSx, chartYOffset + 1, drawEx - drawSx, blockHeight - 2);
                                }
                            }
                        });
                    } else {
                        const mtEvents = page._browser_main_thread || page._mainThreadEvents || [];
                        mtEvents.forEach(evt => {
                            const duration = evt.duration || 0;
                            if (duration >= 50) {
                                let ts = evt.time;
                                if (ts > 1000000000000) ts -= baseStartMs;
                                if (ts < 0 || ts > dimensions.maxTime) return;
                                
                                const sx = Math.floor(xScaler(ts));
                                const ex = Math.floor(Math.max(sx + 1, xScaler(ts + duration)));
                                
                                if (ex > dimensions.labelsWidth) {
                                    const drawSx = Math.max(dimensions.labelsWidth + 1, startEventX, sx);
                                    const drawEx = Math.min(dimensions.canvasWidth - 1, ex);
                                    
                                    if (drawEx > drawSx) {
                                        this.ctx.fillStyle = 'rgb(255, 82, 62)'; // Blocked (Red/Orange)
                                        this.ctx.fillRect(drawSx, chartYOffset + 1, drawEx - drawSx, blockHeight - 2);
                                    }
                                }
                            }
                        });
                    }
                    
                    chartYOffset += blockHeight;
                }
            }

            // End graph clipping region
            this.ctx.restore();

            // 9. Draw URL Labels
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(0, 0, Math.max(0, dimensions.labelsWidth - 2), dimensions.canvasHeight);
            this.ctx.clip();

            this.ctx.textAlign = 'left';
            if (this.options.showLabels !== false) {
                const fontSize = this.options.thumbnailView ? 4 : 11;
                this.ctx.font = `${fontSize}px sans-serif`;
                
                let renderedConnectionRows = new Set();
                let connectionDisplayIndex = 1;
                
                rows.forEach((row, index) => {
                    if (this.options.connectionView) {
                        if (renderedConnectionRows.has(row.y1)) return;
                        renderedConnectionRows.add(row.y1);
                    }

                    // URL Text Label
                    let textColor = '#000';
                    if (row.documentURL) {
                        const reqDocUrl = row.documentURL.split('?')[0].split('#')[0];
                        if (reqDocUrl && mainDocUrl && reqDocUrl !== mainDocUrl) {
                            textColor = '#0000ff'; // Blue for distinct document contexts
                        }
                    }
                    
                    let textX = 10;
                    
                    // Draw Render Blocking Indicator
                    if (row.renderBlocking === 'blocking') {
                        const iconW = this.options.thumbnailView ? 4 : 14;
                        const iconY = this.options.thumbnailView ? row.y1 : row.y1 + 2;
                        
                        // Orange warning circle
                        this.ctx.fillStyle = '#ff9900';
                        this.ctx.beginPath();
                        this.ctx.arc(textX + iconW / 2, iconY + iconW / 2, iconW / 2, 0, 2 * Math.PI);
                        this.ctx.fill();
                        
                        // White X cross lines
                        this.ctx.strokeStyle = '#ffffff';
                        this.ctx.lineWidth = this.options.thumbnailView ? 0.5 : 1.5;
                        const pad = this.options.thumbnailView ? 1 : 4;
                        this.ctx.beginPath();
                        this.ctx.moveTo(textX + pad, iconY + pad);
                        this.ctx.lineTo(textX + iconW - pad, iconY + iconW - pad);
                        this.ctx.moveTo(textX + iconW - pad, iconY + pad);
                        this.ctx.lineTo(textX + pad, iconY + iconW - pad);
                        this.ctx.stroke();
                        this.ctx.lineWidth = 1;

                        textX += iconW + 4;
                    }

                    this.ctx.fillStyle = textColor;
                    const prefix = this.options.connectionView ? `${connectionDisplayIndex++}. ` : `${index + 1}. `;
                    let urlText = row.url || '';
                    if (this.options.connectionView) {
                        urlText = urlText.split(' - ')[0];
                    }
                    
                    const prefixWidth = this.ctx.measureText(prefix).width;
                    const maxUrlWidth = dimensions.labelsWidth - textX - prefixWidth - 6; // 6px padding from line
                    
                    let currentUrlWidth = this.ctx.measureText(urlText).width;
                    if (currentUrlWidth > maxUrlWidth && urlText.length > 5 && maxUrlWidth > 10) {
                        const avgCharWidth = currentUrlWidth / urlText.length;
                        let targetLen = Math.floor(maxUrlWidth / avgCharWidth);
                        
                        if (targetLen > 3) targetLen -= 3;
                        
                        while (targetLen > 4) {
                            const half = Math.floor((targetLen - 3) / 2);
                            const testUrlText = urlText.substring(0, half) + '...' + urlText.substring(urlText.length - half);
                            if (this.ctx.measureText(testUrlText).width <= maxUrlWidth) {
                                urlText = testUrlText;
                                break;
                            }
                            targetLen--;
                        }
                        if (targetLen <= 4 && urlText.length > 0) {
                            let shortText = urlText.substring(0, Math.max(1, Math.floor(maxUrlWidth / avgCharWidth))) + '..';
                            if (this.ctx.measureText(shortText).width > maxUrlWidth) shortText = '';
                            urlText = shortText;
                        }
                    }
                    
                    const labelText = prefix + urlText;
                    const fontYOffset = this.options.thumbnailView ? 4 : 13;
                    this.ctx.fillText(labelText, textX, row.y1 + fontYOffset);
                });
            }
            
            this.ctx.restore();
    }
}
