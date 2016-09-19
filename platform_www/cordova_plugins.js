cordova.define('cordova/plugin_list', function(require, exports, module) {
module.exports = [
    {
        "id": "io.jxcore.node.jxcore",
        "file": "plugins/io.jxcore.node/www/jxcore.js",
        "pluginId": "io.jxcore.node",
        "clobbers": [
            "jxcore"
        ]
    },
    {
        "id": "org.thaliproject.p2p.ThaliPermissions",
        "file": "plugins/org.thaliproject.p2p/www/android/thaliPermissions.js",
        "pluginId": "org.thaliproject.p2p",
        "clobbers": [
            "window.ThaliPermissions"
        ]
    }
];
module.exports.metadata = 
// TOP OF METADATA
{
    "cordova-plugin-whitelist": "1.3.0",
    "io.jxcore.node": "0.1.4",
    "org.thaliproject.p2p": "0.0.1"
};
// BOTTOM OF METADATA
});