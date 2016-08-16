'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var WebSqlPouchCore = _interopDefault(require('pouchdb-adapter-websql-core'));
var jsExtend = require('js-extend');
var pouchdbUtils = require('pouchdb-utils');

function canOpenTestDB() {
  try {
    openDatabase('_pouch_validate_websql', 1, '', 1);
    return true;
  } catch (err) {
    return false;
  }
}

// WKWebView had a bug where WebSQL would throw a DOM Exception 18
// (see https://bugs.webkit.org/show_bug.cgi?id=137760 and
// https://github.com/pouchdb/pouchdb/issues/5079)
// This has been fixed in latest WebKit, so we try to detect it here.
function isValidWebSQL() {
  // WKWebView UA:
  //   Mozilla/5.0 (iPhone; CPU iPhone OS 9_2 like Mac OS X)
  //   AppleWebKit/601.1.46 (KHTML, like Gecko) Mobile/13C75
  // Chrome for iOS UA:
  //   Mozilla/5.0 (iPhone; U; CPU iPhone OS 5_1_1 like Mac OS X; en)
  //   AppleWebKit/534.46.0 (KHTML, like Gecko) CriOS/19.0.1084.60
  //   Mobile/9B206 Safari/7534.48.3
  // Firefox for iOS UA:
  //   Mozilla/5.0 (iPhone; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4
  //   (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4

  // indexedDB is null on some UIWebViews and undefined in others
  // see: https://bugs.webkit.org/show_bug.cgi?id=137034
  if (typeof indexedDB === 'undefined' || indexedDB === null ||
      !/iP(hone|od|ad)/.test(navigator.userAgent)) {
    // definitely not WKWebView, avoid creating an unnecessary database
    return true;
  }
  // Cache the result in LocalStorage. Reason we do this is because if we
  // call openDatabase() too many times, Safari craps out in SauceLabs and
  // starts throwing DOM Exception 14s.
  var hasLS = pouchdbUtils.hasLocalStorage();
  // Include user agent in the hash, so that if Safari is upgraded, we don't
  // continually think it's broken.
  var localStorageKey = '_pouch__websqldb_valid_' + navigator.userAgent;
  if (hasLS && localStorage[localStorageKey]) {
    return localStorage[localStorageKey] === '1';
  }
  var openedTestDB = canOpenTestDB();
  if (hasLS) {
    localStorage[localStorageKey] = openedTestDB ? '1' : '0';
  }
  return openedTestDB;
}

function validWithoutCheckingCordova() {
  if (typeof openDatabase === 'undefined') {
    return false;
  }
  if (typeof sqlitePlugin !== 'undefined') {
    // Both sqlite-storage and SQLite Plugin 2 create this global object,
    // which we can check for to determine validity. It should be defined
    // after the 'deviceready' event.
    return true;
  }
  return isValidWebSQL();
}

function valid() {
  // The Cordova SQLite Plugin and SQLite Plugin 2 can be used in cordova apps,
  // and we can't know whether or not the plugin was loaded until after the
  // 'deviceready' event. Since it's impractical for us to wait for that event
  // before returning true/false for valid(), we just return true here
  // and notify the user that they may need a plugin.
  if (typeof cordova !== 'undefined') {
    return true;
  }
  return validWithoutCheckingCordova();
}

function createOpenDBFunction(opts) {
  return function (name, version, description, size) {
    if (typeof sqlitePlugin !== 'undefined') {
      // The SQLite Plugin started deviating pretty heavily from the
      // standard openDatabase() function, as they started adding more features.
      // It's better to just use their "new" format and pass in a big ol'
      // options object. Also there are many options here that may come from
      // the PouchDB constructor, so we have to grab those.
      var sqlitePluginOpts = jsExtend.extend({}, opts, {
        name: name,
        version: version,
        description: description,
        size: size
      });
      return sqlitePlugin.openDatabase(sqlitePluginOpts);
    }

    // Traditional WebSQL API
    return openDatabase(name, version, description, size);
  };
}

function WebSQLPouch(opts, callback) {
  var websql = createOpenDBFunction(opts);
  var _opts = jsExtend.extend({
    websql: websql
  }, opts);

  if (typeof cordova !== 'undefined' && !validWithoutCheckingCordova()) {
    pouchdbUtils.guardedConsole('error',
      'PouchDB error: you must install a SQLite plugin ' +
      'in order for PouchDB to work on this platform. Options:' +
      '\n - https://github.com/nolanlawson/cordova-plugin-sqlite-2' +
      '\n - https://github.com/litehelpers/Cordova-sqlite-storage' +
      '\n - https://github.com/Microsoft/cordova-plugin-websql');
  }

  WebSqlPouchCore.call(this, _opts, callback);
}

WebSQLPouch.valid = valid;

WebSQLPouch.use_prefix = true;

function index (PouchDB) {
  PouchDB.adapter('websql', WebSQLPouch, true);
}

module.exports = index;