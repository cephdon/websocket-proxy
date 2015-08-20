'use strict';

var argv = require('yargs')
    .count('verbose')
    .alias('v', 'verbose')
    .argv;
var listenPort = argv.listenPort || 8888,
    listenHost = argv.listenHost || '127.0.0.1',
    backendPort = argv.backendPort || 8855,
    backendHost = argv.backendHost || '127.0.0.1';

var http = require('http'),
    net = require('net'),
    url = require('url'),
    fs = require('fs'),
    websocket = require('websocket-driver'),
    Extensions = require('websocket-extensions'),
    deflate = require('permessage-deflate'),
    winston = require('winston');

var server = http.createServer();

var log = fs.existsSync('log.js') ? require('./log') : new(winston.Logger)({
    transports: [
        new(winston.transports.Console)({
            level: 'verbose',
            timestamp: function() {
                return (new Date()).toISOString();
            },
            formatter: function(options) {
                // Return string will be passed to logger.
                return options.timestamp() + ' ' + options.level.toUpperCase() + ' ' + (undefined !== options.message ? options.message : '') +
                    (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON.stringify(options.meta) : '');
            }
        })
    ]
});

// if argv.verbose
// log.transports.console.level = 'silly';

var Hybi = {};
var crypto = require('crypto');
Hybi.generateAccept = function(key) {
    var sha1 = crypto.createHash('sha1');
    sha1.update(key + Hybi.GUID);
    return sha1.digest('base64');
};

Hybi.GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';


var exts = new Extensions();
exts.add(deflate);

server.on('upgrade', function(request, socket, body) {
    if (!websocket.isWebSocket(request))
        return;

    var clientId = socket.remoteAddress + ':' + socket.remotePort,
        log_ = function() {
            var args = Array.prototype.slice.call(arguments);
            args[1] = 'remote %s: ' + args[1];
            args.splice(2, 0, clientId);
            log.log.apply(log, args);
        };
    // console.log(request.headers['x-forwarded-for'] || request.connection.remoteAddress);
    log_('verbose', 'connected to client, x-forwarded-for: %s', request.headers['x-forwarded-for']);

    var driver = websocket.http(request);
    driver.addExtension(deflate);

    driver.io.write(body);
    socket.pipe(driver.io).pipe(socket);

    var clientDriver = websocket.client('ws://' + backendHost + ':' + backendPort + request.url),
        tcp = net.connect(8855, 'localhost');

    tcp.pipe(clientDriver.io).pipe(tcp);

    tcp.on('connect', function() {
        log_('verbose', 'connected to backend (%s) via %s', tcp.remoteAddress + ':' + tcp.remotePort, tcp.localAddress + ':' + tcp.localPort);

        clientDriver._headers.clear();
        // clientDriver.setHeader('Host', '');
        clientDriver.setHeader('Upgrade', 'websocket');
        clientDriver.setHeader('Connection', 'Upgrade');
        clientDriver.setHeader('Sec-WebSocket-Key', request.headers['sec-websocket-key']);
        clientDriver._key = request.headers['sec-websocket-key'];
        clientDriver._accept = Hybi.generateAccept(request.headers['sec-websocket-key']);
        clientDriver.setHeader('Sec-WebSocket-Version', '13'); // FIXME this may change

        for (var header in request.headers) {
            if (header.indexOf('sec-websocket') !== 0) {
                clientDriver.setHeader(header, request.headers[header]);
            }
        }
        clientDriver.start();
        driver.start();
    });
    tcp.on('error', function(err) {
        log_('verbose', 'error in backend tcp: %s', err);
    });
    socket.on('error', function(err) {
        log_('verbose', 'error in client tcp: %s', err);
    });

    driver.once('close', function() {
        log_('verbose', 'closed connection');
        clientDriver.close();
        socket.destroy();
    });
    clientDriver.once('close', function() {
        driver.close();
        tcp.destroy();
    });

    driver.messages.on('data', function(message) {
        log_('silly', 'received a message from backend', message);
        clientDriver.messages.write(message);
    });

    clientDriver.messages.on('data', function(message) {
        log_('silly', 'received a message from client', message);
        driver.messages.write(message);
    });
});

server.listen(listenPort, listenHost, function(err) {
    if (err) {
        log.error(err);
        process.exit(err.errno || 1);
    } else {
        log.info('Listening on ' + listenHost + ':' + listenPort);
    }
});
