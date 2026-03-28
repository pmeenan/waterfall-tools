import { processWPTFileNode } from './src/inputs/wpt-json.js';

async function run() {
    try {
        const har = await processWPTFileNode(process.argv[2], { isGz: true });
        
        let pageStartTime = new Date(har.log.pages[0].startedDateTime).getTime();

        for (const entry of har.log.entries) {
            const entryStart = new Date(entry.startedDateTime).getTime();
            const relStart = entryStart - pageStartTime;
            const end = relStart + entry.time;
            if (end > 30000) { // > 30 seconds
                console.log(`Found entry ending at ${end}ms. Start: ${relStart}ms, Time: ${entry.time}ms. URL: ${entry.request.url.substring(0, 100)}`);
                console.log(`  req.load_start: ${entry._load_start}`);
                console.log(`  req.all_ms: ${entry._all_ms}`);
                console.log(`  req.ttfb_ms: ${entry._ttfb_ms}, req.download_ms: ${entry._download_ms}`);
                console.log(`  timings object:`, entry.timings);
                console.log(`-------------------------------------`);
            }
        }
    } catch(e) {
        console.error(e);
    }
}
run();
