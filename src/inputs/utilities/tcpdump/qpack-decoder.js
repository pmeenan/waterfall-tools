// Static Table from RFC 9204 Appendix A
export const QPACK_STATIC_TABLE = [
    { name: ':authority', value: '' },
    { name: ':path', value: '/' },
    { name: 'age', value: '0' },
    { name: 'content-disposition', value: '' },
    { name: 'content-length', value: '0' },
    { name: 'cookie', value: '' },
    { name: 'date', value: '' },
    { name: 'etag', value: '' },
    { name: 'if-modified-since', value: '' },
    { name: 'if-none-match', value: '' },
    { name: 'last-modified', value: '' },
    { name: 'link', value: '' },
    { name: 'location', value: '' },
    { name: 'referer', value: '' },
    { name: 'set-cookie', value: '' },
    { name: ':method', value: 'CONNECT' },
    { name: ':method', value: 'DELETE' },
    { name: ':method', value: 'GET' },
    { name: ':method', value: 'HEAD' },
    { name: ':method', value: 'OPTIONS' },
    { name: ':method', value: 'POST' },
    { name: ':method', value: 'PUT' },
    { name: ':scheme', value: 'http' },
    { name: ':scheme', value: 'https' },
    { name: ':status', value: '103' },
    { name: ':status', value: '200' },
    { name: ':status', value: '304' },
    { name: ':status', value: '404' },
    { name: ':status', value: '503' },
    { name: 'accept', value: '*/*' },
    { name: 'accept', value: 'application/dns-message' },
    { name: 'accept-encoding', value: 'gzip, deflate, br' },
    { name: 'accept-ranges', value: 'bytes' },
    { name: 'access-control-allow-headers', value: 'cache-control' },
    { name: 'access-control-allow-headers', value: 'content-type' },
    { name: 'access-control-allow-origin', value: '*' },
    { name: 'cache-control', value: 'max-age=0' },
    { name: 'cache-control', value: 'max-age=2592000' },
    { name: 'cache-control', value: 'max-age=604800' },
    { name: 'cache-control', value: 'no-cache' },
    { name: 'cache-control', value: 'no-store' },
    { name: 'cache-control', value: 'public, max-age=31536000' },
    { name: 'content-encoding', value: 'br' },
    { name: 'content-encoding', value: 'gzip' },
    { name: 'content-type', value: 'application/dns-message' },
    { name: 'content-type', value: 'application/javascript' },
    { name: 'content-type', value: 'application/json' },
    { name: 'content-type', value: 'application/x-www-form-urlencoded' },
    { name: 'content-type', value: 'image/gif' },
    { name: 'content-type', value: 'image/jpeg' },
    { name: 'content-type', value: 'image/png' },
    { name: 'content-type', value: 'text/css' },
    { name: 'content-type', value: 'text/html; charset=utf-8' },
    { name: 'content-type', value: 'text/plain' },
    { name: 'content-type', value: 'text/plain;charset=utf-8' },
    { name: 'range', value: 'bytes=0-' },
    { name: 'strict-transport-security', value: 'max-age=31536000' },
    { name: 'strict-transport-security', value: 'max-age=31536000; includesubdomains' },
    { name: 'strict-transport-security', value: 'max-age=31536000; includesubdomains; preload' },
    { name: 'vary', value: 'accept-encoding' },
    { name: 'vary', value: 'origin' },
    { name: 'x-content-type-options', value: 'nosniff' },
    { name: 'x-xss-protection', value: '1; mode=block' },
    { name: ':status', value: '100' },
    { name: ':status', value: '204' },
    { name: ':status', value: '206' },
    { name: ':status', value: '302' },
    { name: ':status', value: '400' },
    { name: ':status', value: '403' },
    { name: ':status', value: '421' },
    { name: ':status', value: '425' },
    { name: ':status', value: '500' },
    { name: 'accept-language', value: '' },
    { name: 'access-control-allow-credentials', value: 'FALSE' },
    { name: 'access-control-allow-credentials', value: 'TRUE' },
    { name: 'access-control-allow-headers', value: '*' },
    { name: 'access-control-allow-methods', value: 'get' },
    { name: 'access-control-allow-methods', value: 'get, post, options' },
    { name: 'access-control-allow-methods', value: 'options' },
    { name: 'access-control-expose-headers', value: 'content-length' },
    { name: 'access-control-request-headers', value: 'content-type' },
    { name: 'access-control-request-method', value: 'get' },
    { name: 'access-control-request-method', value: 'post' },
    { name: 'alt-svc', value: 'clear' },
    { name: 'authorization', value: '' },
    { name: 'content-security-policy', value: 'script-src \'none\'; object-src \'none\'; base-uri \'none\'' },
    { name: 'early-data', value: '1' },
    { name: 'expect-ct', value: '' },
    { name: 'forwarded', value: '' },
    { name: 'if-range', value: '' },
    { name: 'origin', value: '' },
    { name: 'purpose', value: 'prefetch' },
    { name: 'server', value: '' },
    { name: 'timing-allow-origin', value: '*' },
    { name: 'upgradi-insecure-requests', value: '1' },
    { name: 'user-agent', value: '' },
    { name: 'x-forwarded-for', value: '' },
    { name: 'x-frame-options', value: 'deny' },
    { name: 'x-frame-options', value: 'sameorigin' }
];

