This is a collection of key prompts that were used during the project's lifetime.

# Initial Prompts

These are the prompts that were used to seed the initial project plan and design (a few key ones before implementation started).

Along the way there were a lot of clarifying comments and comments on plans but these are the key structural prompts for each of the phases.

```
Design an architecture for a javascript library for generating and viewing network waterfalls from a variety of data source formats. The output artifacts should be an architecture document in markdown format with mermaid diagrams in the file Docs/Architecture.md, instructions suitable for AI agents to work on bite-sized chunks in Docs/Plan.md and overall guidance and context in AGENTS.md.

The AGENTS.md file should start with instructions to:
- read `Docs/Architecture.md` for the project architecture
- read `Docs/Plan.md` for the project implementation plan
- At the end of each conversation, update `Docs/Plan.md` and  `Docs/Architecture.md` with any respective changes and `AGENTS.md` with any information that would benefit future agents either as a result of the current conversation or as discovered while working on the current conversation (it is the long-term memory for the project)

The system should use an intermediary data format that is an extended version of the HAR file format all of the inputs can be processed into. The extension is to use the specified fields as-specified but to add all of the extra details in underscore-prefixed keys (which are allowed as an application-specific extension) which is similar to how WebPageTest works.

The library should be able to take a variety of input formats where the processing for each format is self-contained within a single javascript module, new formats can be plugged in later as needed and the input processors should have a central orchestrator that provides an API for converting the input file to the intermediary HAR format.

The library should be able to produce a variety of outputs, including but not limited to waterfall images, thumbnails, simplified json with request data.

The library should be able to render to a canvas and support hooks and application logic for hovering over the canvas waterfall items, clicking on them for more detail and customizing the view (zooming, filtering, etc).

The library should support being embedded into a website and being provided a DIV and either a URL or raw data as input and it should be able to show a fully interactive viewer UI as well as views using other embedable viewers like perfetto and the hosted version of Chrome dev tools. It should also support iframe-based embedding where query params specify the relevant parameters including data source.

The files should be structured so that the input processors, output processors, embedable viewrs, common libraries, conductors, and platform-specific modules are all in separate directories and co-located with each other.

Eventually it should also support viewing a filmstrip view of screenshots from the page loading and the generation of the screenshots from video files, individual images or images embedded in a JSON file (like a chrome trace).

The resulting library should be buildable with support for selectable inputs, outputs, embeddings and target platforms (browser/node/etc) though only to the extent where specifying a platform is necessary.

The goal is to build something as useful as WebPageTest's waterfall and filmstrip views but in a reusable library with modern architecture and completely client-rendered.

A modern framework can be used if it helps the architecture and readability of the code but every effort should be made to make sure it is a performant framework and as small as possible to prevent bloating (which wouldn't be a good look for a performance-focused tool). Vanilla JS would be the preference where possible.

Some of the features may require wasm at some point (video and image processing) but native support should be used where possible (drawing to canvas to generate images for example).

Some references of use:
- HAR file format spec: http://www.softwareishard.com/blog/har-12-spec/
- reading a webpagetest waterfall: https://calendar.perfplanet.com/2019/reading-a-webpagetest-waterfall-chart/
- using webpagetest: https://www.debugbear.com/software/webpagetest
- chrome dev tools network tab: https://www.debugbear.com/blog/devtools-network
```

```
Update the plan and AGENTS.md to note that sample files for each data format will be stored in the `Sample/Data` folder with separate folders for each different type of input (with some, like HARs having sub-folders with files from different sources). It should also note that there are sample implementations in python for parsing some of the different file formats in `Sample/Implementations`.

They should also be updated to have each input format have a stand-alone cli mode (which can also be used for testing) where it takes an input file and generates an output file in the intermediary HAR format. Tests should also be written to compare to known-good outputs (after the initial set are generated)
```

```
Update AGENTS.md to note that the minimum requirements for targeting javascript  and browser APIs are the latest stable versions of Chrome, Firefox, Safari and Node.js (so the latest technologies can be used without worrying about backward compatibility) and that the input files should be tolerant of malformed or truncated files and, where possible, process one line or record of the file at a time and streamed.
```

# Schema Creation

Tweaks made during the schema definition

```
There are sample WebPageTest HAR files in the WebPageTest folder in HARs.  Make sure that the schema includes all of the fields that they expose at the page and request level and that the schema for any dictionary entries they contain are also included in the schema. 

If it helps, the code that converts WebPageTest's JSON format to HAR is in the generate_har function in process_test.py and the matching WebPageTest JSON-format files are in 
WebPageTest JSON
```

# Input Format Processing

## HAR

```
Some of the HAR files may be gzip compressed, process them accordingly (and search the directory recursively).

When verifying, make sure all of the page and requests in the source HARs are included in the output file
```

## Netlog

```
There is a reference implementation from the apache-licensed wptagent in netlog.py for parsing the netlog file and converting them to requests. The resulting files should also maintain the information about connections and DNS lookups that aren't linked to specific requests (extend the schema as necessary).

The Netlog files are from the same tests as the WebPageTest HARs in HARs (though each netlog is for a single page load while the HARs have all of the tests for each page combined). The file names indicate which websites were tested and the prefix of the filename (through .com) from each set designate the matching files. Make sure the resulting processed Netlog files are not missing any requests that were in the HAR files (or that only a few are missing in the case that the WebPageTest HARs were augmented with additional source data).

The resulting files should also include the base64-encoded response bodies if the netlog has the decoded byte streams for the requests.

Make sure the tests that are created also create reference golden files to compare against for future tests.
```

## Chrome Devtools Protocol

