'use strict';

var pouchdbUtils = require('pouchdb-utils');
var pouchdbErrors = require('pouchdb-errors');
var pouchdbBinaryUtils = require('pouchdb-binary-utils');
var pouchdbAdapterUtils = require('pouchdb-adapter-utils');
var pouchdbMd5 = require('pouchdb-md5');
var pouchdbMerge = require('pouchdb-merge');

var DOC_STORE = 'docs';
var META_STORE = 'meta';

function idbError(callback) {
  return function (evt) {
    var message = 'unknown_error';
    if (evt.target && evt.target.error) {
      message = evt.target.error.name || evt.target.error.message;
    }
    callback(pouchdbErrors.createError(pouchdbErrors.IDB_ERROR, message, evt.type));
  };
}

function processAttachment(name, src, doc, isBinary) {

  delete doc._attachments[name].stub;

  if (isBinary) {
    doc._attachments[name].data =
      src.attachments[doc._attachments[name].digest].data;
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    var data = src.attachments[doc._attachments[name].digest].data;
    pouchdbBinaryUtils.readAsBinaryString(data, function (binString) {
      doc._attachments[name].data = pouchdbBinaryUtils.btoa(binString);
      delete doc._attachments[name].length;
      resolve();
    });
  });
}

var IDB_VERSION = 1;

function createSchema(db) {

  var docStore = db.createObjectStore(DOC_STORE, {keyPath : 'id'});
  docStore.createIndex('deletedOrLocal', 'deletedOrLocal', {unique: false});
  docStore.createIndex('seq', 'seq', {unique: true});

  db.createObjectStore(META_STORE, {keyPath: 'id'});
}

function setup (openDatabases, api, opts) {

  if (opts.name in openDatabases) {
    return openDatabases[opts.name];
  }

  openDatabases[opts.name] = new Promise(function (resolve) {

    var req = opts.storage
      ? indexedDB.open(opts.name, {version: IDB_VERSION, storage: opts.storage})
      : indexedDB.open(opts.name, IDB_VERSION);

    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (e.oldVersion < 1) {
        createSchema(db);
      }
    };

    req.onsuccess = function (e) {

      var idb = e.target.result;
      idb.onabort = function (e) {
        console.error('Database has a global failure', e.target.error);
        delete openDatabases[opts.name];
        idb.close();
      };

      var metadata = {id: META_STORE};
      var txn = idb.transaction([META_STORE, DOC_STORE], 'readwrite');

      txn.oncomplete = function () {
        resolve({idb: idb, metadata: metadata});
      };

      function getDocCount() {
        txn.objectStore(DOC_STORE)
          .index('deletedOrLocal')
          .count(IDBKeyRange.only(0))
          .onsuccess = function (e) {
            metadata.doc_count = e.target.result;
          };
      }

      var metaStore = txn.objectStore(META_STORE);
      metaStore.get(META_STORE).onsuccess = function (e) {

        metadata = e.target.result || metadata;

        if (!('seq' in metadata)) {
          metadata.seq = 0;
        }

        if (!('db_uuid' in metadata)) {
          metadata.db_uuid = pouchdbUtils.uuid();
          metaStore.put(metadata).onsuccess = getDocCount;
        } else {
          getDocCount();
        }
      };
    };
  });

  return openDatabases[opts.name];
}

function info (db, metadata, callback) {
  callback(null, {
    doc_count: metadata.doc_count,
    update_seq: metadata.seq
  });
}

function get (db, id, opts, callback) {

  // We may be given a transaction object to reuse, if not create one
  var txn = opts.ctx;
  if (!txn) {
    txn = db.transaction([DOC_STORE], 'readonly');
  }

  txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {

    var doc = e.target.result;
    var rev = opts.rev || (doc && doc.rev);

    if (!doc || (doc.deleted && !opts.rev) || !(rev in doc.revs)) {
      callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, 'missing'));
      return;
    }

    var result = doc.revs[rev].data;
    result._id = doc.id;
    result._rev = rev;

    // WARNING: expecting possible old format
    callback(null, {
      doc: result,
      metadata: doc,
      ctx: txn
    });

  };
}

