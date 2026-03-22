# `@jnode/db`

Simple database package for Node.js.

## Installation

```
npm i @jnode/db
```

## Quick start

### Import

```js
// Import from the main entry
const { jdb, dble, ljson } = require('@jnode/db');

// Or import from subpaths
const { JDBFile } = require('@jnode/db/jdb');
const { DBLEFile, DBLEUInt32Field, DBLEStringField } = require('@jnode/db/dble');
const { LJSONFile } = require('@jnode/db/ljson');
```

### Start with a simple LJSON database

LJSON is perfect for small, append-only or simple text-based data.

```js
const { LJSONFile } = require('@jnode/db/ljson');

(async () => {
  // Load or create a database
  const db = await LJSONFile.load('./data.ljson');

  // Push new data
  await db.push({ name: 'Alice', score: 10 });
  await db.push({ name: 'Bob', score: 15 });

  // Update data (adds to numbers/strings, merges objects, etc.)
  await db.update(0, { score: 5 }); // Alice's score becomes 15

  // Overwrite or delete
  await db.overwrite(1, { name: 'Bob', score: 20 });
  await db.delete(0); // Deletes Alice
})();
```

### Start a complex DBLE database

DBLE is a fast, structured, binary-based database with schema definitions.

```js
const { DBLEFile, DBLEUInt32Field, DBLEStringField } = require('@jnode/db/dble');

(async () => {
  // Create a new DBLE database with a defined schema
  const db = await DBLEFile.create('./users.dble', {
    fields:[
      new DBLEUInt32Field('id', true), // 'id' is a key (indexed)
      new DBLEStringField(255, 'username')
    ]
  });

  // Append lines (rows)
  await db.appendLine({ id: 1, username: 'justapple' });
  await db.appendLine({ id: 2, username: 'nick' });

  // Fast query using indexed keys
  const nickData = await db.readLineByField('id', 2);
  console.log(nickData.fields.username); // 'nick'

  // Safely close the database
  await db.close();
})();
```

## How it works?

The `@jnode/db` package provides three core components to handle different data persistence needs seamlessly:

1. **JDB** (`.jdb`): The base binary file format manager. It handles basic file magic headers, versions, and provides raw file access wrappers.
2. **DBLE** (`.dble`): Stands for **JDB Lite Extended**. It is a simple, fast, schema-defined binary database built on top of JDB. It supports fixed-length fields, typed records, automatic indexing, deleted space reuse, and dynamic extended fields.
3. **LJSON** (`.ljson`): Stands for **LineJSON**. It follows the `JLD` (JustLineData) text-based format. It stores an array of JSON objects line-by-line and processes append-only mutations like updates, deletions, and overwrites, making it extremely durable for logging or small configs.

**Advanced Usage (DBLE):** Because DBLE queues its async file operations internally to ensure data integrity, executing multiple interdependent queries could sometimes face race conditions if another script block appends data concurrently. If you want to run complex logic that involves multiple operations, you can use the internal task queue method `._doTask(async () => { ... })` and pass `true` to the `skipQueue` argument of any method called inside. This bypasses the queue check internally and ensures your complex block runs uninterruptedly and safely!

------

# Reference

## Class: `jdb.JDBFile`

The base JDB file manager for handling binary file headers.

### Static method: `JDBFile.load(path)`

