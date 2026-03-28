import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const PRIORITY_MAP = {
    "VeryHigh": "Highest",
    "HIGHEST": "Highest",
    "MEDIUM": "High",
    "LOW": "Medium",
    "LOWEST": "Low",
    "IDLE": "Lowest",
    "VeryLow": "Lowest"
};

export class Netlog {
    constructor() {
        this.netlog = { bytes_in: 0, bytes_out: 0, next_request_id: 1000000 };
        this.netlog_requests = null;
        this.marked_start_time = null;
        this.start_time = null;
        this.constants = null;
        this.bodies = {}; 
        
        this.netlog.url_request = {};
        this.netlog.socket = {};
        this.netlog.dns = {};
        this.netlog.connect_job = {};
        this.netlog.stream_job = {};
        this.netlog.h2_session = {};
        this.netlog.quic_session = {};
        this.netlog.dns_info = {};
        this.netlog.urls = {};
        this.netlog_event_types = {};
    }

    setConstants(constants) {
        this.constants = {};
        for (const [key, value] of Object.entries(constants)) {
            if (typeof value === 'object' && value !== null && key !== 'clientInfo') {
                this.constants[key] = {};
                for (const [name, val] of Object.entries(value)) {
                    this.constants[key][val] = name;
                }
            } else {
                this.constants[key] = value;
            }
        }
    }

    addEvent(event) {
        try {
            this.hydrateEvent(event);
            this.processEvent(event);
        } catch (e) {
            // Silently ignore individual event processing errors
        }
    }

    addTraceEvent(trace_event) {
        if (trace_event && trace_event.args && trace_event.name) {
            try {
                let id = trace_event.id;
                if (id === undefined && trace_event.id2) {
                    id = trace_event.id2.local !== undefined ? trace_event.id2.local : trace_event.id2.global;
                }
                if (id === undefined) return;
                
                if (typeof id === 'string') {
                    if (id.startsWith('0x')) id = parseInt(id, 16);
                    else id = parseInt(id, 10);
                }
                
                let event_type = null;
                const name = trace_event.name;
                if (trace_event.args.source_type) {
                    event_type = trace_event.args.source_type;
                    this.netlog_event_types[name] = event_type;
                } else if (this.netlog_event_types[name]) {
                    event_type = this.netlog_event_types[name];
                }

                if (event_type !== null) {
                    const event = {
                        time: trace_event.ts,
                        type: name,
                        phase: 'PHASE_NONE',
                        source: {
                            id: id,
                            type: event_type
                        },
                        params: trace_event.args.params || trace_event.args || {}
                    };
                    
                    if (trace_event.ph === 'b' || trace_event.ph === 'B') event.phase = 'PHASE_BEGIN';
                    else if (trace_event.ph === 'e' || trace_event.ph === 'E') event.phase = 'PHASE_END';
                    
                    this.addEvent(event);
                }
            } catch (e) {
                // Silently ignore tracing mapping errors
            }
        }
    }

    hydrateEvent(event) {
        if (!this.constants) return;
        const consts = this.constants;
        
        if (event.type !== undefined && consts.logEventTypes && consts.logEventTypes[event.type]) {
            event.type = consts.logEventTypes[event.type];
        }
        if (event.phase !== undefined && consts.logEventPhase && consts.logEventPhase[event.phase]) {
            event.phase = consts.logEventPhase[event.phase];
        }
        if (event.source && typeof event.source === 'object') {
            const src = event.source;
            if (src.type !== undefined && consts.logSourceType && consts.logSourceType[src.type]) {
                src.type = consts.logSourceType[src.type];
            }
        }
        if (event.params && typeof event.params === 'object') {
            const params = event.params;
            if (params.cert_status !== undefined && consts.certStatusFlag) {
                let certStatus = [];
                for (const [flagStr, name] of Object.entries(consts.certStatusFlag)) {
                    const flag = parseInt(flagStr, 10);
                    if (params.cert_status & flag) certStatus.push(name);
                }
                params.cert_status = certStatus.join(',');
            }
            if (typeof params.source_dependency === 'object' && params.source_dependency !== null) {
                const srcDep = params.source_dependency;
                if (srcDep.type !== undefined && consts.logSourceType && consts.logSourceType[srcDep.type]) {
                    srcDep.type = consts.logSourceType[srcDep.type];
                }
            }
            if (params.dns_query_type !== undefined && consts.dnsQueryType && consts.dnsQueryType[params.dns_query_type]) {
                params.dns_query_type = consts.dnsQueryType[params.dns_query_type];
            }
            if (params.secure_dns_policy !== undefined && consts.secureDnsMode && consts.secureDnsMode[params.secure_dns_policy]) {
                params.secure_dns_policy = consts.secureDnsMode[params.secure_dns_policy];
            }
            if (params.secure_dns_mode !== undefined && consts.secureDnsMode && consts.secureDnsMode[params.secure_dns_mode]) {
                params.secure_dns_mode = consts.secureDnsMode[params.secure_dns_mode];
            }
            if (params.priority !== undefined && PRIORITY_MAP[params.priority]) {
                params.priority = PRIORITY_MAP[params.priority];
            }
            if (params.load_flags !== undefined && consts.loadFlag) {
                let loadFlags = [];
                for (const [flagStr, name] of Object.entries(consts.loadFlag)) {
                    const flag = parseInt(flagStr, 10);
                    if (params.load_flags & flag) loadFlags.push(name);
                }
                params.load_flags = loadFlags.join(',');
            }
            if (params.net_error !== undefined && consts.netError && consts.netError[params.net_error]) {
                params.net_error = consts.netError[params.net_error];
            }
        }
    }

