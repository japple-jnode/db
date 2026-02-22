/*
@jnode/db/dble.js

Simple database package for Node.js.

JDB Lite Extended (DBLE) is a simple, fast and extensiable database format.

by JustApple & Google Gemini
*/

// load class
const { JDBFile } = require('./jdb.js');

// dble file manager
class DBLEFile {
    constructor(jdb, options = {}) {
        this.jdb = jdb;
        this.options = options;
        this._lineCache = new Map();
        this.types = Object.assign({}, defaultDBLETypes, options.types);
        this.jdb.handle.on('close', () => {
            console.log('closed');
        })
    }

    static async load(path, options = {}) {
        const jdb = await JDBFile.load(path);

        if (jdb.dbType !== 0x44424C45) throw new Error('JDB (DBLE): DBType is not "DBLE".'); // db type
        if (jdb.dbVersion !== 1) throw new Error('JDB (DBLE): Unsupported DBLE DBVersion.'); // db version

        const dble = new DBLEFile(jdb, options);
        await dble._loadHead();
        await dble._loadIndices();

        return dble;
    }

    static async create(path, options = {}) {
        const jdb = await JDBFile.create(path, {
            dbType: 0x44424C45,
            dbVersion: 1
        });

        const dble = new DBLEFile(jdb, options);
        await dble._init(options);

        return dble;
    }

    static async forceCreate(path, options = {}) {
        const jdb = await JDBFile.forceCreate(path, {
            dbType: 0x44424C45,
            dbVersion: 1
        });

        const dble = new DBLEFile(jdb, options);
        await dble._init(options);

        return dble;
    }

    async _init(options = {}) {
        if (!options.fields) throw new Error('`options.fields` is required.');

        this.fields = options.fields;
        this.fieldsMap = {};
        this.fieldOffsets = {};
        this.indices = {};

        // generate definitions
        const dbHeadBufs = [];
        let dbHeadLength = 22;
        let dbLineLength = 6;
        for (let i = 0; i < options.fields.length; i++) {
            const def = options.fields[i];

            if (this.fieldOffsets[def.name]) throw new Error('Could not have two fields in the same name.');
            this.fieldOffsets[def.name] = dbLineLength;
            this.fieldsMap[def.name] = def;
            if (def.isKey) this.indices[def.name] = new Map(); // set index

            const definitionBuf = def.toDefinitionBuffer(i === options.fields.length - 1);
            dbHeadBufs.push(definitionBuf);
            dbHeadLength += definitionBuf.length;
            dbLineLength += def.length;
        }

        this.extOffset = dbLineLength;

        // calculate ext field length
        let n = dbLineLength + 1 + (options.extBaseLength ?? 0);
        n |= n >> 1;
        n |= n >> 2;
        n |= n >> 4;
        n |= n >> 8;
        n |= n >> 16;
        n = n + 1;

        let extBaseLength = n - dbLineLength;
        this.extBaseLength = extBaseLength;
        this.lineLength = n;

        // padding
        const dbHeadPadBuf = Buffer.alloc(((dbHeadLength + n - 1) & ~(n - 1)) - dbHeadLength + 6);
        dbHeadPadBuf.writeUInt16LE(extBaseLength); // extend field base length
        dbHeadPadBuf.writeUInt32LE(0xFFFFFFFF, 2); // last empty line
        dbHeadBufs.push(dbHeadPadBuf);
        this.lastEmptyLine = 0xFFFFFFFF;
        this.lastEmptyLineOffset = dbHeadLength - 4;

        // write to file
        const dbHeadBuf = Buffer.concat(dbHeadBufs);
        this.bodyOffset = 16 + dbHeadBuf.length;
        await this.jdb.handle.write(dbHeadBuf, 0, undefined, 16);
    }

