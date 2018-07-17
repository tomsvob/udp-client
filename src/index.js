var PORT = 33333;
var HOST = '127.0.0.1';
var dgram = require('dgram');
var message = new Buffer('My KungFu is Good!');
var AppMode;
(function (AppMode) {
    AppMode[AppMode["DownloadImage"] = 0] = "DownloadImage";
    AppMode[AppMode["SendFirmware"] = 1] = "SendFirmware";
    AppMode[AppMode["Error"] = 2] = "Error";
})(AppMode || (AppMode = {}));
switch (chooseMode()) {
    default:
        throw 'invalid arguments';
}
var client = dgram.createSocket('udp4');
client.send(message, 0, message.length, PORT, HOST, function (err, bytes) {
    if (err)
        throw err;
    console.log('UDP message sent to ' + HOST + ':' + PORT, bytes);
    client.close();
});
function chooseMode() {
    var numOfArgs = process.argv.length - 2;
    if (numOfArgs === 1) {
        return AppMode.DownloadImage;
    }
    else if (numOfArgs === 2) {
        return AppMode.SendFirmware;
    }
    else {
        return AppMode.Error;
    }
}