function getAttachment (db, docId, attachId, opts, cb) {

  var txn = opts.ctx;
  if (!txn) {
    txn = db.transaction([DOC_STORE], 'readonly');
  }

  txn.objectStore(DOC_STORE).get(docId).onsuccess = function (e) {

    var doc = e.target.result;
    var rev = opts.rev ? doc.revs[opts.rev].data : doc.data;
    var digest = rev._attachments[attachId].digest;

    if (opts.binary) {
      cb(null, doc.attachments[digest].data);
    } else {
      pouchdbBinaryUtils.readAsBinaryString(doc.attachments[digest].data, function (binString) {
        cb(null, pouchdbBinaryUtils.btoa(binString));
      });
    }
  };
}

function bulkDocs (db, req, opts, metadata, dbOpts, idbChanges, callback) {

  var txn;

  // TODO: I would prefer to get rid of these globals
  var error;
  var results = [];
  var docs = [];

  var revsLimit = dbOpts.revs_limit || 1000;

  // We only need to track 1 revision for local documents
  function docsRevsLimit(doc) {
    return /^_local/.test(doc.id) ? 1 : revsLimit;
  }

  function rootIsMissing(doc) {
    return doc.rev_tree[0].ids[1].status === 'missing';
  }

  function parseBase64(data) {
    try {
      return atob(data);
    } catch (e) {
      return {
        error: pouchdbErrors.createError(pouchdbErrors.BAD_ARG, 'Attachment is not a valid base64 string')
      };
    }
  }

  // Reads the original doc from the store if available
  // TODO: I think we can use getAll to remove most of this ugly code?
  function fetchExistingDocs(txn, docs) {
    var fetched = 0;
    var oldDocs = {};

    function readDone(e) {
      if (e.target.result) {
        oldDocs[e.target.result.id] = e.target.result;
      }
      if (++fetched === docs.length) {
        processDocs(txn, docs, oldDocs);
      }
    }

    docs.forEach(function (doc) {
      txn.objectStore(DOC_STORE).get(doc.id).onsuccess = readDone;
    });
  }

  function processDocs(txn, docs, oldDocs) {

    docs.forEach(function (doc, i) {
      var newDoc;

      // The first document write cannot be a deletion
      if ('was_delete' in opts && !(oldDocs.hasOwnProperty(doc.id))) {
        newDoc = pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, 'deleted');

      // The first write of a document cannot specify a revision
      } else if (opts.new_edits &&
                 !oldDocs.hasOwnProperty(doc.id) &&
                 rootIsMissing(doc)) {
        newDoc = pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);

      // Update the existing document
      } else if (oldDocs.hasOwnProperty(doc.id)) {
        newDoc = update(txn, doc, oldDocs[doc.id]);
        // The update can be rejected if it is an update to an existing
        // revision, if so skip it
        if (newDoc == false) {
          return;
        }

      // New document
      } else {
        // Ensure new documents are also stemmed
        var merged = pouchdbMerge.merge([], doc.rev_tree[0], docsRevsLimit(doc));
        doc.rev_tree = merged.tree;
        doc.stemmedRevs = merged.stemmedRevs;
        newDoc = doc;
        newDoc.isNewDoc = true;
        newDoc.wasDeleted = doc.revs[doc.rev].deleted ? 1 : 0;
      }

      if (newDoc.error) {
        results[i] = newDoc;
      } else {
        oldDocs[newDoc.id] = newDoc;
        write(txn, newDoc, i);
      }
    });
  }

  // Converts from the format returned by parseDoc into the new format
  // we use to store
  function convertDocFormat(doc) {

    var newDoc = {
      id: doc.metadata.id,
      rev: doc.metadata.rev,
      rev_tree: doc.metadata.rev_tree,
      writtenRev: doc.metadata.rev,
      revs: doc.metadata.revs || {}
    };

    newDoc.revs[newDoc.rev] = {
      data: doc.data,
      deleted: doc.metadata.deleted
    };

    return newDoc;
  }

  function update(txn, doc, oldDoc) {

    // Ignore updates to existing revisions
    if (doc.rev in oldDoc.revs) {
      return false;
    }

    var isRoot = /^1-/.test(doc.rev);

    // Reattach first writes after a deletion to last deleted tree
    if (oldDoc.deleted && !doc.deleted && opts.new_edits && isRoot) {
      var tmp = doc.revs[doc.rev].data;
      tmp._rev = oldDoc.rev;
      tmp._id = oldDoc.id;
      doc = convertDocFormat(pouchdbAdapterUtils.parseDoc(tmp, opts.new_edits));
    }

    var merged = pouchdbMerge.merge(oldDoc.rev_tree, doc.rev_tree[0], docsRevsLimit(doc));
    doc.stemmedRevs = merged.stemmedRevs;
    doc.rev_tree = merged.tree;

    // Merge the old and new rev data
    var revs = oldDoc.revs;
    revs[doc.rev] = doc.revs[doc.rev];
    doc.revs = revs;

    doc.attachments = oldDoc.attachments;

    var inConflict = opts.new_edits && (((oldDoc.deleted && doc.deleted) ||
       (!oldDoc.deleted && merged.conflicts !== 'new_leaf') ||
       (oldDoc.deleted && !doc.deleted && merged.conflicts === 'new_branch')));

    if (inConflict) {
      return pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);
    }

    doc.wasDeleted = oldDoc.deleted;

    return doc;
  }

  function write(txn, doc, i) {

    // We copy the data from the winning revision into the root
    // of the document so that it can be indexed
    var winningRev = pouchdbMerge.winningRev(doc);
    var isLocal = /^_local/.test(doc.id);

    doc.data = doc.revs[winningRev].data;
    doc.rev = winningRev;
    // .deleted needs to be an int for indexing
    doc.deleted = doc.revs[winningRev].deleted ? 1 : 0;

    // Bump the seq for every new (non local) revision written
    // TODO: index expects a unique seq, not sure if ignoring local will
    // work
    if (!isLocal) {
      doc.seq = ++metadata.seq;

      var delta = 0;
      // If its a new document, we wont decrement if deleted
      if (doc.isNewDoc) {
        delta = doc.deleted ? 0 : 1;
      } else if (doc.wasDeleted !== doc.deleted) {
        delta = doc.deleted ? -1 : 1;
      }
      metadata.doc_count += delta;
    }
    delete doc.isNewDoc;
    delete doc.wasDeleted;

    doc.deletedOrLocal = doc.deleted || isLocal ? 1 : 0;

    // If there have been revisions stemmed when merging trees,
    // delete their data
    if (doc.stemmedRevs) {
      doc.stemmedRevs.forEach(function (rev) { delete doc.revs[rev]; });
    }
    delete doc.stemmedRevs;

    if (!('attachments' in doc)) {
      doc.attachments = {};
    }

    if (doc.data._attachments) {
      for (var k in doc.data._attachments) {
        var attachment = doc.data._attachments[k];
        if (attachment.stub) {
          if (!(attachment.digest in doc.attachments)) {
            error = pouchdbErrors.createError(pouchdbErrors.MISSING_STUB);
            // TODO: Not sure how safe this manual abort is, seeing
            // console issues
            txn.abort();
            return;
          }

          doc.attachments[attachment.digest].revs[doc.writtenRev] = true;

        } else {

          doc.attachments[attachment.digest] = attachment;
          doc.attachments[attachment.digest].revs = {};
          doc.attachments[attachment.digest].revs[doc.writtenRev] = true;

          doc.data._attachments[k] = {
            stub: true,
            digest: attachment.digest,
            content_type: attachment.content_type,
            length: attachment.length,
            revpos: parseInt(doc.writtenRev, 10)
          };
        }
      }
    }
    delete doc.writtenRev;

    // Local documents have different revision handling
    if (isLocal && doc.deleted) {
      txn.objectStore(DOC_STORE).delete(doc.id).onsuccess = function () {
        results[i] = {
          ok: true,
          id: doc.id,
          rev: '0-0'
        };
      };
      return;
    }

    txn.objectStore(DOC_STORE).put(doc).onsuccess = function () {
      results[i] = {
        ok: true,
        id: doc.id,
        rev: doc.rev
      };
    };
  }

  function preProcessAttachment(attachment) {
    if (attachment.stub) {
      return Promise.resolve(attachment);
    }
    if (typeof attachment.data === 'string') {
      var asBinary = parseBase64(attachment.data);
      if (asBinary.error) {
        return Promise.reject(asBinary.error);
      }
      attachment.data =
        pouchdbBinaryUtils.binaryStringToBlobOrBuffer(asBinary, attachment.content_type);
      attachment.length = asBinary.length;
      return pouchdbMd5.binaryMd5(asBinary).then(function (result) {
        attachment.digest = 'md5-' + result;
        return attachment;
      });
    } else {
      return new Promise(function (resolve) {
        pouchdbBinaryUtils.readAsArrayBuffer(attachment.data, function (buff) {
          pouchdbMd5.binaryMd5(buff).then(function (result) {
            attachment.digest = 'md5-' + result;
            attachment.length = buff.byteLength;
            resolve(attachment);
          });
        });
      });
    }
  }

  function preProcessAttachments() {
    var promises = docs.map(function (doc) {
      var data = doc.revs[doc.rev].data;
      if (!data._attachments) {
        return Promise.resolve(data);
      }
      var attachments = Object.keys(data._attachments).map(function (k) {
        data._attachments[k].name = k;
        return preProcessAttachment(data._attachments[k]);
      });

      return Promise.all(attachments).then(function (newAttachments) {
        var processed = {};
        newAttachments.forEach(function (attachment) {
          processed[attachment.name] = attachment;
          delete attachment.name;
        });
        data._attachments = processed;
        return data;
      });
    });
    return Promise.all(promises);
  }

  for (var i = 0, len = req.docs.length; i < len; i++) {
    var result;
    // TODO: We should get rid of throwing for invalid docs, also not sure
    // why this is needed in idb-next and not idb
    try {
      result = pouchdbAdapterUtils.parseDoc(req.docs[i], opts.new_edits);
    } catch (err) {
      result = err;
    }
    if (result.error) {
      return callback(result);
    }

    // Ideally parseDoc would return data in this format, but it is currently
    // shared
    var newDoc = {
      id: result.metadata.id,
      rev: result.metadata.rev,
      rev_tree: result.metadata.rev_tree,
      revs: {}
    };

    newDoc.revs[newDoc.rev] = {
      data: result.data,
      deleted: result.metadata.deleted
    };

    docs.push(convertDocFormat(result));
  }

  preProcessAttachments().then(function () {

    txn = db.transaction([DOC_STORE], 'readwrite');

    txn.onabort = function () {
      callback(error);
    };
    txn.ontimeout = idbError(callback);

    txn.oncomplete = function () {
      idbChanges.notify(dbOpts.name);
      callback(null, results);
    };

    // We would like to use promises here, but idb sucks
    fetchExistingDocs(txn, docs);
  }).catch(function (err) {
    callback(err);
  });
}