    async _loadHead() {
        const handle = this.jdb.handle;

        this.fields = [];
        this.fieldsMap = {};
        this.fieldOffsets = {};
        this.indices = {};
        this.bodyOffset = 16;

        // parse definitions
        let fieldIsLast = false;
        let fieldIsKey = false;
        let fieldLength = 0;
        let fieldType = 'null';
        let fieldName = 'null';

        let dbLineLength = 6;

        const readBytes = async (len) => {
            const buf = Buffer.allocUnsafe(len);
            const { bytesRead } = await handle.read(buf, 0, len, this.bodyOffset);
            if (bytesRead !== len) throw new Error('JDB (DBLE): Fail to parse the file.');
            this.bodyOffset += len;
            return buf;
        };

        while (!fieldIsLast) {
            let bytesRead;

            // load flags and field length
            const flagLenBuf = await readBytes(4);
            const fieldFlags = flagLenBuf.readUInt16BE();
            fieldIsLast = fieldFlags & 1;
            fieldIsKey = fieldFlags & (1 << 1);
            fieldLength = flagLenBuf.readUInt16LE(2);

            // load type
            const typeLenBuf = await readBytes(1);
            fieldType = (await readBytes(typeLenBuf[0])).toString('utf8');

            // load name
            const nameLenBuf = await readBytes(1);
            fieldName = (await readBytes(nameLenBuf[0])).toString('utf8');

            // save fields
            const FieldType = this.types[fieldType] || DBLEAnyField;
            const field = new FieldType;
            field.isKey = !!fieldIsKey;
            field.length = fieldLength;
            field.type = fieldType;
            field.name = fieldName;
            this.fields.push(field);

            if (this.fieldOffsets[fieldName]) throw new Error('JDB (DBLE): Fail to parse the file, could not have two fields in the same name.');
            this.fieldOffsets[fieldName] = dbLineLength;
            this.fieldsMap[fieldName] = field;
            if (fieldIsKey) this.indices[fieldName] = new Map(); // set index

            dbLineLength += fieldLength;
        }

        const eblLelBuf = await readBytes(6);
        this.extBaseLength = eblLelBuf.readUInt16LE();
        this.extOffset = dbLineLength;
        this.lineLength = dbLineLength += this.extBaseLength;
        this.lastEmptyLine = eblLelBuf.readUInt32LE(2);
        this.lastEmptyLineOffset = this.bodyOffset - 4;
        let dbHeadLength = this.bodyOffset;

        // calculate padding
        this.bodyOffset += ((dbHeadLength + dbLineLength - 1) & ~(dbLineLength - 1)) - dbHeadLength;
    }

    // close file handle
    close() {
        return this.jdb.close();
    }

    // load indices
    async _loadIndices() {
        for await (let { chunk, line } of this._readlines()) {
            for (let i in this.indices) {
                this.indices[i].set(this._getFieldFromLine(chunk, i), line);
            }
        }
    }

    // simple task queue
    _doTask(func, skipQueue) {
        if (skipQueue) return func();
        return this._task = (async () => {
            try { await this._task; } catch { }
            return await func();
        })();
    }

    _setLineCache(line, buf) {
        this._lineCache.set(line, buf);

        // remove last added cache
        if (this._lineCache.size > (this.options.maxLineCache || 512)) {
            this._lineCache.delete(this._lineCache.keys().next().value);
        }
    }

    // get a line's buffer
    async _getLineBuffer(line) {
        if (typeof line !== 'number') throw new TypeError('line must be an integer.');

        // already in cache
        if (this._lineCache.has(line)) return this._lineCache.get(line);

        // read line
        const lineBuf = Buffer.allocUnsafe(this.lineLength);
        await this.jdb.handle.read(lineBuf, 0, this.lineLength, this.bodyOffset + line * this.lineLength);

        // add to cache
        this._setLineCache(line, lineBuf);

        return lineBuf;
    }

    // write a buffer to line
    async _writeLineBuffer(line, buf, offset) {
        if (typeof line !== 'number') throw new TypeError('line must be an integer.');
        if (!Buffer.isBuffer(buf)) throw new TypeError('buf must be a buffer.');

        // write line
        await this.jdb.handle.write(buf, offset, this.lineLength, this.bodyOffset + line * this.lineLength);

        // add to cache
        this._setLineCache(line, buf);

        return;
    }