```
There is a reference implementation fromthe apache-licensed wptagent in devtools_parser.py for parsing the file and converting them to page data and requests requests.

The CDP files are from the same tests as the WebPageTest HARs in HARs (though each is for a single page load while the HARs have all of the tests for each page combined).

Make sure the tests that are created also create reference golden files to compare against for future tests.
```

## Chrome trace

```
There is a reference implementation from wptagent in trace_parser.py for parsing the file and converting them to page data and requests requests but that is only a baseline to start from.

The trace files have netlog events that match the events handled by the netlog parser. Instead of re-inventing the netlog processing, use the existing netlog support for processing the netlog events and converting them to requests and untracked data.  Update the API for the har processing logic for it to be allowed to be used for processing these events and for being used internally as part of this processing.

For the purpose of building the processing logic, use the netlog events to identify matching events for requests in other tracing categories so that files can be processed when there are no netlog events (or other categories are missing). Use the oither categories to augment the request and page data where it makes sense.

Make sure the resulting processed data has a reasonable number of requests and page data that makes sense.

Make sure the tests that are created also create reference golden files to compare against for future tests.
```

```
Did you look for other categories like loading and blink that also log requests and page loading information with different event categories to see if the requests can be built in parallel without netlog events (for when they are missing)?
```

## tcpdump

```
We have reached the point in Phase 2 where we need to implement a tcpdump parser but we should do that in multiple steps because it is going to be pretty complex. Please update the plan with more details and phases for the sub-parts of the tcpdump processing.

The steps that come to mind are:
- Load the TLS key log that matches the given tcpdump capture file (or for cap file formats that support embedded key logs, extract it from the bundle)
- Parse the capture file into packets
- For TCP streams, build the raw data stream (with timestamps for each segment) based on src/dest IP and port and the SYN/FIN packets to identify the start/end. It needs to handle retransmits, overlapping windows and out-of-order packets.
- For UDP streams, build virtual connection "streams" based on the packet numbers, src/dest IP/ports.
- For TLS-encrypted TCP streams, decrypt them using the key log and keep per-chunk timestamps that match the packet timings.
- Once we have unencrypted TCP streams, detect and decode HTTP/1.x, HTTP/2 and DNS over HTTP protocols into individual requests which can then be extracted and processed (along with the connection setup and connection affinity information)
- For UDP, detect DNS and QUIC formats and for TLS-encrypted QUIC, use the keylog to decrypt the QUIC stream.
- Decode DNS traffic and store the DNS lookups for adding to the request timings.
- Decode QUIC traffic to extract the streams and parse the relevant requests.
- Create a virtual "page" entry. By default, use the first HTTP request as the "page" URL but if there are any HTTP requests with a "Sec-Fetch-Dest" request header with a value of "document", use the first one as the page URL.

Please reference the RFC specs or use any libraries that will help make the processing easier (particularly around the TLS decoding and format processing if libraries exist).  If libraries don't exist, create stand-alone utility libraries as needed.
```

```
Proceed with the first step of capture processing. Sample tcpdump files are in tcpdump. The pcap files .cap or .cap.gz extensions. There is a very basic pcap parser in pcap-parser.py but you should find references to the pcap file formats and support newer versions of the format if it makes sense
```

```
We have reached the part of the tcpdump implementation in phase 2 where we load the TLS key log into memory and index the individual keys so they can be used for decoding the TLS streams. The sample pcap files in `Sample/Data/tcpdump` have matching key logs with extensions that end in .txt or .txt.gz and have similar (but not necessarily exactly the same) base file name as the matching pcap. Make a not of this in the plan for future steps so they know where to locate the key logs (and feel free to rename the key logs so the base file name exactly matches the matching pcap).
```

```
 For protocols like HTTP/2, make sure to associate the individual requests with the streams they belong to and the top-level HTTP/2 connection and keep track of the settings and options that are maintained at the relevant layers (don't lose the information by just extracting the requests). Keep the fine-grained timing of the parts of the requests and responses like with the headers and bodies (maybe a single timestamp for the headers but the bodies as an array of chunks with a timestamp and length).
 ```

 ```
 restructure the `src/inputs` directory so that only the API entrypoints are at the top level, cli tools are in a `cli` directory, any shared utilities are in a `utilities` directory and any format-specific utilities are in a format-specific directory under `utilities`.

Also clean up any temporary utility scripts at the top level of the project that are no longer needed (or any that are needed, move into an appropriate folder so they don't pollute the project top-level folder).
```

# Canvas Rendering

```
Move on to phase 5 of the plan. As part of the work, create a HTML page that uses the input API with uploaded files (including keylog for tcpdump) and renders the result to a canvas filling most of the browser window width and as tall as necessary to show the full waterfall. It should also support drag/drop for dropping any of the supported input formats and rendering the relevant waterfall.

The entry point for WebPageTest's waterfall generation in PHP that takes the WebPageTest json and creates an image (thumbnail or full image) is in waterfall.php (with core logic included from there). Use the same colors are used by WebPageTest, including the gradients for each bar and the mime-specific coloring. Also include the support for rendering chunks of data and script execution.

Please ask if you have any questions about the implementation.
```

```
Update the project build to create a index.html at the root of the demos (`src/demo` and `bin/demo`) that links to individual demo pages (only the canvas demo for now). That way the main project build can build all of the demos and load a main landing page for interacting with all of them.
```

```
Replace the current placeholder README.md with appropriate user and developer-facing documentation, pointing to Architecture.md as needed but with all API documentation and build/test instructions.

Update the first instruction in AGENTS.md to instruct agents to update README.md as necessary as changes to the project are made.
```

```
Add an example to the API usage for providing a non-streaming buffer and add an API (and sample) to the conductor to allow loading from an external URL.
```

```
Why does processBuffer need the format to be explicitly provided? It should support autodetect like the rest of the API surfaces.
```