function createKeyRange(start, end, inclusiveEnd, key, descending) {
  try {
    if (start && end) {
      if (descending) {
        return IDBKeyRange.bound(end, start, !inclusiveEnd, false);
      } else {
        return IDBKeyRange.bound(start, end, false, !inclusiveEnd);
      }
    } else if (start) {
      if (descending) {
        return IDBKeyRange.upperBound(start);
      } else {
        return IDBKeyRange.lowerBound(start);
      }
    } else if (end) {
      if (descending) {
        return IDBKeyRange.lowerBound(end, !inclusiveEnd);
      } else {
        return IDBKeyRange.upperBound(end, !inclusiveEnd);
      }
    } else if (key) {
      return IDBKeyRange.only(key);
    }
  } catch (e) {
    return {error: e};
  }
  return null;
}

function handleKeyRangeError(opts, metadata, err, callback) {
  if (err.name === "DataError" && err.code === 0) {
    // data error, start is less than end
    return callback(null, {
      total_rows: metadata.doc_count,
      offset: opts.skip,
      rows: []
    });
  }
  callback(pouchdbErrors.createError(pouchdbErrors.IDB_ERROR, err.name, err.message));
}

function allDocs (idb, metadata, opts, callback) {

  // TODO: Weird hack, I dont like it
  if (opts.limit === 0) {
    return callback(null, {
      total_rows: metadata.doc_count,
      offset: opts.skip,
      rows: []
    });
  }

  var results = [];
  var processing = [];

  var start = 'startkey' in opts ? opts.startkey : false;
  var end = 'endkey' in opts ? opts.endkey : false;
  var key = 'key' in opts ? opts.key : false;
  var skip = opts.skip || 0;
  var limit = typeof opts.limit === 'number' ? opts.limit : -1;
  var inclusiveEnd = opts.inclusive_end !== false;
  var descending = 'descending' in opts && opts.descending ? 'prev' : null;

  var keyRange = createKeyRange(start, end, inclusiveEnd, key, descending);
  if (keyRange && keyRange.error) {
    return handleKeyRangeError(opts, metadata, keyRange.error, callback);
  }

  var txn = idb.transaction([DOC_STORE], 'readonly');
  var docStore = txn.objectStore(DOC_STORE);

  var cursor = descending ?
    docStore.openCursor(keyRange, descending) :
    docStore.openCursor(keyRange);

  cursor.onsuccess = function (e) {

    var doc = e.target.result && e.target.result.value;

    // TODO: I have seen this before, but want to make sure I
    // know exactly why its needed
    if (!doc) { return; }

    // Skip local docs
    if (/^_local/.test(doc.id)) {
      return e.target.result.continue();
    }

    var row = {
      id: doc.id,
      key: doc.id,
      value: {
        rev: doc.rev
      }
    };

    function include_doc(row, doc) {

      row.doc = doc.data;
      row.doc._id = doc.id;
      row.doc._rev = doc.rev;

      if (opts.conflicts) {
        row.doc._conflicts = pouchdbMerge.collectConflicts(doc);
      }

      if (opts.attachments && doc.data._attachments) {
        for (var name in doc.data._attachments) {
          processing.push(processAttachment(name, doc, row.doc, opts.binary));
        }
      }
    }

    var deleted = doc.deleted;

    // TODO: I do not like this code
    if (opts.deleted === 'ok') {
      results.push(row);
      if (deleted) {
        row.value.deleted = true;
        row.doc = null;
      } else if (opts.include_docs) {
        include_doc(row, doc);
      }
    } else if (!deleted && skip-- <= 0) {
      results.push(row);
      if (opts.include_docs) {
        include_doc(row, doc);
      }
      if (--limit === 0) {
        return;
      }
    }
    e.target.result.continue();
  };

  txn.oncomplete = function () {
    Promise.all(processing).then(function () {
      callback(null, {
        total_rows: metadata.doc_count,
        offset: 0,
        rows: results
      });
    });
  };

}

