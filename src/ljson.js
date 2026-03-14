/*
@jnode/db/ljson.js

Simple database package for Node.js.

LineJSON (LJSON) is a simple new line-splitted JSON array database format with some special features.
Some place also called this JSONL or NDJSON.
This format is best for small, append-only data.
This format follows text-based JLD (JustLineData) format instead of binary-based JDB format.

by JustApple
*/

// dependencies
const fs = require('fs/promises');

class LJSONFile {
    constructor(path, data, options = {}) {
        this.path = path;
        this.options = options;

        this._loadData(data);
    }

    static async forceCreate(file, options) {
        const data = '@ JLD 01 LJSO 01\n';
        await fs.writeFile(file, data);
        return new LJSONFile(file, data, options);
    }

    static async load(file, options = {}) {
        let data;
        try {
            data = (await fs.readFile(file)).toString('utf8');
        } catch {
            data = '@ JLD 01 LJSO 01\n';
            await fs.writeFile(file, data);
        }

        // check header
        if (!data.startsWith('@ JLD 01 LJSO 01\n')) {
            throw new Error('JDB (LJSON): File header incorrect.')
        }

        const ljson = new LJSONFile(file, data, options);

        if (!options.disableCleanupOnStart) {
            await ljson.cleanUp();
        }

        return ljson;
    }

    _loadData(data) {
        const lines = data.split('\n');
        this.lines = [];
        this._requireCleanup = false;

        for (let i of lines) {
            if (i.startsWith('@')) continue; // header line
            else if (i.startsWith('//')) this._requireCleanup = true; // comment line
            else if (i === '') this._requireCleanup = true; // empty line
            else if (i.startsWith('+ ')) { // update line
                this._requireCleanup = true;
                const split = i.indexOf(' ', 2);
                const index = i.substring(2, split);
                const json = JSON.parse(i.substring(split));

                // check type
                const lineType = _typeof(this.lines[index]);
                if (lineType === _typeof(json)) {
                    switch (lineType) {
                        case 'number':
                        case 'string':
                            this.lines[index] += json;
                            break;
                        case 'boolean':
                            this.lines[index] = json !== this.lines[index];
                            break;
                        case 'array':
                            this.lines[index].push(...json);
                            break;
                        case 'object':
                            Object.assign(this.lines[index], json);
                            break;
                    }
                }
            } else if (i.startsWith('= ')) { // overwrite line
                this._requireCleanup = true;
                const split = i.indexOf(' ', 2);
                const index = i.substring(2, split);
                const json = JSON.parse(i.substring(split));

                this.lines[index] = json;
            } else if (i.startsWith('- ')) { // delete line
                this._requireCleanup = true;
                const index = i.substring(2);

                this.lines.splice(index, 1);
            } else { // data
                this.lines.push(JSON.parse(i));
            }
        }
    }

    // clean up the file
    async cleanUp(force) {
        if (this._requireCleanup || force) {
            await fs.writeFile(this.path + '.tmp', '@ JLD 01 LJSO 01\n' + this.lines.map(JSON.stringify).join('\n') + '\n');
            await fs.rename(this.path + '.tmp', this.path);
        }
    }

    update(index, json) {
        // check type
        const lineType = _typeof(this.lines[index]);
        if (lineType === _typeof(json)) {
            this._requireCleanup = true;

            switch (lineType) {
                case 'number':
                case 'string':
                    this.lines[index] += json;
                    break;
                case 'boolean':
                    this.lines[index] = json !== this.lines[index];
                    break;
                case 'array':
                    this.lines[index].push(...json);
                    break;
                case 'object':
                    Object.assign(this.lines[index], json);
                    break;
            }

            return fs.appendFile(this.path, `+ ${index} ${JSON.stringify(json)}\n`);
        }
    }

    overwrite(index, json) {
        this._requireCleanup = true;
        this.lines[index] = json;
        return fs.appendFile(this.path, `= ${index} ${JSON.stringify(json)}\n`);
    }

    delete(index) {
        this._requireCleanup = true;
        this.lines.splice(index, 1);
        return fs.appendFile(this.path, `- ${index}\n`);
    }

    push(json) {
        this.lines.push(json);
        return fs.appendFile(this.path, `${JSON.stringify(json)}\n`);
    }
}

// get type with array support
function _typeof(value) {
    return Array.isArray(value) ? 'array' : typeof value;
}

module.exports = {
    LJSONFile
};