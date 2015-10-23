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

    if (format !== 'png') {
        throw new Err('info/param-format', 'req.format');
    }

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

function renderOnCanvas(state) {
    var start = Date.now();
    return vega.render({
        domain: state.domain,
        renderOpts: {spec: state.graphData, renderer: 'canvas'}
    }).then(function (result) {
        var pendingPromise = BBPromise.pending();
        var stream = result.canvas.pngStream();
        state.response
            .status(200)
            .type('png')
            // For now, lets re-cache more frequently
            .header('Cache-Control', 'public, s-maxage=30, max-age=30');
        stream.on('data', function (chunk) {
            state.response.write(chunk);
        });
        stream.on('end', function () {
            state.response.end();
            metrics.endTiming('total.vega', start);
            pendingPromise.resolve(state);
        });
        return pendingPromise.promise;
    }).catch(function (err) {
        state.log.vegaErr = err;
        throw new Err('error/vega', 'vega.error');
    });
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
        .then(renderOnCanvas);

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
    router.post('/:format/:title', renderGraph);
    router.post('/:format/:title/:revid', renderGraph);

    return {
        path: '/',
        api_version: 2,
        router: router
    };
};