    // append a line
    async _appendLineBuffer(buf, offset) {
        if (!Buffer.isBuffer(buf)) throw new TypeError('buf must be a buffer.');

        let targetLine = this.lastEmptyLine;
        if (targetLine === 0xFFFFFFFF) { // no empty lines
            const { size } = await this.jdb.handle.stat();

            // write line
            await this.jdb.handle.write(buf, offset, this.lineLength, size);

            // add to cache
            this._setLineCache((size - this.bodyOffset) / this.lineLength, buf);
        } else { // empty line
            const lineBuf = await this._getLineBuffer(targetLine);
            this.lastEmptyLine = lineBuf.readUInt32LE(2);
            await this._writeLineBuffer(targetLine, buf);

            // write back the last empty line
            const lastEmptyLineBuf = Buffer.allocUnsafe(4);
            lastEmptyLineBuf.writeUInt32LE(this.lastEmptyLine);
            await this.jdb.handle.write(lastEmptyLineBuf, 0, 4, this.lastEmptyLineOffset);
        }

        // update indecies
        for (let i in this.indices) {
            this.indices[i].set(this._getFieldFromLine(buf, i), targetLine);
        }

        return targetLine;
    }

    async _getLastEmptyLine(after) {
        if ((typeof after !== 'number') && (this.lastEmptyLine !== 0xFFFFFFFF)) return this.lastEmptyLine;

        const { size } = await this.jdb.handle.stat();
        const newLine = (size - this.bodyOffset) / this.lineLength;

        if (typeof after === 'number') {
            if (after >= newLine) return after + 1;
            const lineBuf = await this._getLineBuffer(after);
            const next = lineBuf.readUInt32LE(2);
            if (next !== 0xFFFFFFFF) return next;
        }

        return newLine;
    }

    _getFieldFromLine(buf, field) {
        return this.fieldsMap[field].parse(buf, this.fieldOffsets[field]);
    }

    _setFieldsToLine(buf, fields) {
        for (let field in fields) {
            this.fieldsMap[field].write(fields[field], buf, this.fieldOffsets[field]);
        }
        return buf;
    }

    async _clearLinesFrom(line) {
        if (line === 0xFFFFFFFF) return;

        let lineBuf;
        let nextLine = line;

        const clearedBuf = Buffer.alloc(this.lineLength);
        clearedBuf[0] = 0b10 << 6;

        while (nextLine !== 0xFFFFFFFF) {
            lineBuf = await this._getLineBuffer(nextLine);

            if (lineBuf[0] === (0b11 << 6)) { // remove from index
                for (let i in this.indices) {
                    this.indices[i].delete(this._getFieldFromLine(lineBuf, i));
                }
            }

            clearedBuf.writeUInt32LE(this.lastEmptyLine, 2);
            this.lastEmptyLine = nextLine;
            await this._writeLineBuffer(nextLine, clearedBuf);
            this._lineCache.delete(nextLine);
            nextLine = lineBuf.readUInt32LE(2);
        }

        // write back the last empty line
        const lastEmptyLineBuf = Buffer.allocUnsafe(4);
        lastEmptyLineBuf.writeUInt32LE(this.lastEmptyLine);
        await this.jdb.handle.write(lastEmptyLineBuf, 0, 4, this.lastEmptyLineOffset);
    }

    async * _readlines(start = 0, end, startLineOnly = true) {
        let line = start;
        const bufSize = this.options.scanBufferSize || 512;
        let chunkLine = 0;
        let chunk = Buffer.allocUnsafe(bufSize * this.lineLength);
        let chunkSize = 0;
        while (true) {
            if (end !== undefined && line >= end) return;
            if (chunkLine === chunkSize) {
                const { bytesRead } = await this.jdb.handle.read(chunk, 0, chunk.length, this.bodyOffset + line * this.lineLength);
                chunkSize = bytesRead / this.lineLength;
                if (bytesRead % this.lineLength !== 0) throw new Error('JDB (DBLE): File broken.');
                if (bytesRead === 0) return;
                chunkLine = 0;
                continue;
            }

            const lineChunk = chunk.subarray(chunkLine * this.lineLength, (chunkLine + 1) * this.lineLength);

            line++;
            chunkLine++;

            if (startLineOnly && ((lineChunk[0] & (0b11 << 6)) !== (0b00 << 6))) continue;
            yield { chunk: lineChunk, line: line - 1 };
        }
    }

    _parseLine(buf) {
        const lineType = buf[0] & (0b11 << 6);
        const nextLine = buf.readUInt32LE(2);
        const line = { type: lineType };

        if (line.type === 0b00) { // normal start
            line.nextLine = nextLine;

            line.fields = {};
            for (let i in this.fieldsMap) {
                line.fields[i] = this._getFieldFromLine(buf, i);
            }
        } else if (line.type === 0b01) { // extended (this function does not parse extended lines)
            line.nextLine = nextLine;
        } else if (line.type === 0b10) {
            line.lastEmptyLine = nextLine;
        }

        return line;
    }

