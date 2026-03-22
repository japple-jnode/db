/*
@jnode/db/dble.js

Simple database package for Node.js.

JDB Lite Extended (DBLE) is a simple, fast and extensiable database format.

by JustApple     (format design, programming, testing) &
   Google Gemini (code review, small bug fix, completion of default types)
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
    }

    static async load(path, options = {}) {
        const jdb = await JDBFile.load(path);

        try {
            if (jdb.dbType !== 0x44424C45) throw new Error('JDB (DBLE): DBType is not "DBLE".'); // db type
            if (jdb.dbVersion !== 1) throw new Error('JDB (DBLE): Unsupported DBLE DBVersion.'); // db version

            const dble = new DBLEFile(jdb, options);
            await dble._loadHead();
            await dble._loadIndices();

            return dble;
        } catch (e) {
            await jdb.close();
            throw e;
        }
    }

    static async create(path, options = {}) {
        const jdb = await JDBFile.create(path, {
            dbType: 0x44424C45,
            dbVersion: 1
        });

        const dble = new DBLEFile(jdb, options);
        try {
            await dble._init(options);
            return dble;
        } catch (e) {
            await jdb.close();
            throw e;
        }
    }

    static async forceCreate(path, options = {}) {
        const jdb = await JDBFile.forceCreate(path, {
            dbType: 0x44424C45,
            dbVersion: 1
        });

        const dble = new DBLEFile(jdb, options);
        try {
            await dble._init(options);
            return dble;
        } catch (e) {
            await jdb.close();
            throw e;
        }
    }

    async _init(options = {}) {
        if (!options.fields) throw new Error('`options.fields` is required.');

        this.fields = options.fields;
        this.fieldsMap = {};
        this.fieldOffsets = {};
        this.indices = {};
        this.relatives = {};
        this.relativeOffsets = {};

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
            if (def.isRelative) { // set relatives
                this.relatives[def.name] = this._getDefaultOf(def);
                this.relativeOffsets[def.name] = dbHeadLength - def.length - 6;
            }
        }

        this.extOffset = dbLineLength;

        // calculate ext field length dynamically as a power of 2
        let n = dbLineLength + 1 + (options.extBaseLength ?? 0);
        n |= n >> 1;
        n |= n >> 2;
        n |= n >> 4;
        n |= n >> 8;
        n |= n >> 16;
        n++;

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
        this.relatives = {};
        this.relativeOffsets = {};

        // parse definitions
        let fieldIsLast = false;
        let fieldIsKey = false;
        let fieldIsRelative = false;
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
            // load flags and field length
            const flagLenBuf = await readBytes(4);
            const fieldFlags = flagLenBuf.readUInt16BE();
            fieldIsLast = fieldFlags & 1;
            fieldIsKey = fieldFlags & (1 << 1);
            fieldIsRelative = fieldFlags & (1 << 2);
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
            field.isRelative = !!fieldIsRelative;
            field.length = fieldLength;
            field.type = fieldType;
            field.name = fieldName;
            this.fields.push(field);

            if (this.fieldOffsets[fieldName]) throw new Error('JDB (DBLE): Fail to parse the file, could not have two fields in the same name.');
            this.fieldOffsets[fieldName] = dbLineLength;
            this.fieldsMap[fieldName] = field;
            if (fieldIsKey) this.indices[fieldName] = new Map(); // set index

            // set relatives
            if (fieldIsRelative) {
                this.relatives[fieldName] = field.parse(await readBytes(fieldLength), 0);
                this.relativeOffsets[fieldName] = this.bodyOffset - fieldLength;
            }

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

    _getDefaultOf(type, relative) {
        if (typeof type.default === 'function') {
            return type.default(relative);
        }
    }

    // safely retrieve normalized index mapping target mapping
    _getIndexKey(val) {
        return Buffer.isBuffer(val) ? val.toString('hex') : val;
    }

    // close file handle safely through the inner task queue
    close() {
        return this._doTask(async () => {
            return await this.jdb.close();
        });
    }

    // load indices
    async _loadIndices() {
        for await (let { chunk, line } of this._readlines()) {
            for (let i in this.indices) {
                this.indices[i].set(this._getIndexKey(this._getFieldFromLine(chunk, i)), line);
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
        // enforce LRU replacement mechanic mapping
        this._lineCache.delete(line);
        this._lineCache.set(line, buf);

        // remove oldest added cache
        if (this._lineCache.size > (this.options.maxLineCache || (this.options.maxLineCache = Math.ceil((this.options.maxLineCacheSize || 1048576) / this.lineLength)))) {
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
        const { bytesRead } = await this.jdb.handle.read(lineBuf, 0, this.lineLength, this.bodyOffset + line * this.lineLength);
        if (bytesRead !== this.lineLength) throw new Error('JDB (DBLE): Unexpected end of file.');

        // add to cache
        this._setLineCache(line, lineBuf);

        return lineBuf;
    }

    // write a buffer to line
    async _writeLineBuffer(line, buf, offset = 0) {
        if (typeof line !== 'number') throw new TypeError('line must be an integer.');
        if (!Buffer.isBuffer(buf)) throw new TypeError('buf must be a buffer.');

        const writeBuf = offset === 0 && buf.length === this.lineLength ? buf : buf.subarray(offset, offset + this.lineLength);

        // write line
        await this.jdb.handle.write(writeBuf, 0, this.lineLength, this.bodyOffset + line * this.lineLength);

        // add to cache
        this._setLineCache(line, writeBuf);
    }

    _getRelative(field) {
        return this.relatives[field];
    }

    async _setRelative(field, value) {
        const type = this.fieldsMap[field];
        const buf = Buffer.alloc(type.length);
        type.write(value, buf, 0);

        // write line
        await this.jdb.handle.write(buf, 0, buf.length, this.relativeOffsets[field]);

        this.relatives[field] = value;
    }

    _getDefaultByField(field, relative) {
        return this._getDefaultOf(this.fieldsMap[field], relative);
    }

    // append a line
    async _appendLineBuffer(buf, offset = 0) {
        if (!Buffer.isBuffer(buf)) throw new TypeError('buf must be a buffer.');

        const writeBuf = offset === 0 && buf.length === this.lineLength ? buf : buf.subarray(offset, offset + this.lineLength);
        let targetLine = this.lastEmptyLine;

        if (targetLine === 0xFFFFFFFF) { // no empty lines
            const { size } = await this.jdb.handle.stat();

            // write line
            await this.jdb.handle.write(writeBuf, 0, this.lineLength, size);

            // add to cache
            targetLine = (size - this.bodyOffset) / this.lineLength;
            this._setLineCache(targetLine, writeBuf);
        } else { // empty line
            const lineBuf = await this._getLineBuffer(targetLine);
            this.lastEmptyLine = lineBuf.readUInt32LE(2);
            await this._writeLineBuffer(targetLine, writeBuf);

            // write back the last empty line
            const lastEmptyLineBuf = Buffer.allocUnsafe(4);
            lastEmptyLineBuf.writeUInt32LE(this.lastEmptyLine);
            await this.jdb.handle.write(lastEmptyLineBuf, 0, 4, this.lastEmptyLineOffset);
        }

        // update for start line
        if ((writeBuf[0] & 0xC0) === (0b00 << 6)) {
            // update indecies
            for (let i in this.indices) {
                this.indices[i].set(this._getIndexKey(this._getFieldFromLine(writeBuf, i)), targetLine);
            }

            // update relatives
            for (let i in this.relatives) {
                await this._setRelative(i, this._getFieldFromLine(writeBuf, i));
            }
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
            if (this.fieldsMap[field]) {
                if (fields[field] === undefined) continue;
                this.fieldsMap[field].write(fields[field], buf, this.fieldOffsets[field]);
            }
        }
        return buf;
    }

    async _clearLinesFrom(line) {
        if (line === 0xFFFFFFFF) return;

        let lineBuf;
        let nextLine = line;

        while (nextLine !== 0xFFFFFFFF) {
            lineBuf = await this._getLineBuffer(nextLine);
            const actualNext = lineBuf.readUInt32LE(2);

            const type = lineBuf[0] & 0xC0;
            if (type === (0b00 << 6) || type === (0b11 << 6)) { // remove from index mapping
                for (let i in this.indices) {
                    const key = this._getIndexKey(this._getFieldFromLine(lineBuf, i));
                    if (this.indices[i].get(key) === nextLine) this.indices[i].delete(key);
                }
            }

            const clearedBuf = Buffer.alloc(this.lineLength);
            clearedBuf[0] = (lineBuf[0] & 0x3F) | (0b10 << 6); // Preserve 14-bit flag, toggle 'Empty' state safely
            clearedBuf.writeUInt32LE(this.lastEmptyLine, 2);

            this.lastEmptyLine = nextLine;
            await this._writeLineBuffer(nextLine, clearedBuf);
            this._lineCache.delete(nextLine);

            nextLine = actualNext;
        }

        // write back the last empty line
        const lastEmptyLineBuf = Buffer.allocUnsafe(4);
        lastEmptyLineBuf.writeUInt32LE(this.lastEmptyLine);
        await this.jdb.handle.write(lastEmptyLineBuf, 0, 4, this.lastEmptyLineOffset);
    }

    async * _readlines(start = 0, end, startLineOnly = true) {
        let line = start;
        const bufSize = this.options.scanBufferLines || (this.options.scanBufferLines = Math.ceil((this.options.scanBufferSize || 1048576) / this.lineLength));
        let chunkLine = 0;
        let chunk = null;
        let chunkSize = 0;

        while (true) {
            if (end !== undefined && line >= end) return;
            if (chunkLine === chunkSize) {
                chunk = Buffer.allocUnsafe(bufSize * this.lineLength);
                const { bytesRead } = await this.jdb.handle.read(chunk, 0, chunk.length, this.bodyOffset + line * this.lineLength);
                chunkSize = bytesRead / this.lineLength;
                if (bytesRead % this.lineLength !== 0) throw new Error('JDB (DBLE): File broken. Reading non-aligned chunk blocks.');
                if (bytesRead === 0) return;
                chunkLine = 0;
                continue;
            }

            const lineChunk = chunk.subarray(chunkLine * this.lineLength, (chunkLine + 1) * this.lineLength);

            line++;
            chunkLine++;

            if (startLineOnly && ((lineChunk[0] & 0xC0) !== (0b00 << 6))) continue;
            yield { chunk: lineChunk, line: line - 1 };
        }
    }

    _parseLine(buf) {
        const lineType = (buf[0] & 0xC0) >> 6;
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
        } else if (line.type === 0b10) { // empty
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
                if (length === lengthRead) break;

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
        return this._doTask(async () => {
            if (this.indices[field]) {
                return this.indices[field].get(this._getIndexKey(query));
            } else {
                for await (let { chunk, line } of this._readlines()) {
                    let val = this._getFieldFromLine(chunk, field);
                    if (Buffer.isBuffer(val) && Buffer.isBuffer(query)) {
                        if (val.equals(query)) return line;
                    } else if (val === query) {
                        return line;
                    }
                }
            }
        }, skipQueue);
    }

    readLine(line, skipQueue) {
        return this._doTask(async () => {
            return this._parseLine(await this._getLineBuffer(line));
        }, skipQueue);
    }

    readLineByField(field, query, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            if (line === undefined) return;
            return this.readLine(line, true);
        }, skipQueue);
    }

    findLine(fn, skipQueue) {
        return this._doTask(async () => {
            for await (let { chunk, line } of this._readlines()) {
                const parsed = this._parseLine(chunk);
                if (await fn(parsed)) return line;
            }
        }, skipQueue);
    }

    forEachLine(fn, start, to, skipQueue) {
        return this._doTask(async () => {
            for await (let { chunk, line } of this._readlines(start, to)) {
                const parsed = this._parseLine(chunk);
                await fn(parsed, line);
            }
        }, skipQueue);
    }

    setLine(line, fields = {}, skipQueue) {
        return this._doTask(async () => {
            if (typeof line === 'number') { // edit a line
                const buf = await this._getLineBuffer(line);
                buf[0] = (buf[0] & 0x3F) | (0b00 << 6); // set type appropriately

                // check index mappings accurately
                const oldValues = {};
                for (let i in this.indices) {
                    if (fields[i] !== undefined) oldValues[i] = this._getFieldFromLine(buf, i);
                }

                this._setFieldsToLine(buf, fields);

                for (let i in this.indices) {
                    if (fields[i] !== undefined) {
                        const oldVal = oldValues[i];
                        const newVal = this._getFieldFromLine(buf, i);

                        let isDifferent = oldVal !== newVal;
                        if (Buffer.isBuffer(oldVal) && Buffer.isBuffer(newVal)) {
                            isDifferent = !oldVal.equals(newVal);
                        }

                        if (isDifferent) {
                            const oldKey = this._getIndexKey(oldVal);
                            if (this.indices[i].get(oldKey) === line) this.indices[i].delete(oldKey);
                            this.indices[i].set(this._getIndexKey(newVal), line);
                        }
                    }
                }

                await this._writeLineBuffer(line, buf);
                return line;
            } else { // create a new line
                return await this.appendLine(fields, true);
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

    appendLine(fields = {}, skipQueue) {
        return this._doTask(async () => {
            const buf = Buffer.alloc(this.lineLength);
            buf[0] = (buf[0] & 0x3F) | (0b00 << 6); // set type

            // set relatives
            for (let i in this.relatives) {
                fields[i] = fields[i] ?? this._getDefaultByField(i, this.relatives[i]);
            }

            this._setFieldsToLine(buf, fields);
            buf.writeUInt32LE(0xFFFFFFFF, 2);

            return await this._appendLineBuffer(buf);
        }, skipQueue);
    }

    deleteLine(line, releaseSpace, skipQueue) {
        return this._doTask(async () => {
            if (releaseSpace) {
                await this._clearLinesFrom(line);
            } else {
                const buf = await this._getLineBuffer(line);
                if ((buf[0] & 0xC0) === (0b00 << 6)) {
                    for (let i in this.indices) {
                        this.indices[i].delete(this._getIndexKey(this._getFieldFromLine(buf, i)));
                    }
                }
                buf[0] = (buf[0] & 0x3F) | (0b11 << 6); // preserve flags safely, set deleted type
                await this._writeLineBuffer(line, buf);
            }
        }, skipQueue);
    }

    deleteLineByField(field, query, releaseSpace, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            if (line !== undefined) await this.deleteLine(line, releaseSpace, true);
        }, skipQueue);
    }

    cleanUp(skipQueue) {
        return this._doTask(async () => {
            for await (let { chunk, line } of this._readlines(0, undefined, false)) {
                if ((chunk[0] & 0xC0) === (0b11 << 6)) await this._clearLinesFrom(line);
            }
        }, skipQueue);
    }

    setExt(line, ext = Buffer.alloc(0), skipQueue) {
        return this._doTask(async () => {
            if (!Buffer.isBuffer(ext)) ext = Buffer.from(ext);

            const linesNeeded = ext.length <= this.extBaseLength - 2 ? 1 : 1 + Math.ceil((ext.length - this.extBaseLength + 2) / (this.lineLength - 6));
            let offset = this.extBaseLength - 2;
            let lineBuf = await this._getLineBuffer(line);
            await this._clearLinesFrom(lineBuf.readUInt32LE(2));

            // write length and first line
            let nextLine = await this._getLastEmptyLine();
            lineBuf.writeUInt32LE((linesNeeded > 1) ? nextLine : 0xFFFFFFFF, 2);
            lineBuf.writeUInt16LE(ext.length, this.extOffset);

            const baseWriteLen = Math.min(ext.length, this.extBaseLength - 2);
            ext.copy(lineBuf, this.extOffset + 2, 0, baseWriteLen);
            lineBuf.fill(0, this.extOffset + 2 + baseWriteLen, this.extOffset + this.extBaseLength); // clean trailing ghosts

            await this._writeLineBuffer(line, lineBuf);

            for (let i = 1; i < linesNeeded; i++) {
                nextLine = await this._getLastEmptyLine(nextLine);
                const extBuf = Buffer.alloc(this.lineLength);
                extBuf[0] = (extBuf[0] & 0x3F) | (0b01 << 6); // extended type toggle preserving 14-bit flag bounds
                extBuf.writeUInt32LE((linesNeeded - 1 > i) ? nextLine : 0xFFFFFFFF, 2);

                const partLen = Math.min(ext.length - offset, this.lineLength - 6);
                ext.copy(extBuf, 6, offset, offset + partLen);
                offset += partLen;

                await this._appendLineBuffer(extBuf);
            }
        }, skipQueue);
    }

    setExtByField(field, query, ext, skipQueue) {
        return this._doTask(async () => {
            const line = await this.getLineByField(field, query, true);
            if (line !== undefined) await this.setExt(line, ext, true);
            else throw new Error(`JDB (DBLE): Line not found by field "${field}".`);
        }, skipQueue);
    }

    async sync(skipQueue) {
        return this._doTask(async () => {
            await this.jdb.sync();
        }, skipQueue);
    }

    async datasync(skipQueue) {
        return this._doTask(async () => {
            await this.jdb.datasync();
        }, skipQueue);
    }
}

// DBLE field
class DBLEField {
    constructor(length = 0, type = 'null', name = 'null', isKey = false, isRelative = false) {
        this.length = length;
        this.type = type;
        this.name = name;
        this.isKey = isKey;
        this.isRelative = isRelative;
    }

    parse(buf, offset) {
        return buf.subarray(offset, offset + this.length);
    }

    write(data = Buffer.alloc(this.length), buf = Buffer.alloc(this.length), offset = 0) {
        data.copy(buf, offset, 0, this.length);
        return buf;
    }

    default(relative) {
        return;
    }

    toDefinitionBuffer(isLast) {
        const typeBuf = Buffer.from(this.type, 'utf8');
        const nameBuf = Buffer.from(this.name, 'utf8');

        // safety check
        if (typeBuf.length > 255) throw new Error('Field type length must not over 255 bytes.');
        if (nameBuf.length > 255) throw new Error('Field name length must not over 255 bytes.');

        const definitionBuf = Buffer.alloc(6 + typeBuf.length + nameBuf.length + (this.isRelative ? this.length : 0));

        definitionBuf.writeUInt16BE(
            (isLast ? 1 : 0) | // isLast
            (this.isKey ? 1 << 1 : 0) | // isKey
            (this.isRelative ? 1 << 2 : 0) // isRelative
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
    constructor(name, isKey, isRelative) {
        super(1, 'Int8', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readInt8(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt8(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// UInt8 (1 byte)
class DBLEUInt8Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(1, 'UInt8', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readUInt8(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt8(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// Int16 (2 bytes)
class DBLEInt16Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(2, 'Int16', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readInt16LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt16LE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// UInt16 (2 bytes)
class DBLEUInt16Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(2, 'UInt16', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readUInt16LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt16LE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// Int32 (4 bytes)
class DBLEInt32Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(4, 'Int32', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readInt32LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeInt32LE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// UInt32 (4 bytes)
class DBLEUInt32Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(4, 'UInt32', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readUInt32LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeUInt32LE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// BigInt64 (8 bytes)
class DBLEBigInt64Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(8, 'BigInt64', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readBigInt64LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeBigInt64LE(BigInt(data), offset);
        return buf;
    }

    default(relative = -1n) {
        return relative + 1n;
    }
}

// BigUInt64 (8 bytes)
class DBLEBigUInt64Field extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(8, 'BigUInt64', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readBigUInt64LE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeBigUInt64LE(BigInt(data), offset);
        return buf;
    }

    default(relative = -1n) {
        return relative + 1n;
    }
}

// Float (4 bytes)
class DBLEFloatField extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(4, 'Float', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readFloatLE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeFloatLE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// Double (8 bytes)
class DBLEDoubleField extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(8, 'Double', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return buf.readDoubleLE(offset);
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeDoubleLE(data, offset);
        return buf;
    }

    default(relative = -1) {
        return relative + 1;
    }
}

// String (2 + n Bytes)
class DBLEStringField extends DBLEField {
    constructor(maxLength, name, isKey, isRelative) {
        super(2 + maxLength, 'String', name, isKey, isRelative);
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
    constructor(maxLength, name, isKey, isRelative) {
        super(2 + maxLength, 'Buffer', name, isKey, isRelative);
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
    constructor(length, name, isKey, isRelative) {
        super(length, 'Any', name, isKey, isRelative);
    }
}

// Date (8 Bytes in BigUInt64 ms)
class DBLEDateField extends DBLEField {
    constructor(name, isKey, isRelative) {
        super(8, 'Date', name, isKey, isRelative);
    }

    parse(buf, offset) {
        return new Date(Number(buf.readBigInt64LE(offset)));
    }

    write(data, buf = Buffer.alloc(this.length), offset = 0) {
        buf.writeBigInt64LE(BigInt(data.getTime()), offset);
        return buf;
    }

    default() {
        return new Date();
    }
}

// dble default types
const defaultDBLETypes = {
    Int8: DBLEInt8Field, i8: DBLEInt8Field,
    UInt8: DBLEUInt8Field, u8: DBLEUInt8Field, byte: DBLEUInt8Field,
    Int16: DBLEInt16Field, i16: DBLEInt16Field,
    UInt16: DBLEUInt16Field, u16: DBLEUInt16Field,
    Int32: DBLEInt32Field, i32: DBLEInt32Field,
    UInt32: DBLEUInt32Field, u32: DBLEUInt32Field,
    BigInt64: DBLEBigInt64Field, i64: DBLEBigInt64Field,
    BigUInt64: DBLEBigUInt64Field, u64: DBLEBigUInt64Field,
    Float: DBLEFloatField, f32: DBLEFloatField,
    Double: DBLEDoubleField, f64: DBLEDoubleField,
    String: DBLEStringField, str: DBLEStringField,
    Buffer: DBLEBufferField, buf: DBLEBufferField,
    Any: DBLEAnyField, any: DBLEBufferField,
    Date: DBLEDateField, date: DBLEDateField
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
    DBLEDateField,
    defaultDBLETypes
};