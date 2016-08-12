'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var PouchDB = _interopDefault(require('pouchdb-core'));
var LevelPouch = _interopDefault(require('pouchdb-adapter-leveldb'));
var HttpPouch = _interopDefault(require('pouchdb-adapter-http'));
var mapreduce = _interopDefault(require('pouchdb-mapreduce'));
var replication = _interopDefault(require('pouchdb-replication'));

PouchDB.plugin(LevelPouch)
  .plugin(HttpPouch)
  .plugin(mapreduce)
  .plugin(replication);

module.exports = PouchDB;