    processEvent(event) {
        if (event.time !== undefined && event.type !== undefined && event.phase !== undefined && 
            event.source && event.source.id !== undefined && event.source.type !== undefined) {
            
            event.time = parseInt(event.time, 10);
            const name = event.type;
            const event_type = event.source.type;
            
            if (event_type === 'HOST_RESOLVER_IMPL_JOB' || name.startsWith('HOST_RESOLVER')) {
                this.processDnsEvent(event);
            } else if (event_type === 'CONNECT_JOB' || event_type === 'SSL_CONNECT_JOB' || event_type === 'TRANSPORT_CONNECT_JOB') {
                this.processConnectJobEvent(event);
            } else if (event_type === 'HTTP_STREAM_JOB') {
                this.processStreamJobEvent(event);
            } else if (event_type === 'HTTP2_SESSION') {
                this.processHttp2SessionEvent(event);
            } else if (event_type === 'QUIC_SESSION') {
                this.processQuicSessionEvent(event);
            } else if (event_type === 'SOCKET') {
                this.processSocketEvent(event);
            } else if (event_type === 'UDP_SOCKET') {
                this.processUdpSocketEvent(event);
            } else if (event_type === 'URL_REQUEST') {
                this.processUrlRequestEvent(event);
            } else if (event_type === 'DISK_CACHE_ENTRY') {
                this.processDiskCacheEvent(event);
            }
        }
    }

    processConnectJobEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.connect_job[requestId]) this.netlog.connect_job[requestId] = { created: event.time };
        const entry = this.netlog.connect_job[requestId];
        const params = event.params || {};
        const name = event.type;

        if (name === 'TRANSPORT_CONNECT_JOB_CONNECT' && event.phase === 'PHASE_BEGIN') entry.connect_start = event.time;
        if (name === 'TRANSPORT_CONNECT_JOB_CONNECT' && event.phase === 'PHASE_END') entry.connect_end = event.time;
        if (params.source_dependency && params.source_dependency.id !== undefined) {
            if (name === 'CONNECT_JOB_SET_SOCKET') {
                const socketId = params.source_dependency.id;
                entry.socket = socketId;
                if (this.netlog.socket[socketId]) {
                    if (entry.group !== undefined) this.netlog.socket[socketId].group = entry.group;
                    if (entry.dns !== undefined) this.netlog.socket[socketId].dns = entry.dns;
                }
            }
        }
        if (params.group_name !== undefined) entry.group = params.group_name;
        if (params.group_id !== undefined) entry.group = params.group_id;
    }

    processStreamJobEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.stream_job[requestId]) this.netlog.stream_job[requestId] = { created: event.time };
        const entry = this.netlog.stream_job[requestId];
        const params = event.params || {};
        const name = event.type;

        if (params.group_name !== undefined) entry.group = params.group_name;
        if (params.group_id !== undefined) entry.group = params.group_id;
        if (name === 'HTTP_STREAM_REQUEST_STARTED_JOB') entry.start = event.time;
        if (name === 'TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET') entry.socket_start = event.time;
        
        if (params.source_dependency && params.source_dependency.id !== undefined) {
            if (name === 'SOCKET_POOL_BOUND_TO_SOCKET') {
                const socketId = params.source_dependency.id;
                entry.socket_end = event.time;
                entry.socket = socketId;
                if (entry.url_request !== undefined && this.netlog.url_request[entry.url_request]) {
                    this.netlog.url_request[entry.url_request].socket = socketId;
                    if (entry.group !== undefined) this.netlog.url_request[entry.url_request].group = entry.group;
                }
            }
            if (name === 'HTTP_STREAM_JOB_BOUND_TO_REQUEST') {
                const urlRequestId = params.source_dependency.id;
                entry.url_request = urlRequestId;
                if (entry.socket_end === undefined) entry.socket_end = event.time;
                if (this.netlog.url_request[urlRequestId]) {
                    const urlRequest = this.netlog.url_request[urlRequestId];
                    if (entry.group !== undefined) urlRequest.group = entry.group;
                    if (entry.socket !== undefined) urlRequest.socket = entry.socket;
                    if (entry.h2_session !== undefined) urlRequest.h2_session = entry.h2_session;
                }
            }
            if (name === 'HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET' ||
                name === 'HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION' ||
                name === 'HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION_FROM_IP_POOL') {
                const h2SessionId = params.source_dependency.id;
                entry.h2_session = h2SessionId;
                if (entry.socket_end === undefined) entry.socket_end = event.time;
                if (this.netlog.h2_session[h2SessionId] && this.netlog.h2_session[h2SessionId].socket !== undefined) {
                    entry.socket = this.netlog.h2_session[h2SessionId].socket;
                }
                if (entry.url_request !== undefined && this.netlog.url_request[entry.url_request]) {
                    this.netlog.url_request[entry.url_request].h2_session = h2SessionId;
                }
            }
        }
    }

    processHttp2SessionEvent(event) {
        const sessionId = event.source.id;
        if (!this.netlog.h2_session[sessionId]) this.netlog.h2_session[sessionId] = { stream: {} };
        const entry = this.netlog.h2_session[sessionId];
        const params = event.params || {};
        const name = event.type;

        if (params.source_dependency && params.source_dependency.id !== undefined) {
            if (name === 'HTTP2_SESSION_INITIALIZED') {
                const socketId = params.source_dependency.id;
                entry.socket = socketId;
                if (this.netlog.socket[socketId]) {
                    this.netlog.socket.h2_session = sessionId;
                }
            }
        }
        if (entry.host === undefined && params.host !== undefined) entry.host = params.host;
        if (entry.protocol === undefined && params.protocol !== undefined) entry.protocol = params.protocol;

        if (params.stream_id !== undefined) {
            const streamId = params.stream_id;
            if (!entry.stream[streamId]) entry.stream[streamId] = { bytes_in: 0, chunks: [] };
            const stream = entry.stream[streamId];
            if (params.exclusive !== undefined) stream.exclusive = params.exclusive;
            if (params.parent_stream_id !== undefined) stream.parent_stream_id = params.parent_stream_id;
            if (params.weight !== undefined) stream.weight = params.weight;
            if (params.url !== undefined) {
                stream.url = params.url.split('#')[0];
                if (stream.url_request !== undefined && this.netlog.url_request[stream.url_request]) {
                    this.netlog.url_request[stream.url_request].url = stream.url;
                }
            }
            if (name === 'HTTP2_SESSION_RECV_DATA' && params.size !== undefined) {
                stream.end = event.time;
                if (stream.first_byte === undefined) stream.first_byte = event.time;
                stream.bytes_in += params.size;
                stream.chunks.push({ ts: event.time, bytes: params.size });
            }
            if (name === 'HTTP2_SESSION_SEND_HEADERS') {
                if (stream.start === undefined) stream.start = event.time;
                if (params.headers) stream.request_headers = params.headers;
            }
            if (name === 'HTTP2_SESSION_RECV_HEADERS') {
                if (stream.first_byte === undefined) stream.first_byte = event.time;
                stream.end = event.time;
                if (params.headers) stream.response_headers = params.headers;
            }
            if (name === 'HTTP2_STREAM_ADOPTED_PUSH_STREAM' && params.url !== undefined) {
                const old_request = stream.url_request;
                const url = params.url.split('#')[0];
                let new_request = null;
                for (const [requestId, request] of Object.entries(this.netlog.url_request)) {
                    if (request.url === url && request.start === undefined) {
                        new_request = requestId;
                        break;
                    }
                }
                if (old_request && new_request && old_request !== new_request && 
                    this.netlog.url_request[old_request] && this.netlog.url_request[new_request]) {
                    const oldObj = this.netlog.url_request[old_request];
                    const newObj = this.netlog.url_request[new_request];
                    for (const [k, v] of Object.entries(oldObj)) newObj[k] = v;
                    stream.url_request = new_request;
                    delete this.netlog.url_request[old_request];
                }
            }
        }
        
        if (name === 'HTTP2_SESSION_RECV_PUSH_PROMISE' && params.promised_stream_id !== undefined) {
            const requestId = this.netlog.next_request_id++;
            this.netlog.url_request[requestId] = { bytes_in: 0, chunks: [], created: event.time };
            const request = this.netlog.url_request[requestId];
            const streamId = params.promised_stream_id;
            if (!entry.stream[streamId]) entry.stream[streamId] = { bytes_in: 0, chunks: [] };
            const stream = entry.stream[streamId];
            if (params.headers) {
                stream.request_headers = params.headers;
                let scheme = null, authority = null, path = null;
                for (const header of params.headers) {
                    const sMatch = header.match(/:scheme: (.+)/);
                    if (sMatch) scheme = sMatch[1];
                    const aMatch = header.match(/:authority: (.+)/);
                    if (aMatch) authority = aMatch[1];
                    const pMatch = header.match(/:path: (.+)/);
                    if (pMatch) path = pMatch[1];
                }
                if (scheme && authority && path) {
                    const url = `${scheme}://${authority}${path}`.split('#')[0];
                    request.url = url;
                    stream.url = url;
                }
            }
            request.protocol = 'HTTP/2';
            request.h2_session = sessionId;
            request.stream_id = streamId;
            request.start = event.time;
            request.pushed = true;
            stream.pushed = true;
            stream.url_request = requestId;
            if (entry.socket !== undefined) request.socket = entry.socket;
        }

        if (name === 'HTTP2_SESSION_RECV_SETTING' && params.id !== undefined && params.value !== undefined) {
            const match = params.id.toString().match(/\d+ \((.+)\)/);
            if (match) {
                const settingId = match[1];
                if (!entry.server_settings) entry.server_settings = {};
                entry.server_settings[settingId] = params.value;
            }
        }
    }

    processQuicSessionEvent(event) {
        const sessionId = event.source.id;
        if (!this.netlog.quic_session[sessionId]) this.netlog.quic_session[sessionId] = { stream: {} };
        const entry = this.netlog.quic_session[sessionId];
        const params = event.params || {};
        const name = event.type;

        if (entry.host === undefined && params.host !== undefined) entry.host = params.host;
        if (entry.port === undefined && params.port !== undefined) entry.port = params.port;
        if (entry.version === undefined && params.version !== undefined) entry.version = params.version;
        if (entry.peer_address === undefined && params.peer_address !== undefined) entry.peer_address = params.peer_address;
        if (entry.self_address === undefined && params.self_address !== undefined) entry.self_address = params.self_address;

        if (name === 'QUIC_SESSION_PACKET_SENT' && entry.connect_start === undefined) entry.connect_start = event.time;
        if (name === 'QUIC_SESSION_VERSION_NEGOTIATED' && entry.connect_end === undefined) {
            entry.connect_end = event.time;
            if (params.version !== undefined) entry.version = params.version;
        }
        if (name === 'CERT_VERIFIER_REQUEST' && entry.connect_end !== undefined) {
            if (entry.tls_start === undefined) entry.tls_start = entry.connect_end;
            if (entry.tls_end === undefined) entry.tls_end = event.time;
        }

        if (params.stream_id !== undefined) {
            const streamId = params.stream_id;
            if (!entry.stream[streamId]) entry.stream[streamId] = { bytes_in: 0, chunks: [] };
            const stream = entry.stream[streamId];
            if (name === 'QUIC_CHROMIUM_CLIENT_STREAM_SEND_REQUEST_HEADERS') {
                if (stream.start === undefined) stream.start = event.time;
                if (params.headers) stream.request_headers = params.headers;
            }
            if (name === 'QUIC_CHROMIUM_CLIENT_STREAM_READ_RESPONSE_HEADERS') {
                if (stream.first_byte === undefined) stream.first_byte = event.time;
                stream.end = event.time;
                if (params.headers) stream.response_headers = params.headers;
            }
        }
    }

    processDnsEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.dns[requestId]) this.netlog.dns[requestId] = {};
        const entry = this.netlog.dns[requestId];
        const params = event.params || {};
        const name = event.type;

        if (params.source_dependency && params.source_dependency.id !== undefined) {
            const parentId = params.source_dependency.id;
            if (this.netlog.connect_job[parentId]) {
                this.netlog.connect_job[parentId].dns = requestId;
            }
        }
        if ((name === 'HOST_RESOLVER_IMPL_REQUEST' || name === 'HOST_RESOLVER_DNS_TASK') && event.phase) {
            if (event.phase === 'PHASE_BEGIN') {
                if (entry.start === undefined || event.time < entry.start) entry.start = event.time;
            }
            if (event.phase === 'PHASE_END') {
                if (entry.end === undefined || event.time > entry.end) entry.end = event.time;
            }
        }
        if (entry.start === undefined && (name === 'HOST_RESOLVER_IMPL_ATTEMPT_STARTED' || name === 'HOST_RESOLVER_MANAGER_ATTEMPT_STARTED')) {
            entry.start = event.time;
        }
        if (name === 'HOST_RESOLVER_IMPL_ATTEMPT_FINISHED' || name === 'HOST_RESOLVER_MANAGER_ATTEMPT_FINISHED') {
            entry.end = event.time;
        }
        if (name === 'HOST_RESOLVER_IMPL_CACHE_HIT') {
            if (entry.end === undefined || event.time > entry.end) entry.end = event.time;
        }
        if (entry.host === undefined && params.host !== undefined) entry.host = params.host;
        
        if (name === 'HOST_RESOLVER_DNS_TASK' && params) {
            if (!entry.info) entry.info = {};
            Object.assign(entry.info, params);
        }
        if (name === 'HOST_RESOLVER_DNS_TASK_EXTRACTION_RESULTS' && params.results) {
            let dnsInfo = null;
            for (const result of params.results) {
                if (!dnsInfo && result.domain_name) {
                    const domainName = result.domain_name;
                    if (!this.netlog.dns_info[domainName]) this.netlog.dns_info[domainName] = {};
                    dnsInfo = this.netlog.dns_info[domainName];
                }
                if (result.query_type) {
                    const queryType = result.query_type;
                    if (!dnsInfo[queryType]) dnsInfo[queryType] = {};
                    const response = dnsInfo[queryType];
                    if (result.alias_target) {
                        if (!response.cname) response.cname = [];
                        if (!response.cname.includes(result.alias_target)) response.cname.push(result.alias_target);
                    }
                    if (result.endpoints) {
                        if (!response.addr) response.addr = [];
                        for (const endpoint of result.endpoints) {
                            if (endpoint.address && !response.addr.includes(endpoint.address)) response.addr.push(endpoint.address);
                        }
                    }
                    if (result.error !== undefined) response.error = result.error;
                }
            }
        }
    }

    processSocketEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.socket[requestId]) {
            this.netlog.socket[requestId] = { bytes_out: 0, bytes_in: 0, chunks_out: [], chunks_in: [] };
        }
        const entry = this.netlog.socket[requestId];
        const params = event.params || {};
        const name = event.type;

        if (params.address !== undefined) entry.address = params.address;
        if (params.source_address !== undefined) entry.source_address = params.source_address;
        
        if (entry.connect_start === undefined && name === 'TCP_CONNECT_ATTEMPT' && event.phase === 'PHASE_BEGIN') {
            entry.connect_start = event.time;
        }
        if (name === 'TCP_CONNECT_ATTEMPT' && event.phase === 'PHASE_END') entry.connect_end = event.time;
        
        if (name === 'SSL_CONNECT') {
            if (entry.connect_end === undefined) entry.connect_end = event.time;
            if (entry.ssl_start === undefined && event.phase === 'PHASE_BEGIN') entry.ssl_start = event.time;
            if (event.phase === 'PHASE_END') entry.ssl_end = event.time;
            if (params.version !== undefined) entry.tls_version = params.version;
            if (params.is_resumed !== undefined) entry.tls_resumed = params.is_resumed;
            if (params.next_proto !== undefined) entry.tls_next_proto = params.next_proto;
            if (params.cipher_suite !== undefined) entry.tls_cipher_suite = params.cipher_suite;
        }

        if (name === 'SOCKET_BYTES_SENT' && params.byte_count !== undefined) {
            if (entry.connect_end === undefined) entry.connect_end = event.time;
            entry.bytes_out += params.byte_count;
            entry.chunks_out.push({ ts: event.time, bytes: params.byte_count });
        }
        if (name === 'SOCKET_BYTES_RECEIVED' && params.byte_count !== undefined) {
            entry.bytes_in += params.byte_count;
            entry.chunks_in.push({ ts: event.time, bytes: params.byte_count });
        }
        if (name === 'SSL_CERTIFICATES_RECEIVED' && params.certificates) {
            if (!entry.certificates) entry.certificates = [];
            entry.certificates.push(...params.certificates);
        }
    }

    processUdpSocketEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.socket[requestId]) {
            this.netlog.socket[requestId] = { bytes_out: 0, bytes_in: 0, chunks_out: [], chunks_in: [] };
        }
        const entry = this.netlog.socket[requestId];
        const params = event.params || {};
        const name = event.type;

        if (name === 'UDP_CONNECT' && params.address !== undefined) entry.address = params.address;
        if (name === 'UDP_LOCAL_ADDRESS' && params.address !== undefined) entry.source_address = params.address;
        if (entry.connect_start === undefined && name === 'UDP_CONNECT' && event.phase === 'PHASE_BEGIN') {
            entry.connect_start = event.time;
        }
        if (name === 'UDP_CONNECT' && event.phase === 'PHASE_END') entry.connect_end = event.time;
        if (name === 'UDP_BYTES_SENT' && params.byte_count !== undefined) {
            entry.bytes_out += params.byte_count;
            entry.chunks_out.push({ ts: event.time, bytes: params.byte_count });
        }
        if (name === 'UDP_BYTES_RECEIVED' && params.byte_count !== undefined) {
            entry.bytes_in += params.byte_count;
            entry.chunks_in.push({ ts: event.time, bytes: params.byte_count });
        }
    }

    processUrlRequestEvent(event) {
        const requestId = event.source.id;
        if (!this.netlog.url_request[requestId]) {
            this.netlog.url_request[requestId] = { bytes_in: 0, chunks: [], created: event.time };
        }
        const entry = this.netlog.url_request[requestId];
        const params = event.params || {};
        const name = event.type;

        if (params.priority !== undefined) {
            entry.priority = params.priority;
            if (entry.initial_priority === undefined) entry.initial_priority = params.priority;
        }
        if (params.method !== undefined) entry.method = params.method;
        if (params.url !== undefined) entry.url = params.url.split('#')[0];

        if (entry.start === undefined && name === 'HTTP_TRANSACTION_SEND_REQUEST') entry.start = event.time;
        
        if (params.headers && name === 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS') {
            entry.request_headers = params.headers;
            if (params.line !== undefined) entry.line = params.line;
            if (entry.start === undefined) entry.start = event.time;
        }
        if (params.headers && name === 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS') {
            if (typeof params.headers === 'object' && !Array.isArray(params.headers)) {
                entry.request_headers = [];
                for (const [k, v] of Object.entries(params.headers)) entry.request_headers.push(`${k}: ${v}`);
            } else {
                entry.request_headers = params.headers;
            }
            entry.protocol = 'HTTP/2';
            if (params.line !== undefined) entry.line = params.line;
            if (entry.start === undefined) entry.start = event.time;
        }
        if (params.headers && name === 'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS') {
            if (typeof params.headers === 'object' && !Array.isArray(params.headers)) {
                entry.request_headers = [];
                for (const [k, v] of Object.entries(params.headers)) entry.request_headers.push(`${k}: ${v}`);
            } else {
                entry.request_headers = params.headers;
            }
            if (params.line !== undefined) entry.line = params.line;
            entry.protocol = 'QUIC';
            if (entry.start === undefined) entry.start = event.time;
        }
        if (params.headers && name === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS') {
            entry.response_headers = params.headers;
            if (entry.first_byte === undefined) entry.first_byte = event.time;
            entry.end = event.time;
        }
        if (params.headers && name === 'HTTP_TRANSACTION_READ_EARLY_HINTS_RESPONSE_HEADERS') {
            entry.early_hint_headers = params.headers;
            entry.end = event.time;
        }
        if (params.byte_count !== undefined && name === 'URL_REQUEST_JOB_BYTES_READ') {
            entry.has_raw_bytes = true;
            entry.end = event.time;
            entry.bytes_in += params.byte_count;
            entry.chunks.push({ ts: event.time, bytes: params.byte_count });
        }
        if (params.byte_count !== undefined && name === 'URL_REQUEST_JOB_FILTERED_BYTES_READ') {
            entry.end = event.time;
            if (entry.uncompressed_bytes_in === undefined) entry.uncompressed_bytes_in = 0;
            entry.uncompressed_bytes_in += params.byte_count;
            if (!entry.has_raw_bytes) {
                entry.bytes_in += params.byte_count;
                entry.chunks.push({ ts: event.time, bytes: params.byte_count });
            } else if (entry.chunks.length > 0) {
                entry.chunks[entry.chunks.length - 1].inflated = params.byte_count;
            }
            if (params.bytes !== undefined) {
                try {
                    // Collect base64 chunks directly
                    if (!this.bodies[requestId]) this.bodies[requestId] = [];
                    this.bodies[requestId].push(params.bytes);
                } catch (e) {
                    // Ignore decode errors
                }
            }
        }
        if (params.stream_id !== undefined) entry.stream_id = params.stream_id;
        
        if (name === 'URL_REQUEST_REDIRECTED') {
            const newId = this.netlog.next_request_id++;
            this.netlog.url_request[newId] = entry;
            // Also move bodies over
            if (this.bodies[requestId]) {
                this.bodies[newId] = this.bodies[requestId];
                delete this.bodies[requestId];
            }
            delete this.netlog.url_request[requestId];
            // Remap pointers
            for (const job of Object.values(this.netlog.stream_job)) {
                if (job.url_request === requestId) job.url_request = newId;
            }
            for (const session of Object.values(this.netlog.h2_session)) {
                if (session.stream) {
                    for (const stream of Object.values(session.stream)) {
                        if (stream.url_request === requestId) stream.url_request = newId;
                    }
                }
            }
        }
    }

    processDiskCacheEvent(event) {
        if (event.params && event.params.key) {
            let url = event.params.key;
            const spaceIdx = url.lastIndexOf(' ');
            if (spaceIdx >= 0) url = url.substring(spaceIdx + 1);
            if (!this.netlog.urls[url]) this.netlog.urls[url] = { start: event.time };
        }
    }

    postProcessEvents() {
        if (this.netlog_requests !== null) return this.netlog_requests;
        let requests = [];
        let knownHosts = new Set(['cache.pack.google.com', 'clients1.google.com', 'redirector.gvt1.com']);
        let lastTime = 0;

        for (const [requestId, request] of Object.entries(this.netlog.url_request || {})) {
            request.netlog_id = requestId;
            request.fromNet = (request.start !== undefined);
            if (request.start > lastTime) lastTime = request.start;
            if (request.end > lastTime) lastTime = request.end;

            if (!request.url && request.request_headers) {
                let scheme = null, origin = null, path = null;
                if (request.line) {
                    const match = request.line.match(/^[^\s]+\s([^\s]+)/);
                    if (match) path = match[1];
                }
                if (request.group !== undefined) {
                    scheme = 'http';
                    if (request.group.includes('ssl/')) scheme = 'https';
                } else if (request.socket !== undefined && this.netlog.socket[request.socket]) {
                    const socket = this.netlog.socket[request.socket];
                    scheme = 'http';
                    if (socket.certificates !== undefined || socket.ssl_start !== undefined) scheme = 'https';
                }
                for (const header of request.request_headers) {
                    const colon = header.indexOf(':');
                    if (colon > 0) {
                        const key = header.substring(0, colon).trim().toLowerCase();
                        const val = header.substring(colon + 1).trim();
                        if (key === 'scheme') scheme = val;
                        else if (key === 'host' || key === 'authority') origin = val;
                        else if (key === 'path') path = val;
                    }
                }
                if (scheme && origin && path) {
                    request.url = `${scheme}://${origin}${path}`;
                }
            }

            if (request.url && !request.url.startsWith('http://127.0.0.1') && !request.url.startsWith('http://192.168.10.')) {
                let requestHost;
                try { requestHost = new URL(request.url).hostname; } catch (e) {}
                if (requestHost && !knownHosts.has(requestHost)) knownHosts.add(requestHost);

                if (request.stream_id !== undefined && request.h2_session === undefined && request.url) {
                    for (const [h2SessionId, h2Session] of Object.entries(this.netlog.h2_session || {})) {
                        if (h2Session.host !== undefined) {
                            const sessionHost = h2Session.host.split(':')[0];
                            if (h2Session.stream && h2Session.stream[request.stream_id] && sessionHost === requestHost &&
                                request.request_headers && h2Session.stream[request.stream_id].request_headers) {
                                
                                const stream = h2Session.stream[request.stream_id];
                                let requestPath = null, streamPath = null;
                                for (const h of request.request_headers) if (h.startsWith(':path:')) { requestPath = h; break; }
                                for (const h of stream.request_headers) if (h.startsWith(':path:')) { streamPath = h; break; }

                                if (requestPath && requestPath === streamPath) {
                                    request.h2_session = h2SessionId;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (request.h2_session !== undefined && this.netlog.h2_session[request.h2_session]) {
                const h2Session = this.netlog.h2_session[request.h2_session];
                if (h2Session.socket !== undefined) request.socket = h2Session.socket;
                if (request.stream_id !== undefined && h2Session.stream && h2Session.stream[request.stream_id]) {
                    const stream = h2Session.stream[request.stream_id];
                    if (stream.request_headers !== undefined) request.request_headers = stream.request_headers;
                    if (stream.response_headers !== undefined) request.response_headers = stream.response_headers;
                    if (stream.early_hint_headers !== undefined) request.early_hint_headers = stream.early_hint_headers;
                    if (stream.exclusive !== undefined) request.exclusive = stream.exclusive ? 1 : 0;
                    if (stream.parent_stream_id !== undefined) request.parent_stream_id = stream.parent_stream_id;
                    if (stream.weight !== undefined) {
                        request.weight = stream.weight;
                        if (request.priority === undefined) {
                            if (request.weight >= 256) request.priority = 'Highest';
                            else if (request.weight >= 220) request.priority = 'High';
                            else if (request.weight >= 183) request.priority = 'Medium';
                            else if (request.weight >= 147) request.priority = 'Low';
                            else request.priority = 'Lowest';
                        }
                    }
                    if (request.first_byte === undefined && stream.first_byte !== undefined) request.first_byte = stream.first_byte;
                    if (request.end === undefined && stream.end !== undefined) request.end = stream.end;
                    if (stream.bytes_in > request.bytes_in) {
                        request.bytes_in = stream.bytes_in;
                        request.chunks = stream.chunks;
                    }
                }
            }

            if (request.hash !== undefined) {
                // Not enforcing crypto requirements, WebPageTest hashes body bytes 
                delete request.hash;
            }

            if (request.phantom === undefined && request.request_headers !== undefined) {
                requests.push(request);
            }
        }

        let failedHosts = {};
        for (const [streamJobId, streamJob] of Object.entries(this.netlog.stream_job || {})) {
            if (streamJob.group !== undefined && streamJob.socket_start !== undefined && streamJob.socket === undefined) {
                const match = streamJob.group.match(/^.*\/([^:]+)\:\d+$/);
                if (match) {
                    const groupHost = match[1];
                    if (!knownHosts.has(groupHost) && !failedHosts[groupHost]) {
                        failedHosts[groupHost] = { start: streamJob.socket_start };
                        if (streamJob.socket_end !== undefined) failedHosts[groupHost].end = streamJob.socket_end;
                        else failedHosts[groupHost].end = Math.max(streamJob.socket_start, lastTime);
                    }
                }
            }
        }
        for (const [url, timeObj] of Object.entries(this.netlog.urls || {})) {
            let host;
            try { host = new URL(url).hostname; } catch (e) {}
            if (host && failedHosts[host]) {
                requests.push({
                    url: url,
                    created: failedHosts[host].start,
                    start: failedHosts[host].start,
                    end: failedHosts[host].end,
                    connect_start: failedHosts[host].start,
                    connect_end: failedHosts[host].end,
                    fromNet: true,
                    status: 12029
                });
            }
        }

        if (requests.length > 0) {
            requests.sort((a, b) => (a.start !== undefined ? a.start : a.created) - (b.start !== undefined ? b.start : b.created));
            
            for (const request of requests) {
                if (request.socket !== undefined && this.netlog.socket[request.socket]) {
                    const socket = this.netlog.socket[request.socket];
                    if (socket.address !== undefined) request.server_address = socket.address;
                    if (socket.source_address !== undefined) request.client_address = socket.source_address;
                    if (socket.group !== undefined) request.socket_group = socket.group;
                    
                    if (!socket.claimed) {
                        socket.claimed = true;
                        if (socket.connect_start !== undefined) request.connect_start = socket.connect_start;
                        if (socket.connect_end !== undefined) request.connect_end = socket.connect_end;
                        if (socket.ssl_start !== undefined) request.ssl_start = socket.ssl_start;
                        if (socket.ssl_end !== undefined) request.ssl_end = socket.ssl_end;
                        if (socket.certificates !== undefined) request.certificates = socket.certificates;
                        
                        if (request.h2_session !== undefined && this.netlog.h2_session[request.h2_session]) {
                            const h2Session = this.netlog.h2_session[request.h2_session];
                            if (h2Session.server_settings !== undefined) request.http2_server_settings = h2Session.server_settings;
                        }
                        
                        if (socket.tls_version !== undefined) request.tls_version = socket.tls_version;
                        if (socket.tls_resumed !== undefined) request.tls_resumed = socket.tls_resumed;
                        if (socket.tls_next_proto !== undefined) request.tls_next_proto = socket.tls_next_proto;
                        if (socket.tls_cipher_suite !== undefined) request.tls_cipher_suite = socket.tls_cipher_suite;
                    }
                }
            }

            let dnsLookups = {};
            for (const [dnsId, dns] of Object.entries(this.netlog.dns || {})) {
                if (dns.host !== undefined && dns.start !== undefined && dns.end !== undefined && dns.end >= dns.start) {
                    let hostname = dns.host;
                    let sep = hostname.indexOf('://');
                    if (sep > 0) hostname = hostname.substring(sep + 3);
                    sep = hostname.indexOf(':');
                    if (sep > 0) hostname = hostname.substring(0, sep);
                    
                    dns.elapsed = dns.end - dns.start;
                    if (!dnsLookups[hostname]) dnsLookups[hostname] = dns;
                    
                    if (!dnsLookups[hostname].times) dnsLookups[hostname].times = [];
                    dnsLookups[hostname].times.push({ start: dns.start, end: dns.end, elapsed: dns.elapsed });
                    dnsLookups[hostname].raw_id = dnsId;
                }
            }

            for (const request of requests) {
                if (request.connect_start !== undefined) {
                    let hostname;
                    try { hostname = new URL(request.url).hostname; } catch (e) {}
                    if (hostname && dnsLookups[hostname] && !dnsLookups[hostname].claimed) {
                        const dns = dnsLookups[hostname];
                        dns.claimed = true;
                        if (dns.info !== undefined) request.dns_info = dns.info;
                        
                        if (dns.times) {
                            let maxElapsed = -1;
                            for (const d of dns.times) {
                                let localEnd = Math.min(d.end, request.connect_start);
                                if (localEnd >= d.start) {
                                    let localElapsed = localEnd - d.start;
                                    if (localElapsed > maxElapsed) {
                                        maxElapsed = localElapsed;
                                        request.dns_start = d.start;
                                        request.dns_end = localEnd;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            for (const request of requests) {
                let hostname;
                try { hostname = new URL(request.url).hostname; } catch (e) {}
                if (hostname && dnsLookups[hostname] && !dnsLookups[hostname].claimed) {
                    const dns = dnsLookups[hostname];
                    dns.claimed = true;
                    if (dns.info !== undefined) request.dns_info = dns.info;
                    if (dns.times) {
                        let maxElapsed = -1;
                        for (const d of dns.times) {
                            let localEnd = Math.min(d.end, request.start !== undefined ? request.start : Number.MAX_SAFE_INTEGER);
                            if (localEnd >= d.start) {
                                let localElapsed = localEnd - d.start;
                                if (localElapsed > maxElapsed) {
                                    maxElapsed = localElapsed;
                                    request.dns_start = d.start;
                                    request.dns_end = localEnd;
                                }
                            }
                        }
                    }
                }
            }
            
            for (const request of requests) {
                let hostname;
                try { hostname = new URL(request.url).hostname; } catch (e) {}
                if (hostname && this.netlog.dns_info[hostname]) {
                    request.dns_details = this.netlog.dns_info[hostname];
                }
            }

            const times = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
            for (const request of requests) {
                for (const tname of times) {
                    if (request[tname] !== undefined && this.marked_start_time === null) {
                        if (this.start_time === null || request[tname] < this.start_time) {
                            this.start_time = request[tname];
                        }
                    }
                }
            }

            if (this.start_time !== null) {
                for (const request of requests) {
                    for (const tname of times) {
                        if (request[tname] !== undefined) request[tname] -= this.start_time;
                    }
                    for (const key of ['chunks', 'chunks_in', 'chunks_out']) {
                        if (request[key]) {
                            for (const chunk of request[key]) {
                                if (chunk.ts !== undefined) chunk.ts -= this.start_time;
                            }
                        }
                    }
                }
            } else {
                requests = [];
            }
        }
        
        if (requests.length === 0) requests = null;
        else {
            for (const request of requests) {
                if (request.start !== undefined && request.netlog_id !== undefined) {
                    request.start = request.start + ((request.netlog_id % 10000) / 1000000.0);
                }
                if (this.bodies[request.netlog_id] && this.bodies[request.netlog_id].length > 0) {
                    try {
                        let combinedBase64 = this.bodies[request.netlog_id].join('');
                        request.encoded_body = combinedBase64;
                    } catch (e) {}
                }
            }
        }

        let unlinked_sockets = [];
        for (const [socketId, socket] of Object.entries(this.netlog.socket || {})) {
            if (!socket.claimed) {
                let copy = Object.assign({ _id: socketId }, socket);
                if (this.start_time !== null) {
                    if (copy.connect_start !== undefined) copy.connect_start -= this.start_time;
                    if (copy.connect_end !== undefined) copy.connect_end -= this.start_time;
                    if (copy.ssl_start !== undefined) copy.ssl_start -= this.start_time;
                    if (copy.ssl_end !== undefined) copy.ssl_end -= this.start_time;
                }
                unlinked_sockets.push(copy);
            }
        }

        let unlinked_dns = [];
        for (const [dnsId, dns] of Object.entries(this.netlog.dns || {})) {
            if (!dns.claimed && dns.host !== undefined && dns.start !== undefined) {
                 let copy = Object.assign({ _id: dnsId }, dns);
                 if (this.start_time !== null) {
                     copy.start -= this.start_time;
                     if (copy.end !== undefined) copy.end -= this.start_time;
                 }
                 unlinked_dns.push(copy);
            }
        }

        this.netlog_requests = requests;
        return { requests, unlinked_sockets, unlinked_dns, start_time: this.start_time };
    }
}

export function normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, run_start_epoch) {
    const har = {
        log: {
            version: '1.2',
            creator: {
                name: 'waterfall-tools',
                version: '1.0.0'
            },
            pages: [],
            entries: []
        }
    };

    const dateStr = new Date((run_start_epoch * 1000) || Date.now()).toISOString();
    
    const page = {
        id: 'page_1_0_1',
        title: 'Netlog Default View',
        startedDateTime: dateStr,
        pageTimings: {
            onLoad: -1,
            onContentLoad: -1,
            _startRender: -1
        },
        _unlinked_connections: unlinked_sockets || [],
        _unlinked_dns_lookups: unlinked_dns || []
    };
    
    har.log.pages.push(page);

    if (Array.isArray(requests)) {
        for (const req of requests) {
            let blocked = -1;
            if (req.created >= 0) {
                if (req.dns_start >= req.created) blocked = req.dns_start - req.created;
                else if (req.connect_start >= req.created) blocked = req.connect_start - req.created;
                else if (req.ssl_start >= req.created) blocked = req.ssl_start - req.created;
                else if (req.ttfb_start >= req.created) blocked = req.ttfb_start - req.created;
            }
            const dns = (req.dns_end !== undefined && req.dns_start !== undefined) ? (req.dns_end - req.dns_start) : -1;
            let connect = -1;
            if (req.connect_end !== undefined && req.connect_start !== undefined) {
                connect = req.connect_end - req.connect_start;
            }
            const ssl = (req.ssl_end !== undefined && req.ssl_start !== undefined) ? (req.ssl_end - req.ssl_start) : -1;
            
            const ttfb_start = req.start !== undefined ? req.start : -1;
            const ttfb_end = req.first_byte !== undefined ? req.first_byte : -1;
            const wait = (ttfb_end >= 0 && ttfb_start >= 0 && ttfb_end >= ttfb_start) ? (ttfb_end - ttfb_start) : -1;
            
            const req_end = req.end !== undefined ? req.end : -1;
            const receive = (req_end >= 0 && ttfb_end >= 0 && req_end >= ttfb_end) ? (req_end - ttfb_end) : -1;

            let time = 0;
            if (blocked > 0) time += blocked;
            if (dns > 0) time += dns;
            if (connect > 0) time += connect; 
            if (wait > 0) time += wait;
            if (receive > 0) time += receive;

            const reqHeaders = []; 
            if (req.request_headers) {
                for (const h of req.request_headers) {
                    const colon = h.indexOf(':');
                    if (colon > 0) {
                        reqHeaders.push({name: h.substring(0,colon).trim(), value: h.substring(colon+1).trim()});
                    }
                }
            }
            
            const resHeaders = [];
            let mimeType = '';
            if (req.response_headers) {
                for (const h of req.response_headers) {
                    const colon = h.indexOf(':');
                    if (colon > 0) {
                        const hName = h.substring(0,colon).trim();
                        const hVal = h.substring(colon+1).trim();
                        resHeaders.push({name: hName, value: hVal});
                        if (hName.toLowerCase() === 'content-type') mimeType = hVal;
                    }
                }
            }

            const urlStr = req.url || '';
            let reqStartedDateTime = dateStr;
            if (req.start !== undefined) {
                reqStartedDateTime = new Date(new Date(dateStr).getTime() + req.start).toISOString();
            }

            const content = {
                size: req.bytes_in !== undefined ? parseInt(req.bytes_in) : -1,
                mimeType: mimeType
            };

            if (req.encoded_body !== undefined) {
                content.text = req.encoded_body;
                content.encoding = 'base64';
            }

            const entry = {
                pageref: page.id,
                startedDateTime: reqStartedDateTime,
                time: time,
                request: {
                    method: req.method || 'GET',
                    url: urlStr,
                    httpVersion: req.protocol || '',
                    headersSize: -1,
                    bodySize: -1,
                    cookies: [],
                    headers: reqHeaders,
                    queryString: []
                },
                response: {
                    status: req.responseCode !== undefined ? parseInt(req.responseCode) : -1,
                    statusText: '',
                    httpVersion: req.protocol || '',
                    headersSize: -1,
                    bodySize: req.bytes_in !== undefined ? parseInt(req.bytes_in) : -1,
                    headers: resHeaders,
                    cookies: [],
                    content: content,
                    redirectURL: ''
                },
                cache: {},
                timings: {
                    blocked,
                    dns,
                    connect,
                    ssl,
                    send: 0,
                    wait,
                    receive
                }
            };

            for (const key of Object.keys(req)) {
                if (key !== 'encoded_body') {
                    entry['_' + key] = req[key];
                }
            }
            
            har.log.entries.push(entry);
        }
    }

    return har;
}

function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export async function processNetlogFileNode(input, options = {}) {
    return new Promise((resolve, reject) => {
        let isGz = false;
        let fileStream;

        if (typeof input === 'string') {
            const header = Buffer.alloc(2);
            let fd;
            try {
                fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                return reject(e);
            }
            isGz = isGzip(header);
            fileStream = fs.createReadStream(input);
        } else {
            fileStream = input;
            isGz = options.isGz === true;
        }

        let readStream = fileStream;
        if (isGz) {
            readStream = fileStream.pipe(zlib.createGunzip());
        }

        const rl = readline.createInterface({
            input: readStream,
            crlfDelay: Infinity
        });

        const netlog = new Netlog();
        let started = false;

        rl.on('line', (line) => {
            try {
                line = line.replace(/,\s*$/, '').trim();
                if (!line) return;
                
                if (started) {
                    if (line.startsWith('{')) {
                        const event = JSON.parse(line);
                        netlog.addEvent(event);
                    }
                } else if (line.startsWith('{"constants":')) {
                    const raw = JSON.parse(line + '}');
                    if (raw && raw.constants) {
                        netlog.setConstants(raw.constants);
                    }
                } else if (line.startsWith('"events": [')) {
                    started = true;
                }
            } catch (e) {
                // Silently skip malformed truncated lines as instructed
            }
        });

        rl.on('close', () => {
            try {
                const results = netlog.postProcessEvents();
                let requests = [];
                let unlinked_sockets = [];
                let unlinked_dns = [];
                let start_time = 0;

                if (results) {
                    requests = results.requests || [];
                    unlinked_sockets = results.unlinked_sockets || [];
                    unlinked_dns = results.unlinked_dns || [];
                    start_time = results.start_time || 0;
                }
                const har = normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, start_time);
                resolve(har);
                if (typeof input === 'string') {
                    fileStream.destroy();
                }
            } catch (e) {
                reject(e);
            }
        });

        rl.on('error', reject);
        readStream.on('error', reject);
        fileStream.on('error', reject);
    });
}