function changes (idb, idbChanges, api, dbOpts, opts) {

  if (opts.continuous) {
    var id = dbOpts.name + ':' + pouchdbUtils.uuid();
    idbChanges.addListener(dbOpts.name, id, api, opts);
    idbChanges.notify(dbOpts.name);
    return {
      cancel: function () {
        idbChanges.removeListener(dbOpts.name, id);
      }
    };
  }

  var limit = 'limit' in opts ? opts.limit : -1;
  if (limit === 0) {
    limit = 1;
  }

  var returnDocs = 'return_docs' in opts ? opts.return_docs :
    'returnDocs' in opts ? opts.returnDocs : true;

  var txn = idb.transaction([DOC_STORE], 'readonly');
  var store = txn.objectStore(DOC_STORE).index('seq');

  var filter = pouchdbUtils.filterChange(opts);
  var received = 0;

  var lastSeq = opts.since || 0;
  var results = [];

  var processing = [];

  function onReqSuccess(e) {
    if (!e.target.result) { return; }
    var cursor = e.target.result;
    var doc = cursor.value;
    doc.data._id = doc.id;
    doc.data._rev = doc.rev;
    if (doc.deleted) {
      doc.data._deleted = true;
    }

    if (opts.doc_ids && opts.doc_ids.indexOf(doc.id) === -1) {
      return cursor.continue();
    }

    // WARNING: expecting possible old format
    var change = opts.processChange(doc.data, doc, opts);
    change.seq = doc.seq;
    lastSeq = doc.seq;
    var filtered = filter(change);

    // If its an error
    if (typeof filtered === 'object') {
      return opts.complete(filtered);
    }

    if (filtered) {
      received++;
      if (returnDocs) {
        results.push(change);
      }

      if (opts.include_docs && opts.attachments && doc.data._attachments) {
        var promises = [];
        for (var name in doc.data._attachments) {
          var p = processAttachment(name, doc, change.doc, opts.binary);
          // We add the processing promise to 2 arrays, one tracks all
          // the promises needed before we fire onChange, the other
          // ensure we process all attachments before onComplete
          promises.push(p);
          processing.push(p);
        }

        Promise.all(promises).then(function () {
          opts.onChange(change);
        });
      } else {
        opts.onChange(change);
      }
    }
    if (received !== limit) {
      cursor.continue();
    }
  }

  function onTxnComplete() {
    Promise.all(processing).then(function () {
      opts.complete(null, {
        results: results,
        last_seq: lastSeq
      });
    });
  }

  var req;
  if (opts.descending) {
    req = store.openCursor(null, 'prev');
  } else {
    req = store.openCursor(IDBKeyRange.lowerBound(opts.since, true));
  }

  txn.oncomplete = onTxnComplete;
  req.onsuccess = onReqSuccess;
}