const ENCODE_TABLE = [
    [13,8184],[23,8388568],[28,268435426],[28,268435427],[28,268435428],[28,268435429],[28,268435430],[28,268435431],[28,268435432],[24,16777194],[30,1073741820],[28,268435433],[28,268435434],[30,1073741821],[28,268435435],
    [28,268435436],[28,268435437],[28,268435438],[28,268435439],[28,268435440],[28,268435441],[28,268435442],[30,1073741822],[28,268435443],[28,268435444],[28,268435445],[28,268435446],[28,268435447],[28,268435448],[28,268435449],[28,268435450],[28,268435451],[6,20],[10,1016],[10,1017],[12,4090],[13,8185],[6,21],[8,248],[11,2042],[10,1018],[10,1019],[8,249],[11,2043],[8,250],[6,22],[6,23],[6,24],[5,0],[5,1],[5,2],[6,25],[6,26],[6,27],
    [6,28],[6,29],[6,30],[6,31],[7,92],[8,251],[15,32764],[6,32],[12,4091],[10,1020],[13,8186],[6,33],[7,93],[7,94],[7,95],[7,96],[7,97],[7,98],[7,99],[7,100],[7,101],[7,102],[7,103],[7,104],[7,105],[7,106],[7,107],[7,108],[7,109],[7,110],[7,111],[7,112],[7,113],[7,114],[8,252],[7,115],[8,253],[13,8187],[19,524272],[13,8188],[14,16380],[6,34],[15,32765],[5,3],[6,35],[5,4],[6,36],[5,5],[6,37],[6,38],[6,39],[5,6],[7,116],[7,117],[6,40],[6,41],[6,42],[5,7],[6,43],[7,118],[6,44],[5,8],[5,9],[6,45],[7,119],[7,120],[7,121],[7,122],[7,123],[15,32766],[11,2044],[14,16381],[13,8189],[28,268435452],[20,1048550],[22,4194258],[20,1048551],[20,1048552],[22,4194259],[22,4194260],[22,4194261],[23,8388569],[22,4194262],[23,8388570],[23,8388571],[23,8388572],[23,8388573],[23,8388574],[24,16777195],[23,8388575],[24,16777196],[24,16777197],[22,4194263],[23,8388576],[24,16777198],[23,8388577],[23,8388578],[23,8388579],[23,8388580],[21,2097116],[22,4194264],[23,8388581],[22,4194265],[23,8388582],[23,8388583],[24,16777199],[22,4194266],[21,2097117],[20,1048553],[22,4194267],[22,4194268],[23,8388584],[23,8388585],[21,2097118],[23,8388586],[22,4194269],[22,4194270],[24,16777200],[21,2097119],[22,4194271],[23,8388587],[23,8388588],[21,2097120],[21,2097121],[22,4194272],[21,2097122],[23,8388589],[22,4194273],[23,8388590],[23,8388591],[20,1048554],[22,4194274],[22,4194275],[22,4194276],[23,8388592],[22,4194277],[22,4194278],[23,8388593],[26,67108832],[26,67108833],[20,1048555],[19,524273],[22,4194279],[23,8388594],[22,4194280],[25,33554412],[26,67108834],[26,67108835],[26,67108836],[27,134217694],[27,134217695],[26,67108837],[24,16777201],[25,33554413],[19,524274],[21,2097123],[26,67108838],[27,134217696],[27,134217697],[26,67108839],[27,134217698],[24,16777202],[21,2097124],[21,2097125],[26,67108840],[26,67108841],[28,268435453],[27,134217699],[27,134217700],[27,134217701],[20,1048556],[24,16777203],[20,1048557],[21,2097126],[22,4194281],[21,2097127],[21,2097128],[23,8388595],[22,4194282],[22,4194283],[25,33554414],[25,33554415],[24,16777204],[24,16777205],[26,67108842],[23,8388596],[26,67108843],[27,134217702],[26,67108844],[26,67108845],[27,134217703],[27,134217704],[27,134217705],[27,134217706],[27,134217707],[28,268435454],[27,134217708],[27,134217709],[27,134217710],[27,134217711],[27,134217712],[26,67108846],[30,1073741823]
];

