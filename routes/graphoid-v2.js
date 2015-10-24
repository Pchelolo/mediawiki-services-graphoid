'use strict';

var _ = require('underscore');
var BBPromise = require('bluebird');
var preq = require('preq');
var sUtil = require('../lib/util');
var vega = require('../lib/vega');


/**
 * Main log function
 */
var log;

/**
 * Metrics object
 */
var metrics;

/**
 * Limit request to 10 seconds by default
 */
var timeout = 10000;


/**
 * Async version of the can canvas.toBuffer()
 * @type {Function}
 */
var canvasToBuffer;

/*
 * Utility functions
 */

function Err(message, metrics) {
    this.message = message;
    this.metrics = metrics;
}
Err.prototype = Object.create(Error.prototype);
Err.prototype.constructor = Err;

// Adapted from https://www.promisejs.org/patterns/
function delay(time) {
    return new BBPromise(function (fulfill) {
        setTimeout(fulfill, time);
    });
}

function failOnTimeout(promise, time) {
    return time <= 0 ? promise :
        BBPromise.race([promise, delay(time).then(function () {
            throw 'timeout'; // we later compare on this value
        })]);
}

/**
 * Parse and validate request parameters
 */
function validateRequest(state) {

    var p = state.request.params,
        format = p.format,
        domain = p.domain,
        body = state.request.body;

    state.log = p; // log all parameters of the request

    if (format !== 'png' && format !== 'svg' && format !== 'all') {
        throw new Err('info/param-format', 'req.format');
    }
    state.format = format;

    if (!vega.serverRe.test(domain)) {
        throw new Err('info/param-domain', 'req.domain');
    }
    // TODO: Optimize 'en.m.wikipedia.org' -> 'en.wikipedia.org'
    var domain2 = (vega.domainMap && vega.domainMap[domain]) || domain;
    state.domain = domain2;
    if (domain !== domain2) {
        state.log.backend = domain2;
    }

    if (!body) {
        throw new Err('info/param-body', 'req.body');
    }
    state.graphData = body;

    // Log which wiki is actually requesting this
    if (domain.endsWith('.org')) {
        domain = domain.substr(0, domain.length - 4);
    }
    metrics.increment('req.' + domain.replace('.', '-'));

    return state;
}

function renderImage(state, isSvg) {
    return vega.render({
        domain: state.domain,
        renderOpts: {spec: state.graphData, renderer: isSvg ? 'svg' : 'canvas'}
    }).then(isSvg ? function (result) {
            return result.svg;
        } : function (result) {
            if (!canvasToBuffer) {
                canvasToBuffer = BBPromise.promisify(result.canvas.toBuffer);
            }
            return canvasToBuffer.call(result.canvas);
        }
    );
}

function renderRequest(state) {
    var start = Date.now();
    var headersToReturn = {};
    // headers always received in lower case
    if (state.request.headers.title) {
        headersToReturn.Title = state.request.headers.title;
    }
    if (state.request.headers.revisionid) {
        headersToReturn.RevisionId = state.request.headers.revisionid;
    }
    _.each(headersToReturn, function (val, key) {
        state.response.header(key, val);
    });

    var promise;
    if (state.format === 'all') {
        // TODO: BUG: Possible bug due to async - vega looses state
        promise = BBPromise.all([renderImage(state, false), renderImage(state, true)])
            .spread(function (pngData, svgData) {
                state.response.header('Cache-Control', 'public, s-maxage=30, max-age=30');
                state.response.json({
                    "headers": headersToReturn,
                    "data": {
                        "png": {
                            "headers": {"content-type": "image/png"},
                            "body": pngData
                        },
                        "svg": {
                            "headers": {"content-type": "image/svg+xml"},
                            "body": svgData
                        }
                    }
                });
                metrics.endTiming('total.vega', start);
            });
    } else {
        promise = renderImage(state, state.format === 'svg')
            .then(function (buffer) {
                state.response
                    .header('Cache-Control', 'public, s-maxage=30, max-age=30')
                    .type(state.format)
                    .send(buffer);
                metrics.endTiming('total.vega', start);
            });
    }
    return promise.catch(function (err) {
        state.log.vegaErr = err.message;
        state.log.vegaErrStack = err.stack;
        throw new Err('error/vega', 'vega.error');
    }).return(state);
}

/**
 * Main entry point for graphoid
 */
function renderGraph(req, res) {

    var start = Date.now();
    var state = {request: req, response: res};

    var render = BBPromise
        .resolve(state)
        .then(validateRequest)
        .then(renderRequest);

    return failOnTimeout(render, timeout)
        .then(function () {

            // SUCCESS
            metrics.endTiming('total.success', start);

        }, function (reason) {

            // FAILURE
            var l = state.log;
            var msg = 'error/unknown',
                mx = 'error.unknown';

            if (reason instanceof Err) {
                l = _.extend(reason, l);
                msg = reason.message;
                mx = reason.metrics;
                delete l.message;
                delete l.metrics;
            } else if (reason !== null && typeof reason === 'object') {
                l = _.extend(reason, l);
            } else {
                l.msg = reason;
            }

            res
                .status(400)
                .header('Cache-Control', 'public, s-maxage=30, max-age=30')
                .json(msg);
            metrics.increment(mx);
            req.logger.log(msg, l);
        });
}

module.exports = function(app) {

    // The very first operation should set up our logger
    log = app.logger.log.bind(app.logger);
    metrics = app.metrics;

    log('info/init', 'starting v2');
    metrics.increment('v2.init');

    var conf = app.conf;
    timeout = conf.timeout || timeout;

    vega.initVega(log, conf.defaultProtocol, conf.domains, conf.domainMap);

    var router = sUtil.router();
    //var bodyParser = require('body-parser').json();

    router.post('/:format', renderGraph);

    return {
        path: '/',
        api_version: 2,
        router: router
    };
};