function getRevisionTree (db, id, callback) {
  var txn = db.transaction([DOC_STORE], 'readonly');
  var req = txn.objectStore(DOC_STORE).get(id);
  req.onsuccess = function (e) {
    if (!e.target.result) {
      callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
    } else {
      callback(null, e.target.result.rev_tree);
    }
  };
}

function doCompaction (idb, id, revs, callback) {

  var txn = idb.transaction([DOC_STORE], 'readwrite');

  txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {
    var doc = e.target.result;

    pouchdbMerge.traverseRevTree(doc.rev_tree, function (isLeaf, pos, revHash, ctx, opts) {
      var rev = pos + '-' + revHash;
      if (revs.indexOf(rev) !== -1) {
        opts.status = 'missing';
      }
    });

    var attachments = [];

    revs.forEach(function (rev) {
      if (rev in doc.revs) {
        // Make a list of attachments that are used by the revisions being
        // deleted
        if (doc.revs[rev].data._attachments) {
          for (var k in doc.revs[rev].data._attachments) {
            attachments.push(doc.revs[rev].data._attachments[k].digest);
          }
        }
        delete doc.revs[rev];
      }
    });

    // Attachments have a list of revisions that are using them, when
    // that list becomes empty we can delete the attachment.
    attachments.forEach(function (digest) {
      revs.forEach(function (rev) {
        delete doc.attachments[digest].revs[rev];
      });
      if (!Object.keys(doc.attachments[digest].revs).length) {
        delete doc.attachments[digest];
      }
    });

    txn.objectStore(DOC_STORE).put(doc);
  };

  txn.oncomplete = function () {
    callback();
  };
}