class HuffmanNode {
    constructor() {
        this.children = []; // 0 or 1
        this.symbol = -1; // -1 if non-leaf
    }
}

const huffRoot = new HuffmanNode();
for (let i = 0; i < ENCODE_TABLE.length; i++) {
    const [bits, code] = ENCODE_TABLE[i];
    let node = huffRoot;
    for (let b = bits - 1; b >= 0; b--) {
        const bit = (code >>> b) & 1;
        if (!node.children[bit]) node.children[bit] = new HuffmanNode();
        node = node.children[bit];
    }
    node.symbol = i;
}

function decodeHuffman(buffer) {
    let node = huffRoot;
    let decoded = [];
    for (let i = 0; i < buffer.length; i++) {
        const b = buffer[i];
        for (let bit = 7; bit >= 0; bit--) {
            const val = (b >>> bit) & 1;
            node = node.children[val];
            if (!node) throw new Error("Invalid Huffman sequence");
            if (node.symbol !== -1) {
                if (node.symbol === 256) break; // EOS
                decoded.push(node.symbol);
                node = huffRoot;
            }
        }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(decoded));
}

export class QpackDecoder {
    constructor() {
        this.dynamicTable = [];
        this.dynamicTableCapacity = 0;
        this.insertsCount = 0;
    }

    readInt(buffer, offset, prefixBits, firstByteMask) {
        if (offset >= buffer.length) return null;
        let v = buffer[offset] & firstByteMask;
        const maxPrefix = (1 << prefixBits) - 1;
        
        if (v < maxPrefix) {
            return { value: v, newOffset: offset + 1 };
        }
        
        let m = 0;
        let p = offset + 1;
        
        while (p < buffer.length) {
            const b = buffer[p++];
            v += (b & 0x7F) << m;
            m += 7;
            if ((b & 0x80) === 0) {
                return { value: v, newOffset: p };
            }
        }
        return null;
    }

    readString(buffer, offset, prefixBits, firstByteMask) {
        if (offset >= buffer.length) return null;
        const isHuffman = (buffer[offset] & (1 << prefixBits)) !== 0;
        const res = this.readInt(buffer, offset, prefixBits, firstByteMask);
        if (!res) return null;
        
        const len = res.value;
        const strOffset = res.newOffset;
        if (strOffset + len > buffer.length) return null;
        
        const stringBuffer = buffer.subarray(strOffset, strOffset + len);
        
        let stringVal;
        if (isHuffman) {
            try {
                stringVal = decodeHuffman(stringBuffer);
            } catch (e) {
                // Graceful fallback for malformed decoding strings 
                const decoder = new TextDecoder('utf8');
                stringVal = decoder.decode(stringBuffer);
            }
        } else {
            const decoder = new TextDecoder('utf8');
            stringVal = decoder.decode(stringBuffer);
        }
        
        return { value: stringVal, newOffset: strOffset + len };
    }

