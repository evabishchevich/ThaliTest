'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var CoreLevelPouch = _interopDefault(require('pouchdb-adapter-leveldb-core'));
var jsExtend = require('js-extend');
var memdown = _interopDefault(require('memdown'));

function MemDownPouch(opts, callback) {
  var _opts = jsExtend.extend({
    db: memdown
  }, opts);

  CoreLevelPouch.call(this, _opts, callback);
}

// overrides for normal LevelDB behavior on Node
MemDownPouch.valid = function () {
  return true;
};
MemDownPouch.use_prefix = false;

function index (PouchDB) {
  PouchDB.adapter('memory', MemDownPouch, true);
}

module.exports = index;