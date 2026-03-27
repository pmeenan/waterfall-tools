import fs from 'node:fs';
import { processNetlogFileNode } from '../src/inputs/netlog.js';
import { processHARFileNode } from '../src/inputs/har.js';
import path from 'node:path';

async function compareNetlogsToHar(harPath, netlogPaths) {
    console.log(`\nValidating Netlog files against WebPageTest HAR: ${path.basename(harPath)}`);
    
    // Load the reference WPT HAR
    const wptHar = await processHARFileNode(harPath);
    
    // Extract unique standardized URLs from WPT HAR for the specific run to compare
    const wptUrls = new Set();
    const wptEntries = wptHar?.log?.entries || [];
    wptEntries.forEach(e => {
        if (e.request && e.request.url) {
            let u = e.request.url.split('#')[0];
            wptUrls.add(u);
        }
    });

    console.log(`Loaded ${wptUrls.size} unique request URLs from WPT HAR`);

    for (const netlogPath of netlogPaths) {
        console.log(`\n--- Comparing Netlog: ${path.basename(netlogPath)} ---`);
        const netlogHar = await processNetlogFileNode(netlogPath);
        
        const netlogUrls = new Set();
        const netlogEntries = netlogHar?.log?.entries || [];
        netlogEntries.forEach(e => {
            if (e.request && e.request.url) {
                let u = e.request.url.split('#')[0];
                netlogUrls.add(u);
            }
        });

        console.log(`Loaded ${netlogUrls.size} unique request URLs from Netlog`);

        // Check for missing URLs
        let missingCount = 0;
        let missingUrls = [];

        // Note: WPT HAR might contain multiple runs, while Netlog is typically just one.
        // We evaluate what's in the WPT HAR but missing from the Netlog.
        for (const url of wptUrls) {
            if (!netlogUrls.has(url)) {
                missingCount++;
                missingUrls.push(url);
            }
        }
        
        let overlapPercent = ((wptUrls.size - missingCount) / wptUrls.size * 100).toFixed(2);
        console.log(`Overlap: ${wptUrls.size - missingCount} / ${wptUrls.size} URLs (${overlapPercent}%)`);
        
        if (missingCount > 0) {
            console.log(`Netlog is missing ${missingCount} URLs present in the HAR. (Expected due to multiple runs padding HAR)`);
        }

        let netlogOnlyCount = 0;
        for (const url of netlogUrls) {
            if (!wptUrls.has(url)) netlogOnlyCount++;
        }
        console.log(`Netlog contains ${netlogOnlyCount} URLs not present in HAR.`);
    }
}

async function run() {
    const netlogDir = path.resolve('Sample/Data/Netlog');
    const harDir = path.resolve('Sample/Data/HARs/WebPageTest');

    const wptHarFiles = fs.readdirSync(harDir).filter(f => f.endsWith('.har') || f.endsWith('.har.gz'));
    const netlogFiles = fs.readdirSync(netlogDir).filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));

    for (const harFile of wptHarFiles) {
        let prefix = harFile;
        // Strip .har.gz
        prefix = prefix.replace(/\.har\.gz$/, '').replace(/\.har$/, ''); 
        
        // Find matching netlogs
        const matchingNetlogs = netlogFiles.filter(f => f.startsWith(prefix));
        if (matchingNetlogs.length > 0) {
            const absHarPath = path.join(harDir, harFile);
            const absNetlogPaths = matchingNetlogs.map(f => path.join(netlogDir, f));
            await compareNetlogsToHar(absHarPath, absNetlogPaths);
        }
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
