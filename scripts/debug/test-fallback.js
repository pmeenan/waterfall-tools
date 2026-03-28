import { processChromeTraceFileNode } from '../../src/inputs/chrome-trace.js';
import fs from 'node:fs';

async function verify() {
  // Monkey patch Netlog class so it completely ignores addTraceEvent
  const netlogModule = await import('../../src/inputs/netlog.js');
  const original = netlogModule.Netlog.prototype.addTraceEvent;
  netlogModule.Netlog.prototype.addTraceEvent = () => {};

  const har = await processChromeTraceFileNode('../../Sample/Data/Chrome Traces/trace_www.google.com.json.gz');
  console.log(`Fallback Builder captured ${har.log.entries.length} standalone requests accurately!`);
  
  if (har.log.entries.length > 5) {
     console.log(JSON.stringify(har.log.entries[0], null, 2));
  }
}
verify();
