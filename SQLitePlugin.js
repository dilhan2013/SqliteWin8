/// <reference path="SQLite3-Win8.js" />


/* author: dilhan */

if (!window.Cordova) window.Cordova = window.cordova;

(function () {
    var SQLitePlugin, SQLitePluginTransaction, counter, getOptions, root;
    root = this;
    counter = 0;

    SQLitePlugin = function (dbargs, openSuccess, openError) {
        if (!dbargs || !dbargs['name']) {
            throw new Error("Cannot create a SQLitePlugin instance without a db name");
        }

        this.dbargs = dbargs;
        this.dbname = dbargs.name + ".sqlite";
        dbargs.name = this.dbname;

        this.openSuccess = openSuccess;
        this.openError = openError;
        var successMsg = "DB opened: " + this.dbname;
        this.openSuccess || (this.openSuccess = function () {
            console.log(successMsg);
        });
        this.openError || (this.openError = function (e) {
            console.log(e.message);
        });

        this.bg = !dbargs.bgType || dbargs.bgType === 1;
        this.open(this.openSuccess, this.openError);
    };


    SQLitePlugin.prototype.openDBs = {};
    SQLitePlugin.prototype.txQueue = [];

    SQLitePlugin.prototype.log = function (m) {
        console.log(m);
    };

    SQLitePlugin.prototype.transaction = function (fn, error, success) {
        var t = new SQLitePluginTransaction(this, fn, error, success);
        this.txQueue.push(t);
        if (this.txQueue.length == 1) {
            t.start();
        }
    };

    SQLitePlugin.prototype.startNextTransaction = function () {
        this.txQueue.shift();
        if (this.txQueue[0]) {
            this.txQueue[0].start();
        }
    };

    SQLitePluginTransaction = function (db, fn, error, success) {
        if (typeof fn !== 'function') {
            // This is consistent with the implementation in Chrome -- it
            // throws if you pass anything other than a function. This also
            // prevents us from stalling our txQueue if somebody passes a
            // false value for fn.
            throw new Error("transaction expected a function")
        }
        this.db = db;
        this.fn = fn;
        this.error = error;
        this.success = success;
        this.executes = [];
        this.executeSql('BEGIN', [], null, function (tx, err) { throw new Error("unable to begin transaction: " + err.message) });
    };

    SQLitePluginTransaction.prototype.start = function () {
        try {
            if (!this.fn) {
                return;
            }
            this.fn(this);
            this.fn = null;
            this.run();
        }
        catch (err) {
            // If "fn" throws, we must report the whole transaction as failed.
            this.db.startNextTransaction();
            if (this.error) {
                this.error(err);
            }
        }
    };

    SQLitePluginTransaction.prototype.executeSql = function (sql, values, success, error) {
        var qid = this.executes.length;

        this.executes.push({
            qid: qid,
            sql: sql,
            params: values || [],
            success: success,
            error: error
        });
    };

    SQLitePluginTransaction.prototype.handleStatementSuccess = function (handler, response) {
        if (!handler)
            return;
        var payload = {
            rows: { item: function (i) { return response.rows[i] }, length: response.rows.length },
            rowsAffected: response.rowsAffected,
            insertId: response.insertId || null
        };
        handler(this, payload);
    };

    SQLitePluginTransaction.prototype.handleStatementFailure = function (handler, error) {
        if (!handler || handler(this, error)) {
            throw error;
        }
    };

    SQLitePluginTransaction.prototype.run = function () {

        var batchExecutes = this.executes,
            waiting = batchExecutes.length,
            txFailure,
            tx = this,
            opts = [];
        this.executes = [];

        // var handlerFor = function (index, didSucceed) {
        var handleFor = function (index, didSucceed, response) {
            try {
                if (didSucceed) {
                    tx.handleStatementSuccess(batchExecutes[index].success, response);
                } else {
                    tx.handleStatementFailure(batchExecutes[index].error, response);
                }
            }
            catch (err) {
                if (!txFailure)
                    txFailure = err;
            }
            if (--waiting == 0) {
                if (txFailure) {
                    tx.rollBack(txFailure);
                } else if (tx.executes.length > 0) {
                    // new requests have been issued by the callback
                    // handlers, so run another batch.
                    tx.run();
                } else {
                    tx.commit();
                }
            }
        }

        for (var i = 0; i < batchExecutes.length; i++) {
            var request = batchExecutes[i];
            opts.push({
                qid: request.qid,
                query: [request.sql].concat(request.params),
                sql: request.sql,
                params: request.params
            });
        }

        // NOTE: this function is no longer expected to be called:
        var error = function (resultsAndError) {
            var results = resultsAndError.results;
            var nativeError = resultsAndError.error;
            var j = 0;

            // call the success handlers for statements that succeeded
            for (; j < results.length; ++j) {
                handleFor(j, true, results[j]);
            }

            if (j < batchExecutes.length) {
                // only pass along the additional error info to the statement that
                // caused the failure (the only one the error info applies to);
                var error = new Error('Request failed: ' + opts[j].query);
                error.code = nativeError.code;
                // the following properties are only defined if the plugin
                // was compiled with INCLUDE_SQLITE_ERROR_INFO
                error.sqliteCode = nativeError.sqliteCode;
                error.sqliteExtendedCode = nativeError.sqliteExtendedCode;
                error.sqliteMessage = nativeError.sqliteMessage;

                handleFor(j, false, error);
                j++;
            }

            // call the error handler for the remaining statements
            // (Note: this doesn't adhere to the Web SQL spec...)
            for (; j < batchExecutes.length; ++j) {
                handleFor(j, false, new Error('Request failed: ' + opts[j].query));
            }
        };

        var success = function (results) {
            if (results.length != opts.length) {
                // Shouldn't happen, but who knows...
                error(results);
            }
            else {
                for (var j = 0; j < results.length; ++j) {
                    if (!results[j].error) {
                        var result = results[j].result;
                        handleFor(j, true, result);
                    } else {
                        var error = new Error('Request failed: ' + opts[j].query);
                        error.code = results[j].error.code;
                        handleFor(j, false, error);
                    }
                }
            }
        };

        //mycommand = this.db.bg ? "backgroundExecuteSqlBatch" : "executeSqlBatch";
        //var args = { dbargs: { dbname: this.db.dbname }, executes: opts };


        var theDb = this.db.openDBs[this.db.dbname];
        var theResultsAndError = { results: [], error: false };
        var currentOptIndex = 0;

        var runSql = function (sql, params) {

            theDb.allAsync(sql, params).then(function (rows) {

                var isInsert = sql.toLowerCase().indexOf('insert') == 0;

                theResultsAndError.results.push({
                    result: {
                        rows: rows,
                        rowsAffected: 0,
                        insertId: (isInsert ? theDb.lastInsertRowId : -1)
                    }
                });

                currentOptIndex++;

                if (opts.length > currentOptIndex) {

                    runSql(opts[currentOptIndex].sql, opts[currentOptIndex].params);

                } else {

                    success(theResultsAndError.results);

                }

            }, function (err) {
                //to-do format properly later
                theResultsAndError.error = {
                    code: err.number,
                    sqliteCode: err.number,
                    sqliteExtendedCode: 0,
                    sqliteMessage: err.message
                };

                error(theResultsAndError);

            });

        };

        runSql(opts[currentOptIndex].sql, opts[currentOptIndex].params);

        //exec(mycommand, args, success, /* not expected: */ error);
    };

    SQLitePluginTransaction.prototype.rollBack = function (txFailure) {
        if (this.finalized)
            return;
        this.finalized = true;
        tx = this;
        function succeeded() {
            tx.db.startNextTransaction();
            if (tx.error) {
                tx.error(txFailure)
            }
        }
        function failed(tx, err) {
            tx.db.startNextTransaction();
            if (tx.error) {
                tx.error(new Error("error while trying to roll back: " + err.message))
            }
        }
        this.executeSql('ROLLBACK', [], succeeded, failed);
        this.run();
    };

    SQLitePluginTransaction.prototype.commit = function () {
        if (this.finalized)
            return;
        this.finalized = true;
        tx = this;
        function succeeded() {
            tx.db.startNextTransaction();
            if (tx.success) {
                tx.success()
            }
        }
        function failed(tx, err) {
            tx.db.startNextTransaction();
            if (tx.error) {
                tx.error(new Error("error while trying to commit: " + err.message))
            }
        }
        this.executeSql('COMMIT', [], succeeded, failed);
        this.run();
    };


    SQLitePlugin.prototype.open = function (success, error) {

        var self = this,
            dbPath = Windows.Storage.ApplicationData.current.localFolder.path + "\\" + self.dbname;

        if (!(self.dbname in self.openDBs)) {
            //self.openDBs[self.dbname] = true;

            SQLite3JS.openAsync(dbPath).then(function (db) {

                self.openDBs[self.dbname] = db;
                self.log('opened db:' + self.dbname);
                success();
            });

        } else {
            console.log('found db already open ...');
            success();
        }

    };

    SQLitePlugin.prototype.close = function (success, error) {
        if (this.dbname in this.openDBs) {
            this.openDBs[self.dbname].close();
            delete this.openDBs[this.dbname];
        }
    };

    SQLiteFactory = {
        opendb: function () {
            var errorcb, first, okcb, openargs;
            if (arguments.length < 1) return null;
            first = arguments[0];
            openargs = null;
            okcb = null;
            errorcb = null;
            if (first.constructor === String) {
                openargs = {
                    name: first
                };
                if (arguments.length >= 5) {
                    okcb = arguments[4];
                    if (arguments.length > 5) errorcb = arguments[5];
                }
            } else {
                openargs = first;
                if (arguments.length >= 2) {
                    okcb = arguments[1];
                    if (arguments.length > 2) errorcb = arguments[2];
                }
            }
            return new SQLitePlugin(openargs, okcb, errorcb);
        },
        deleteDb: function (databaseName, success, error) {
            var self = this,
            dbPath = Windows.Storage.ApplicationData.current.localFolder.path + "\\" + dbName;

            try {

                Windows.Storage.ApplicationData.current.localFolder.getFileAsync(dbPath).then(function (theDBFile) {
                    theDBFile.deleteAsync();
                });

            } catch (ee) {
                console.log("ca not delete database: " + dbName);
            }
        }
    };

    root.sqlitePlugin = {
        openDatabase: SQLiteFactory.opendb,
        deleteDatabase: SQLiteFactory.deleteDb
    };

})();