    // get field from line
    getField(line, field, skipQueue) {
        return this._doTask(async () => {
            return this._getFieldFromLine(await this._getLineBuffer(line), field);
        }, skipQueue);
    }

    getExt(line, skipQueue) {
        return this._doTask(async () => {
            let extBufs = [];
            let lineBuf;
            let nextLine = line;
            let length;
            let lengthRead = 0;

            while (nextLine !== 0xFFFFFFFF) {
                if (length === lengthRead) {
                    await this._clearLinesFrom(nextLine);
                    break;
                }

                lineBuf = await this._getLineBuffer(nextLine);
                nextLine = lineBuf.readUInt32LE(2);

                if (extBufs.length === 0) {
                    length = lineBuf.readUInt16LE(this.extOffset);
                    const extBufPart = lineBuf.subarray(this.extOffset + 2, Math.min(this.extOffset + 2 + length, lineBuf.length));
                    lengthRead += extBufPart.length;
                    extBufs.push(extBufPart);
                } else {
                    const extBufPart = lineBuf.subarray(6, Math.min(6 + length - lengthRead, lineBuf.length));
                    lengthRead += extBufPart.length;
                    extBufs.push(extBufPart);
                }
            }

            return Buffer.concat(extBufs);
        }, skipQueue);
    }

    getLineByField(field, query, skipQueue) {
        if (this.indices[field]) {
            return this.indices[field].get(query);
        } else {
            return this._doTask(async () => {
                for await (let { buf, line } of this._readlines()) {
                    if (this._getFieldFromLine(buf, field) === query) return line;
                }
            }, skipQueue);
        }
    }

    findLine(fn, skipQueue) {
        return this._doTask(async () => {
            for await (let { buf, line } of this._readlines()) {
                const parsed = this._parseLine(buf);
                if (await fn(parsed)) return line;
            }
        }, skipQueue);
    }

    forEachLine(fn, start, to, skipQueue) {
        return this._doTask(async () => {
            for await (let { buf, line } of this._readlines(start, to)) {
                const parsed = this._parseLine(buf);
                await fn(parsed, line);
            }
        }, skipQueue);
    }

    setLine(line, fields = {}, skipQueue) {
        return this._doTask(async () => {
            if (typeof line === 'number') { // edit a line
                const buf = await this._getLineBuffer(line);
                buf[0] |= 0b00 << 6; // set type

                // check index
                for (let i in this.indices) {
                    const currentValue = this._getFieldFromLine(buf, i);
                    if ((fields[i] !== undefined) && (currentValue !== fields[i])) { // update index
                        this.indices[i].delete(currentValue);
                        this.indices[i].set(fields[i], (size - this.bodyOffset) / this.lineLength);
                    }
                }

                this._setFieldsToLine(buf, fields);
                await this._writeLineBuffer(line, buf);
                return line;
            } else { // create a new line
                const buf = Buffer.alloc(this.lineLength);
                buf[0] = 0b00 << 6; // set type
                this._setFieldsToLine(buf, fields);
                buf.writeUInt32LE(0xFFFFFFFF, 2);

                return await this._appendLineBuffer(buf);
            }
        }, skipQueue);
    }

