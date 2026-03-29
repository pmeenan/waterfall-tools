import { WaterfallTools } from './src/core/waterfall-tools.js';

async function main() {
    console.log('Starting...');
    const tool = new WaterfallTools();
    console.log('Loading file...');
    await tool.loadFile('Sample/Data/HARs/WebPageTest/amazon.har.gz', { format: 'har', debug: true });
    
    console.log('Loaded file. Data entries count:', Object.keys(tool.data.pages).length, 'pages');
    
    console.log('Getting HAR (mapping)... this is where we suspect hanging');
    const start = Date.now();
    const har = tool.getHar({ debug: true });
    const elapsed = Date.now() - start;
    
    console.log('Got HAR. Length:', har.log.entries.length, 'entries. Mapping took', elapsed, 'ms');
    console.log('Testing JSON stringify native mapping...');
    
    const stringifyStart = Date.now();
    const result = JSON.parse(JSON.stringify(har));
    const stringifyElapsed = Date.now() - stringifyStart;
    
    console.log('Passed Stringify. Took', stringifyElapsed, 'ms');
    console.log('Done cleanly!');
    process.exit(0);
}

main().catch(console.error);
