// QR codes (ISO/IEC 18004, model 2) for the links Notchy shows when it shares
// files with a phone. Pure logic without GNOME imports: byte mode, the four
// error correction levels, versions 1–40, all eight masks scored by the
// standard's penalty rules. tests/test_qrcode.py checks the output with a
// real decoder (zbar). qrEncode(text) → {size, modules} with modules[y][x]
// true for a dark module, without the quiet zone (four light modules around
// it are the reader's due).

const ECC_CODEWORDS = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const ECC_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
// The level's two bits in the format information.
const FORMAT_BITS = {L: 1, M: 0, Q: 3, H: 2};

// Modules for data and error correction in a version (all but the function patterns).
export function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const align = Math.floor(version / 7) + 2;
        result -= (25 * align - 10) * align - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}
export const dataCodewords = (version, ecl) => Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS[ecl][version] * ECC_BLOCKS[ecl][version];
// Bits of the character count in byte mode.
const countBits = version => (version < 10 ? 8 : 16);

// GF(2^8) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
function multiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}
function divisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = multiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = multiply(root, 0x02);
    }
    return result;
}
export function remainder(data, div) {
    const result = new Array(div.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        div.forEach((coef, i) => { result[i] ^= multiply(coef, factor); });
    }
    return result;
}

// The codewords with their error correction, split into blocks and interleaved.
function interleave(data, version, ecl) {
    const blocks = ECC_BLOCKS[ecl][version], eccLength = ECC_CODEWORDS[ecl][version], raw = Math.floor(rawDataModules(version) / 8);
    const shortBlocks = blocks - raw % blocks, shortLength = Math.floor(raw / blocks), div = divisor(eccLength);
    const parts = [];
    for (let i = 0, k = 0; i < blocks; i++) {
        const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
        const block = data.slice(k, k + length); k += length;
        const ecc = remainder(block, div);
        if (i < shortBlocks) block.push(0);
        parts.push([...block, ...ecc]);
    }
    const result = [];
    for (let i = 0; i < parts[0].length; i++) {
        parts.forEach((part, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(part[i]); });
    }
    return result;
}

function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2, size = version * 4 + 17;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
}

class Matrix {
    constructor(version) {
        this.version = version; this.size = version * 4 + 17;
        this.modules = Array.from({length: this.size}, () => new Array(this.size).fill(false));
        this.function = Array.from({length: this.size}, () => new Array(this.size).fill(false));
    }
    set(x, y, dark) { this.modules[y][x] = dark; this.function[y][x] = true; }
    patterns() {
        const {size} = this;
        for (let i = 0; i < size; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
        for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
            for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
                const xx = x + dx, yy = y + dy, distance = Math.max(Math.abs(dx), Math.abs(dy));
                if (xx >= 0 && xx < size && yy >= 0 && yy < size) this.set(xx, yy, distance !== 2 && distance !== 4);
            }
        }
        const align = alignmentPositions(this.version), last = align.length - 1;
        align.forEach((ay, i) => align.forEach((ax, j) => {
            if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }));
        this.format('M', 0);
        if (this.version >= 7) {
            let rem = this.version;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
            const bits = (this.version << 12) | rem;
            for (let i = 0; i < 18; i++) {
                const dark = ((bits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3);
                this.set(a, b, dark); this.set(b, a, dark);
            }
        }
    }
    format(ecl, mask) {
        const data = (FORMAT_BITS[ecl] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412, bit = i => ((bits >>> i) & 1) !== 0, {size} = this;
        for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
        this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
        this.set(8, size - 8, true);
    }
    codewords(data) {
        const {size} = this;
        let i = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
                const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
                if (!this.function[y][x] && i < data.length * 8) { this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
            }
        }
    }
    mask(mask) {
        const {size} = this;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (this.function[y][x]) continue;
            let invert;
            switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
            case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
            default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
            }
            if (invert) this.modules[y][x] = !this.modules[y][x];
        }
    }
    // The standard's four penalty rules: runs, 2×2 blocks, finder-like patterns, balance.
    penalty() {
        const {size, modules} = this;
        let score = 0, dark = 0;
        const lines = [];
        for (let i = 0; i < size; i++) { lines.push(modules[i]); lines.push(modules.map(row => row[i])); }
        for (const line of lines) {
            let run = 1;
            for (let i = 1; i <= size; i++) {
                if (i < size && line[i] === line[i - 1]) { run++; continue; }
                if (run >= 5) score += run - 2;
                run = 1;
            }
            const text = line.map(m => (m ? '1' : '0')).join('');
            for (const pattern of ['10111010000', '00001011101']) for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
        }
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
            const c = modules[y][x];
            if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
        for (const row of modules) for (const m of row) if (m) dark++;
        const total = size * size;
        score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return score;
    }
}

// text → {size, modules, version, ecl, mask}. The smallest version that holds
// it at `ecl` (or better, when the same version allows it); null when too long.
export function qrEncode(text, {ecl = 'M', minVersion = 1, boost = true} = {}) {
    const bytes = [...new TextEncoder().encode(String(text))];
    let version = 0;
    for (let v = minVersion; v <= 40; v++) {
        if (4 + countBits(v) + bytes.length * 8 <= dataCodewords(v, ecl) * 8) { version = v; break; }
    }
    if (!version) return null;
    const needed = 4 + countBits(version) + bytes.length * 8;
    if (boost) for (const better of ['M', 'Q', 'H']) if ('LMQH'.indexOf(better) > 'LMQH'.indexOf(ecl) && needed <= dataCodewords(version, better) * 8) ecl = better;
    // Mode, count, the bytes; terminator, byte alignment, pad codewords.
    const bits = [];
    const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(0b0100, 4); put(bytes.length, countBits(version));
    for (const b of bytes) put(b, 8);
    const capacity = dataCodewords(version, ecl) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    const codewords = interleave(data, version, ecl);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const matrix = new Matrix(version);
        matrix.patterns(); matrix.codewords(codewords); matrix.mask(mask); matrix.format(ecl, mask);
        const score = matrix.penalty();
        if (!best || score < best.score) best = {score, matrix, mask};
    }
    return {size: best.matrix.size, modules: best.matrix.modules, version, ecl, mask: best.mask};
}
