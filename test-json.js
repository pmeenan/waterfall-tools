import fs from 'fs';
import { JSONParser } from '@streamparser/json-whatwg';

const parser = new JSONParser({ paths: ["$.log.entries.*"], keepStack: false });

const stream = fs.createReadStream('Sample/Data/HAR/www.google.com-wpt.har')
  .pipeThrough(new TransformStream({
      transform(chunk, controller) {
         controller.enqueue(chunk);
      }
  })) // Node stream to Web Stream adapter needed!
