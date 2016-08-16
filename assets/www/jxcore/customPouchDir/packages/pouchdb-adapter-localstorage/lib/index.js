'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var CoreLevelPouch = _interopDefault(require('pouchdb-adapter-leveldb-core'));
var jsExtend = require('js-extend');
var localstoragedown = _interopDefault(require('localstorage-down'));

function LocalStoragePouch(opts, callback) {
  var _opts = jsExtend.extend({
    db: localstoragedown
  }, opts);

  CoreLevelPouch.call(this, _opts, callback);
}

// overrides for normal LevelDB behavior on Node
LocalStoragePouch.valid = function () {
  return typeof localStorage !== 'undefined';
};
LocalStoragePouch.use_prefix = true;

function index (PouchDB) {
  PouchDB.adapter('localstorage', LocalStoragePouch, true);
}

module.exports = index;