function destroy (dbOpts, openDatabases, idbChanges, callback) {

  idbChanges.removeAllListeners(dbOpts.name);

  function doDestroy() {
    var req = indexedDB.deleteDatabase(dbOpts.name);
    req.onsuccess = function () {
      delete openDatabases[dbOpts.name];
      callback(null, {ok: true});
    };
  }

  // If the database is open we need to close it
  if (dbOpts.name in openDatabases) {
    openDatabases[dbOpts.name].then(function (res) {
      res.idb.close();
      doDestroy();
    });
  } else {
    doDestroy();
  }

}

var ADAPTER_NAME = 'indexeddb';

// TODO: Constructor should be capitalised
var idbChanges = new pouchdbUtils.changesHandler();

// A shared list of database handles
var openDatabases = {};

function IdbPouch(dbOpts, callback) {

  var api = this;
  var metadata = {};

  // This is a wrapper function for any methods that need an
  // active database handle it will recall itself but with
  // the database handle as the first argument
  var $ = function (fun) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      setup(openDatabases, api, dbOpts).then(function (res) {
        metadata = res.metadata;
        args.unshift(res.idb);
        fun.apply(api, args);
      });
    };
  };

  api.type = function () { return ADAPTER_NAME; };

  api._id = $(function (idb, cb) {
    cb(null, metadata.db_uuid);
  });

  api._info = $(function (idb, cb) {
    return info(idb, metadata, cb);
  });

  api._get = $(get);

  api._bulkDocs = $(function (idb, req, opts, callback) {
    return bulkDocs(idb, req, opts, metadata, dbOpts, idbChanges, callback);
  });

  api._allDocs = $(function (idb, opts, cb) {
    return allDocs(idb, metadata, opts, cb);
  });

  api._getAttachment = $(function (idb, docId, attachId, attachment, opts, cb) {
    return getAttachment(idb, docId, attachId, opts, cb);
  });

  api._changes = $(function (idb, opts) {
    return changes(idb, idbChanges, api, dbOpts, opts);
  });

  api._getRevisionTree = $(getRevisionTree);
  api._doCompaction = $(doCompaction);

  api._destroy = function (opts, callback) {
    return destroy(dbOpts, openDatabases, idbChanges, callback);
  };

  api._close = $(function (db, cb) {
    delete openDatabases[dbOpts.name];
    db.close();
    cb();
  });

  // TODO: this setTimeout seems nasty, if its needed lets
  // figure out / explain why
  setTimeout(function () {
    callback(null, api);
  });
}

// TODO: this isnt really valid permanently, just being lazy to start
IdbPouch.valid = function () {
  return true;
};

function index (PouchDB) {
  PouchDB.adapter(ADAPTER_NAME, IdbPouch, true);
}

module.exports = index;