    setLineByField(field, query, fields = {}, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            if (fields[field] === undefined) fields[field] = query;
            await this.setLine(line, fields, true);
        }, skipQueue);
    }

    deleteLine(line, releaseSpace, skipQueue) {
        return this._doTask(async () => {
            if (releaseSpace) {
                await this._clearLinesFrom(line);
            } else {
                const buf = await this._getLineBuffer(line);
                buf[0] = 0b11 << 6; // set type: deleted start
                await this._writeLineBuffer(line, buf);
            }
        }, skipQueue);
    }

    deleteLineByField(field, query, releaseSpace, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            await this.deleteLine(line, releaseSpace, true);
        }, skipQueue);
    }

    cleanUp(skipQueue) {
        return this._doTask(async () => {
            for await (let { chunk, line } of this._readlines(0, undefined, false)) {
                if (chunk[0] === (0b11 << 6)) await this._clearLinesFrom(line);
            }
        }, skipQueue);
    }

    setExt(line, ext = Buffer.alloc(0), skipQueue) {
        return this._doTask(async () => {
            const linesNeeded = 1 + Math.ceil((ext.length - this.extBaseLength + 2) / (this.lineLength - 6));
            let lastLine = line;
            let offset = this.extBaseLength - 2;
            let lineBuf = await this._getLineBuffer(line);
            await this._clearLinesFrom(lineBuf.readUInt32LE(2));

            // write length and first line
            let nextLine = await this._getLastEmptyLine();
            lineBuf.writeUInt32LE((linesNeeded > 1) ? nextLine : 0xFFFFFFFF, 2);
            lineBuf.writeUInt16LE(ext.length, this.extOffset);
            ext.copy(lineBuf, this.extOffset + 2, 0, this.extBaseLength - 2);
            await this._writeLineBuffer(line, lineBuf);

            for (let i = 1; i < linesNeeded; i++) {
                nextLine = await this._getLastEmptyLine(nextLine);
                console.log(nextLine);
                const extBuf = Buffer.alloc(this.lineLength);
                extBuf[0] = 0b01 << 6; // type: extended
                extBuf.writeUInt32LE((linesNeeded - 1 > i) ? nextLine : 0xFFFFFFFF, 2);
                ext.copy(extBuf, 6, offset, offset + this.lineLength - 6);
                offset += this.lineLength - 6;
                await this._appendLineBuffer(extBuf);
            }
        }, skipQueue);
    }

    setExtByField(field, query, ext, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            await this.setExt(line, ext, true);
        }, skipQueue);
    }
}

// DBLE field
class DBLEField {
    constructor(length = 0, type = 'null', name = 'null', isKey = false) {
        this.length = length;
        this.type = type;
        this.name = name;
        this.isKey = isKey;
    }

    parse(buf, offset) {
        return buf.subarray(offset, offset + this.length);
    }

    write(data = Buffer.alloc(this.length), buf = Buffer.alloc(this.length), offset = 0) {
        data.copy(buf, offset, 0, this.length);
        return buf;
    }

    toDefinitionBuffer(isLast) {
        const typeBuf = Buffer.from(this.type, 'utf8');
        const nameBuf = Buffer.from(this.name, 'utf8');

        // safety check
        if (typeBuf.length > 127) throw new Error('Field type length must not over 127 bytes.');
        if (nameBuf.length > 127) throw new Error('Field name length must not over 127 bytes.');

        const definitionBuf = Buffer.alloc(6 + typeBuf.length + nameBuf.length);

        definitionBuf.writeUInt16BE(
            (isLast ? 1 : 0) | // isLast
            (this.isKey ? 1 << 1 : 0) // isKey
        ); // flag
        definitionBuf.writeUInt16LE(this.length, 2); // field length
        definitionBuf.writeUInt8(typeBuf.length, 4); // field type length
        typeBuf.copy(definitionBuf, 5); // field type
        definitionBuf.writeUInt8(nameBuf.length, 5 + typeBuf.length); // field name length
        nameBuf.copy(definitionBuf, 6 + typeBuf.length); // field name

        return definitionBuf;
    }
}

// DBLE field types

// Int8 (1 byte)
class DBLEInt8Field extends DBLEField {
    constructor(name, isKey) {
        super(1, 'Int8', name, isKey);
    }

    parse(buf, offset) {
        return buf.readInt8(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt8(data, offset);
        return buf;
    }
}

// UInt8 (1 byte)
class DBLEUInt8Field extends DBLEField {
    constructor(name, isKey) {
        super(1, 'UInt8', name, isKey);
    }

    parse(buf, offset) {
        return buf.readUInt8(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt8(data, offset);
        return buf;
    }
}

// Int16 (2 bytes)
class DBLEInt16Field extends DBLEField {
    constructor(name, isKey) {
        super(2, 'Int16', name, isKey);
    }

    parse(buf, offset) {
        return buf.readInt16LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt16LE(data, offset);
        return buf;
    }
}

// UInt16 (2 bytes)
class DBLEUInt16Field extends DBLEField {
    constructor(name, isKey) {
        super(2, 'UInt16', name, isKey);
    }

    parse(buf, offset) {
        return buf.readUInt16LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt16LE(data, offset);
        return buf;
    }
}

// Int32 (4 bytes)
class DBLEInt32Field extends DBLEField {
    constructor(name, isKey) {
        super(4, 'Int32', name, isKey);
    }

