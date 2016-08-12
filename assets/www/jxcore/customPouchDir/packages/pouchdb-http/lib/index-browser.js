'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var PouchDB = _interopDefault(require('pouchdb-core'));
var HttpPouch = _interopDefault(require('pouchdb-adapter-http'));

PouchDB.plugin(HttpPouch);

module.exports = PouchDB;