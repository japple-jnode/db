/*
@jnode/db/jdb.js

Simple database package for Node.js.

JDB (.jdb) is the format of all the database files.

by JustApple
*/

// dependencies
const fs = require('fs/promises');

// base jdb file manager
class JDBFile {
    constructor(handle) {
        this.handle = handle;
    }

    static async load(path) {
        const jdb = new JDBFile(await fs.open(path, 'r+'));
        await jdb._loadHead();

        return jdb;
    }

    static async create(path, options = {}) {
        const jdb = new JDBFile(await fs.open(path, 'wx+'));
        await jdb._init(options);

        return jdb;
    }

    static async forceCreate(path, options = {}) {
        const jdb = new JDBFile(await fs.open(path, 'w+'));
        await jdb._init(options);

        return jdb;
    }

    // init the file
    async _init(options = {}) {
        const headBuf = Buffer.alloc(16);
        headBuf.writeUInt32BE(0x4A444244, 0); // magic string
        headBuf[4] = 1; // jdb file version
        headBuf.writeUInt32BE(this.dbType = (options.dbType || 0), 8); // db type
        headBuf[12] = this.dbVersion = (options.dbVersion || 0); // db version
        await this.handle.write(headBuf, 0, 16, 0);
    }

    // load and verify the file head
    async _loadHead() {
        const headBuf = Buffer.allocUnsafe(16);
        const { bytesRead } = await this.handle.read(headBuf, 0, 16, 0);

        if (bytesRead !== 16) throw new Error('JDB: File length not enough to be a JDB file.'); // basic length check
        if (headBuf.readUInt32BE(0) !== 0x4A444244) throw new Error('JDB: Magic string doesn\'t match "JDBD".'); // magic string
        if (headBuf[4] !== 1) throw new Error('JDB: Unsupported JDB file version.'); // file version

        // load db type and version
        this.dbType = headBuf.readUInt32BE(8);
        this.dbVersion = headBuf[12];
    }

    close() {
        return this.handle.close();
    }
}

// export
module.exports = {
    JDBFile
};