    parse(buf, offset) {
        return buf.readInt32LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt32LE(data, offset);
        return buf;
    }
}

// UInt32 (4 bytes)
class DBLEUInt32Field extends DBLEField {
    constructor(name, isKey) {
        super(4, 'UInt32', name, isKey);
    }

    parse(buf, offset) {
        return buf.readUInt32LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt32LE(data, offset);
        return buf;
    }
}

// BigInt64 (8 bytes)
class DBLEBigInt64Field extends DBLEField {
    constructor(name, isKey) {
        super(8, 'BigInt64', name, isKey);
    }

    parse(buf, offset) {
        return buf.readBigInt64LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeBigInt64LE(BigInt(data), offset);
        return buf;
    }
}

// BigUInt64 (8 bytes)
class DBLEBigUInt64Field extends DBLEField {
    constructor(name, isKey) {
        super(8, 'BigUInt64', name, isKey);
    }

    parse(buf, offset) {
        return buf.readBigUint64LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeBigUInt64LE(BigInt(data), offset);
        return buf;
    }
}

// Float (4 bytes)
class DBLEFloatField extends DBLEField {
    constructor(name, isKey) {
        super(4, 'Float', name, isKey);
    }

    parse(buf, offset) {
        return buf.readFloatLE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeFloatLE(data, offset);
        return buf;
    }
}

// Double (8 bytes)
class DBLEDoubleField extends DBLEField {
    constructor(name, isKey) {
        super(8, 'Double', name, isKey);
    }

    parse(buf, offset) {
        return buf.readDoubleLE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeDoubleLE(data, offset);
        return buf;
    }
}

// String (2 + n Bytes)
class DBLEStringField extends DBLEField {
    constructor(maxLength, name, isKey) {
        super(2 + maxLength, 'String', name, isKey);
    }

    parse(buf, offset) {
        const len = buf.readUInt16LE(offset);
        return buf.toString('utf8', offset + 2, offset + 2 + len);
    }

    write(data, buf = Buffer.allocUnsafe(this.length), offset = 0) {
        const strBuf = Buffer.from(data, 'utf8');
        const len = Math.min(strBuf.length, this.length - 2);

        buf.writeUInt16LE(len, offset);
        strBuf.copy(buf, offset + 2, 0, len);
        buf.fill(0, offset + 2 + len, offset + this.length);
        return buf;
    }
}

// Buffer (2 + n Bytes)
class DBLEBufferField extends DBLEField {
    constructor(maxLength, name, isKey) {
        super(2 + maxLength, 'Buffer', name, isKey);
    }

    parse(buf, offset) {
        const len = buf.readUInt16LE(offset);
        return buf.subarray(offset + 2, offset + 2 + len);
    }

    write(data, buf = Buffer.allocUnsafe(this.length), offset = 0) {
        const source = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const len = Math.min(source.length, this.length - 2);

        buf.writeUInt16LE(len, offset);
        source.copy(buf, offset + 2, 0, len);
        buf.fill(0, offset + 2 + len, offset + this.length);
        return buf;
    }
}

class DBLEAnyField extends DBLEField {
    constructor(length, name, isKey) {
        super(length, 'Any', name, isKey);
    }
}

// dble default types
const defaultDBLETypes = {
    Int8: DBLEInt8Field,
    UInt8: DBLEUInt8Field,
    Int16: DBLEInt16Field,
    UInt16: DBLEUInt16Field,
    Int32: DBLEInt32Field,
    UInt32: DBLEUInt32Field,
    BigInt64: DBLEBigInt64Field,
    BigUInt64: DBLEBigUInt64Field,
    Float: DBLEFloatField,
    Double: DBLEDoubleField,
    String: DBLEStringField,
    Buffer: DBLEBufferField,
    Any: DBLEAnyField
};

// export
module.exports = {
    DBLEFile,
    DBLEField,
    DBLEInt8Field, DBLEUInt8Field, DBLEInt16Field, DBLEUInt16Field, DBLEInt32Field, DBLEUInt32Field,
    DBLEBigInt64Field, DBLEBigUInt64Field,
    DBLEFloatField, DBLEDoubleField,
    DBLEStringField, DBLEBufferField,
    DBLEAnyField,
    defaultDBLETypes
};