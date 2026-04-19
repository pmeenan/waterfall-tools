#!/usr/bin/env node
/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Test script for headless image generation.
 * Run using: node bin/generate-image.js <input-file> <output-file.png|jpg> [--width 1200] [--thumbnail]
 */

import { WaterfallTools } from '../src/core/waterfall-tools.js';
import fs from 'fs';

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error("Usage: node generate-image.js <input-file> <output-file> [--width <px>] [--thumbnail]");
        process.exit(1);
    }
    
    const inputFile = args[0];
    const outputFile = args[1];
    
    let width = 1200;
    let thumbnailView = false;
    
    for (let i = 2; i < args.length; i++) {
        if (args[i] === '--width') {
            width = parseInt(args[++i], 10);
        } else if (args[i] === '--thumbnail') {
            thumbnailView = true;
        }
    }
    
    const format = outputFile.toLowerCase().endsWith('.jpg') || outputFile.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';

    console.log(`Loading inputs from ${inputFile}...`);
    
    const wft = new WaterfallTools();
    try {
        await wft.loadFile(inputFile);
    } catch (e) {
        console.error("Parsing failed:", e);
        process.exit(1);
    }
    
    const pages = Object.keys(wft.data.pages);
    console.log(`Identified ${pages.length} pages. Rendering first page...`);
    
    const options = {
        format,
        width,
        thumbnailView,
        quality: 0.90
    };
    
    console.log(`Generating image with options:`, options);
    const start = performance.now();
    try {
        const imageResult = await wft.generateImage(pages[0], options);
        
        fs.writeFileSync(outputFile, imageResult.buffer);
        const kb = (imageResult.buffer.length / 1024).toFixed(2);
        
        console.log(`\nSuccess! Wrote ${kb} KB to ${outputFile}`);
        console.log(`Dimensions: ${imageResult.width}x${imageResult.height}`);
        console.log(`Generation Time: ${(performance.now() - start).toFixed(2)} ms`);
    } catch (e) {
        console.error("Image generation failed:", e);
        process.exit(1);
    } finally {
        await wft.destroy();
    }
}

main().catch(console.error);