    processEncoder(buffer) {
        // Parses Stream ID `0x02`
        let offset = 0;
        while (offset < buffer.length) {
            const b = buffer[offset];
            
            if ((b & 0x80) === 0x80) {
                // Insert with Name Reference (T=1, Static=0/1)
                const isStatic = (b & 0x40) !== 0;
                const nameRes = this.readInt(buffer, offset, 6, 0x3F);
                if (!nameRes) break;
                
                const valRes = this.readString(buffer, nameRes.newOffset, 7, 0x7F);
                if (!valRes) break;
                
                const nameStr = isStatic ? QPACK_STATIC_TABLE[nameRes.value].name : (this.dynamicTable[nameRes.value] ? this.dynamicTable[nameRes.value].name : 'unknown');
                this.dynamicTable.push({ name: nameStr, value: valRes.value });
                offset = valRes.newOffset;
            } else if ((b & 0x40) === 0x40) {
                // Insert with Literal Name (T=0, NameLength)
                const nameRes = this.readString(buffer, offset, 5, 0x1F);
                if (!nameRes) break;
                
                const valRes = this.readString(buffer, nameRes.newOffset, 7, 0x7F);
                if (!valRes) break;
                
                this.dynamicTable.push({ name: nameRes.value, value: valRes.value });
                offset = valRes.newOffset;
            } else if ((b & 0x20) === 0x20) {
                // Set Dynamic Table Capacity
                const capRes = this.readInt(buffer, offset, 5, 0x1F);
                if (!capRes) break;
                this.dynamicTableCapacity = capRes.value;
                offset = capRes.newOffset;
            } else {
                // Duplicate
                const dupRes = this.readInt(buffer, offset, 5, 0x1F);
                if (!dupRes) break;
                if (this.dynamicTable[dupRes.value]) {
                    this.dynamicTable.push({ ...this.dynamicTable[dupRes.value] });
                }
                offset = dupRes.newOffset;
            }
        }
    }

    decodeHeaders(buffer) {
        let offset = 0;
        const headers = [];
        
        // Decode Header Block Prefix
        const reqInsertRes = this.readInt(buffer, offset, 8, 0xFF);
        if (!reqInsertRes) return headers;
        offset = reqInsertRes.newOffset;
        
        const baseRes = this.readInt(buffer, offset, 7, 0x7F); // s bit is highest
        if (!baseRes) return headers;
        offset = baseRes.newOffset;

        while (offset < buffer.length) {
            const b = buffer[offset];
            
            if ((b & 0x80) === 0x80) {
                // Indexed Field Line
                const isStatic = (b & 0x40) !== 0;
                const idxRes = this.readInt(buffer, offset, 6, 0x3F);
                if (!idxRes) break;
                
                const entry = isStatic ? QPACK_STATIC_TABLE[idxRes.value] : this.dynamicTable[this.dynamicTable.length - 1 - idxRes.value]; // dynamic is relative to base
                if (entry) headers.push(entry);
                offset = idxRes.newOffset;
            } else if ((b & 0xC0) === 0x40) {
                // Literal Field Line with Name Reference
                const isStatic = (b & 0x10) !== 0;
                const nameRes = this.readInt(buffer, offset, 4, 0x0F);
                if (!nameRes) break;
                
                const valRes = this.readString(buffer, nameRes.newOffset, 7, 0x7F);
                if (!valRes) break;

                const nameStr = isStatic ? (QPACK_STATIC_TABLE[nameRes.value] ? QPACK_STATIC_TABLE[nameRes.value].name : 'unknown') : (this.dynamicTable[this.dynamicTable.length - 1 - nameRes.value] ? this.dynamicTable[this.dynamicTable.length - 1 - nameRes.value].name : 'unknown');
                headers.push({ name: nameStr, value: valRes.value });
                offset = valRes.newOffset;
            } else if ((b & 0xE0) === 0x20) {
                // Literal Field Line with Literal Name
                const nameRes = this.readString(buffer, offset, 3, 0x07);
                if (!nameRes) break;
                
                const valRes = this.readString(buffer, nameRes.newOffset, 7, 0x7F);
                if (!valRes) break;
                
                headers.push({ name: nameRes.value, value: valRes.value });
                offset = valRes.newOffset;
            } else if ((b & 0xF0) === 0x10) {
                // Indexed Field Line With Post-Base Index
                const idxRes = this.readInt(buffer, offset, 4, 0x0F);
                if (!idxRes) break;
                
                // Approximate post-base mapping
                const entry = this.dynamicTable[this.dynamicTable.length - 1 - idxRes.value] || { name: 'unknown', value: 'unknown' };
                headers.push(entry);
                offset = idxRes.newOffset;
            } else {
                // Literal Field Line With Name Reference / Post-Base
                const idxRes = this.readInt(buffer, offset, 3, 0x07);
                if (!idxRes) break;
                const valRes = this.readString(buffer, idxRes.newOffset, 7, 0x7F);
                if (!valRes) break;
                
                const nameStr = this.dynamicTable[this.dynamicTable.length - 1 - idxRes.value] ? this.dynamicTable[this.dynamicTable.length - 1 - idxRes.value].name : 'unknown';
                headers.push({ name: nameStr, value: valRes.value });
                offset = valRes.newOffset;
            }
        }
        
        return headers;
    }
}
