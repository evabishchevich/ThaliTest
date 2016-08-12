'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var CoreLevelPouch = _interopDefault(require('pouchdb-adapter-leveldb-core'));
var jsExtend = require('js-extend');
var fruitdown = _interopDefault(require('fruitdown'));

function FruitDownPouch(opts, callback) {
  var _opts = jsExtend.extend({
    db: fruitdown
  }, opts);

  CoreLevelPouch.call(this, _opts, callback);
}

// overrides for normal LevelDB behavior on Node
FruitDownPouch.valid = function () {
  return !!global.indexedDB;
};
FruitDownPouch.use_prefix = true;

function index (PouchDB) {
  PouchDB.adapter('fruitdown', FruitDownPouch, true);
}

module.exports = index;