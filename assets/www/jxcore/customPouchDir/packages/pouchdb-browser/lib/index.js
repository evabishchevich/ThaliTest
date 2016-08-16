'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var PouchDB = _interopDefault(require('pouchdb-core'));
var IDBPouch = _interopDefault(require('pouchdb-adapter-idb'));
var WebSqlPouch = _interopDefault(require('pouchdb-adapter-websql'));
var HttpPouch = _interopDefault(require('pouchdb-adapter-http'));
var mapreduce = _interopDefault(require('pouchdb-mapreduce'));
var replication = _interopDefault(require('pouchdb-replication'));

PouchDB.plugin(IDBPouch)
  .plugin(WebSqlPouch)
  .plugin(HttpPouch)
  .plugin(mapreduce)
  .plugin(replication);

module.exports = PouchDB;