- `path` [\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Path to the file.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a[\<jdb.JDBFile\>](#class-jdbjdbfile).

Opens an existing JDB file and verifies its format and magic string.

### Static method: `JDBFile.create(path[, options])`

- `path` [\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Path to the file.
- `options`[\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)
  - `dbType` [\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) A 4-byte identifier for the database type (E.g., `0x44424C45` for DBLE). **Default:** `0`.
  - `dbVersion` [\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) The version of the specific database format. **Default:** `0`.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a [\<jdb.JDBFile\>](#class-jdbjdbfile).

Creates a new JDB file (fails if the file already exists).

### Static method: `JDBFile.forceCreate(path[, options])`

- `path` [\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Path to the file.
- `options` [\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object) Same as[`JDBFile.create()`](#staticmethod-jdbfilecreatepath-options).
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a [\<jdb.JDBFile\>](#class-jdbjdbfile).

Forces creation of a new JDB file, overwriting if it already exists.

### `jdb.close()`

- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)

Closes the internal file handle safely.

### `jdb.sync()`

- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)

Synchronizes the file's data and metadata to the storage device.

### `jdb.datasync()`

- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)

Synchronizes only the file's data to the storage device.

### Inner method: `jdb._init([options])`

### Inner method: `jdb._loadHead()`

Internal methods to initialize and load file headers.

## Class: `dble.DBLEFile`

The main manager for DBLE files, which extends `JDBFile`.

### Static method: `DBLEFile.load(path[, options])`

- `path`[\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Path to the file.
- `options` [\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)
  - `types` [\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object) Custom field types mappings.
  - `maxLineCache` / `maxLineCacheSize` [\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) Controls the LRU cache limit for read lines.
  - `scanBufferLines` / `scanBufferSize` [\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) Controls buffer block sizes when iterating sequentially.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a[\<dble.DBLEFile\>](#class-dbledblefile).

### Static method: `DBLEFile.create(path, options)`

### Static method: `DBLEFile.forceCreate(path, options)`

- `path` [\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Path to the file.
- `options`[\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)
  - `fields` [\<DBLEField[]\>](#class-dbledblefield) **Required.** An array of field instances defining the table structure.
  - `extBaseLength`[\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) Optional override to calculate extension field base length manually.
  - Plus `DBLEFile.load` options.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a[\<dble.DBLEFile\>](#class-dbledblefile).

Creates (or forcefully overwrites) a DBLE database file.

### `dble.getField(line, field[, skipQueue])`

- `line`[\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) The index of the line/row.
- `field`[\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Field name.
- `skipQueue` [\<boolean\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#boolean_type) Skip the internal task queue execution lock.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Resolves with the parsed field value.

Retrieves a specific field from a specific line.

### `dble.getExt(line[, skipQueue])`

Retrieves the concatenated binary extended data for a line. Returns a [\<Buffer\>](https://nodejs.org/docs/latest/api/buffer.html#class-buffer).

### `dble.getLineByField(field, query[, skipQueue])`

Finds the numeric line index where the specified `field` matches the `query`. If the field was declared with `isKey: true`, this operation is `O(1)` via index map. Otherwise, it executes a sequential scan.

### `dble.readLine(line[, skipQueue])`

Reads a full line structure at the target index. The resolved object looks like: `{ type, nextLine, fields: { ... } }`.

### `dble.readLineByField(field, query[, skipQueue])`

Combination of `getLineByField` and `readLine`. Returns the parsed line object.

### `dble.findLine(fn[, skipQueue])`

Iterates over all lines and returns the line index when the async callback `fn(parsedLine)` returns `true`.

### `dble.forEachLine(fn, start, to[, skipQueue])`

Executes the callback `fn(parsedLine, lineIndex)` on every valid database line starting from `start` up to `to`.

### `dble.setLine(line, fields[, skipQueue])`

Updates specific fields on an existing line. Pass `{}` to fields to just touch it, or pass an object with partial properties. Also updates indexes seamlessly. If `line` is not a number, it behaves like `appendLine`.

### `dble.setLineByField(field, query, fields[, skipQueue])`

Finds the line via field/query matching, and updates it.

### `dble.appendLine(fields[, skipQueue])`

Appends a new record to the database, or overwrites an empty (deleted) line dynamically for disk space reuse. Returns the new line index.

### `dble.deleteLine(line, releaseSpace[, skipQueue])`

Flags a line as deleted. If `releaseSpace` is `true`, it dynamically links the block to the empty line manager to allow future `appendLine` calls to overwrite this spot.

### `dble.deleteLineByField(field, query, releaseSpace[, skipQueue])`

Finds a line by a query and deletes it.

### `dble.cleanUp([skipQueue])`

Loops over the DB sequentially, completely clearing up lines marked as deleted and moving them to the empty reusable line linked list.

### `dble.setExt(line, ext[, skipQueue])`

Saves an arbitrary binary[\<Buffer\>](https://nodejs.org/docs/latest/api/buffer.html#class-buffer) to a line's extension block. If the buffer is large, it automatically chunks it across multiple linked empty lines.

### `dble.setExtByField(field, query, ext[, skipQueue])`

Finds a line by field query and sets its extended buffer data.

### `dble.close()`

### `dble.sync([skipQueue])`

### `dble.datasync([skipQueue])`

File handle operations natively routed to the base JDB class.

### Inner method: `dble._doTask(func, skipQueue)`

Advanced tool. Runs your `func` exclusively inside the DB task queue, locking other async modifications from messing with your state.

### Inner methods: `_init`, `_loadHead`, `_loadIndices`, `_getLineBuffer`, `_writeLineBuffer`, `_appendLineBuffer`, `_getLastEmptyLine`, `_clearLinesFrom`, `_readlines`, `_parseLine`, etc

Internal lifecycle and binary chunking methods.

## Class: `dble.DBLEField`

The base interface for field typings in DBLE. You instantiate these classes in the `fields` array when creating a new database.

### Built-in Field Types

Access these via `require('@jnode/db/dble')` or `dble.defaultDBLETypes`:

- `DBLEInt8Field(name, isKey, isRelative)` / `DBLEUInt8Field`
- `DBLEInt16Field(name, isKey, isRelative)` / `DBLEUInt16Field`
- `DBLEInt32Field(name, isKey, isRelative)` / `DBLEUInt32Field`
- `DBLEBigInt64Field(name, isKey, isRelative)` / `DBLEBigUInt64Field`
- `DBLEFloatField(name, isKey, isRelative)` / `DBLEDoubleField`
- `DBLEStringField(maxLength, name, isKey, isRelative)`
- `DBLEBufferField(maxLength, name, isKey, isRelative)`
- `DBLEAnyField(length, name, isKey, isRelative)`
- `DBLEDateField(name, isKey, isRelative)`

*Note: The `maxLength` argument is required for String and Buffer types to enforce DBLE's fixed-length binary schema standard.*

## Class: `ljson.LJSONFile`

Manages text-based LJSON files. This works by keeping a stateful memory representation of the JSON array, and appending modification operations (like `+`, `=`, `-`) to the file stream iteratively.

### Static method: `LJSONFile.load(file[, options])`

- `file` [\<string\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#string_type) Target LJSON file path.
- `options` [\<Object\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)
  - `disableCleanupOnStart` [\<boolean\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#boolean_type) Stop LJSON from compacting its mutation logs on load.
- Returns: [\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) Fulfills with a [\<ljson.LJSONFile\>](#class-ljsonljsonfile).

Loads the JLD formatted LJSON file. If it doesn't exist, an empty file will be created.

### Static method: `LJSONFile.forceCreate(file[, options])`

Overwrites a file with a fresh, empty LJSON database.

### `ljson.cleanUp(force)`

Rewrites the entire file on disk, collapsing all mutation lines (updates, overwrites, deletions) into a clean, flat list of final JSON representations.

### `ljson.push(json)`

- `json` [\<any\>] Valid JSON.
- Returns:[\<Promise\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)

Appends a new line with the object directly to the database.

### `ljson.update(index, json)`

- `index` [\<number\>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#number_type) The array index to modify.
- `json` [\<any\>] The mutation payload.

Applies a mutation diff based on the original data type:

- **String / Number**: `original += update`
- **Boolean**: `original = update !== original`
- **Object**: `Object.assign(original, update)`
- **Array**: `original.push(...update)`

### `ljson.overwrite(index, json)`

Overwrites the target index entirely with the new `json` payload.

### `ljson.delete(index)`

Removes the index element from the database. Note that this shifts subsequent indexes.

### Inner method: `ljson._loadData(data)`

Parses textual JLD lines and applies all operators into the memory array.

------

# Format Specifications

## DBLE Format Specification

```
---- File Head
[4 Byte] "JDBD"
[UInt8 ] Version, 1
[3 Byte] RSV
[4 Byte] DB Type, "DBLE"
[UInt8 ] DB Version, 1
[3 Byte] RSV
---- DB Head
[Array ] Definition[16 Bit] Flag (isLast, isKey, isRelative RSV...)
  [UInt16] Field Length
  [UInt8 ] Type Name Length
  [String] Type Name
  [UInt8 ] Field Name Length
  [String] Field Name
  [n Byte] (OPTIONAL) Field Relative Data[UInt16] Extend Field Base Length (making each line 2 ** N bytes)
[UInt32] Last Empty Line (0xFFFFFFFF for null)
[n Byte] Padding (making 'File Head' + 'DB Head' N * Line Length)
---- DB Body
[Array ] Lines
  [2 Bit ] Type (Normal Start, Extended, Empty, Deleted Start)
  [14 Bit] Flag[UInt32] Extended Line At/Last Empty Line (if type is 'Empty', 0xFFFFFFFF for null)
  [Array ] Line Data
    [n Byte] Field Data
```

## LJSON Format Specification

This is a simple text-based, line-based data format.

### JLD v1 File head line

> `JLD` stands for **JustLineData**, a subtype of JDB but is text-and-line-based while a `.jdb` file is binary based.

```
@ JLD 01 <DATA-TYPE (4 ASCII Character)> <DATA-VERSION (2 HEX)>
[@ <OTHER-HEADERS...>]...
<ACTUAL-DATA>...
```

For LJSON, we use:

```
@ JLD 01 LJSO 01
```

### Line types

- `<JSON>` JSON data line. E.G. `{"name":"nick"}`.
- `/ <CONTENT>` Comment. Only for temporary use, we won't keep the comment lines.
- `+ <INDEX> <JSON>` Update line. Update JSON's data type must be same as original JSON's data type. Works in different ways according to the data type:
  - **String**: `original += update`.
  - **Number**: `original += update`.
  - **Boolean**: `original = update !== original`.
  - **Object**: `Object.assign(original, update)`
  - **Array**: `original.push(...update)`
- `= <INDEX> <JSON>` Overwrite line.
- `- <INDEX>` Delete line.
