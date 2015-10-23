'use strict';

var BBPromise = require('bluebird');
var preq = require('preq');
var sUtil = require('../lib/util');
var vega = require('../lib/vega');


/**
 * The main router object
 */
var router = sUtil.router();

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

// NOTE: there are a few libraries that do this
function merge() {
    var result = {},
        args = Array.prototype.slice.apply(arguments);

    args.forEach(function (arg) {
        Object.getOwnPropertyNames(arg).forEach(function (prop) {
            result[prop] = arg[prop];
        });
    });

    return result;
}

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

    var start = Date.now();

    var p = state.request.params,
        format = p.format,
        domain = p.domain,
        title = p.title,
        revid = p.revid,
        id_ext = p.id.split('.', 2),
        id = id_ext[0],
        ext = id_ext[1];

    state.log = p; // log all parameters of the request

    state.apiRequest = {
        format: 'json',
        action: 'query',
        prop: 'pageprops',
        ppprop: 'graph_specs',
        continue: ''
    };

    // check the format / extension
    if (ext && ext !== format) {
        throw new Err('info/param-ext', 'req.ext');
    }
    if (format !== 'png') {
        throw new Err('info/param-format', 'req.format');
    }

    if (revid) {
        if (!/^[0-9]+$/.test(revid)) {
            // must be a non-negative integer
            throw new Err('info/param-revid', 'req.revid');
        }
        revid = parseInt(revid);
    }

    if (revid) {
        state.apiRequest.revids = revid;
    } else if (title) {
        if (title.indexOf('|') > -1) {
            throw new Err('info/param-title', 'req.title');
        }
        state.apiRequest.titles = title;
    } else {
        throw new Err('info/param-page', 'req.page');
    }

    if (!/^[0-9a-f]+$/.test(id)) {
        throw new Err('info/param-id', 'req.id');
    }
    state.graphId = id;

    if (!vega.serverRe.test(domain)) {
        throw new Err('info/param-domain', 'req.domain');
    }

    // TODO: Optimize 'en.m.wikipedia.org' -> 'en.wikipedia.org'
    var domain2 = (vega.domainMap && vega.domainMap[domain]) || domain;

    state.domain = domain2;
    state.apiUrl = vega.defaultProtocol + '://' + domain2 + '/w/api.php';
    if (domain !== domain2) {
        state.log.backend = domain2;
    }

    // Log which wiki is actually requesting this
    if (domain.endsWith('.org')) {
        domain = domain.substr(0, domain.length - 4);
    }
    metrics.endTiming('total.req.' + domain.replace('.', '-'), start);

    return state;
}

/**
 * Retrieve graph specifications from the domain
 * @param state is the object with the current state of the request processing
 */
function downloadGraphDef(state) {

    var startDefDownload = Date.now();
    state.log.calls = [];

    // http://stackoverflow.com/questions/24660096/correct-way-to-write-loops-for-promise
    var loopAsync = BBPromise.method(function (action, condition, value) {
        var req = condition(value);
        if (req) {
            return action(req).then(loopAsync.bind(null, action, condition));
        }
    });

    return loopAsync(function (req) {

        var startApiReq = Date.now();
        state.log.calls.push(req);
        var requestOpts = {
            uri: state.apiUrl,
            query: req,
            headers: {'User-Agent': 'graphoid (yurik at wikimedia)'}
        };
        return preq(requestOpts)
            .then(function (resp) {
                metrics.endTiming('total.mwapicall', startApiReq);
                return resp;
            });

    }, function (apiRes) {

        // If first run, always allow
        if (!apiRes) {
            return state.apiRequest;
        }

        if (apiRes.status !== 200) {
            state.log.apiRetStatus = apiRes.status;
            throw new Err('error/mwapi-status', 'mwapi.bad-status');
        }

        var res = apiRes.body;
        if (res.hasOwnProperty('error')) {
            state.log.apiRetError = res.error;
            throw new Err('error/mwapi-error', 'mwapi.error');
        }

        if (res.hasOwnProperty('warnings')) {
            state.log.apiWarning = res.warnings;
            state.request.logger.log('info/mwapi-warning', state.log);
            // Warnings are usually safe to continue
        }

        if (res.hasOwnProperty('query') && res.query.hasOwnProperty('pages')) {
            var pages = res.query.pages,
                graphData = null;

            Object.getOwnPropertyNames(pages).some(function (k) {
                var page = pages[k];
                if (page.hasOwnProperty('pageprops') && page.pageprops.hasOwnProperty('graph_specs')) {
                    try {
                        var gs = JSON.parse(page.pageprops.graph_specs);

                        if (gs.hasOwnProperty(state.graphId)) {
                            graphData = gs[state.graphId];
                            return true;
                        }
                    } catch (err) {
                        throw new Err('error/bad-json', 'mwapi.bad-json');
                    }
                }
                return false;
            });

            if (graphData) {
                state.graphData = graphData;
                return false; // found needed result
            }
        }
        if (res.hasOwnProperty('continue')) {
            return merge(state.apiRequest, res.continue);
        }
        throw new Err('info/mwapi-no-graph', 'mwapi.no-graph');

    }).then(function () {
        metrics.endTiming('total.mwapi', startDefDownload);
        return state;
    });
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
router.get('/:format/:title/:revid/:id', function(req, res) {

    var start = Date.now();
    var state = {request: req, response: res};

    var render = BBPromise
        .resolve(state)
        .then(validateRequest)
        .then(downloadGraphDef)
        .then(renderOnCanvas);

    return failOnTimeout(render, timeout)
        .then(function () {

            // SUCCESS
            // For now, record everything, but soon we should scale it back
            req.logger.log('trace/ok', state.log);
            metrics.endTiming('total.success', start);

        }, function (reason) {

            // FAILURE
            var l = state.log;
            var msg = 'error/unknown',
                mx = 'error.unknown';

            if (reason instanceof Err) {
                l = merge(reason, l);
                msg = reason.message;
                mx = reason.metrics;
                delete l.message;
                delete l.metrics;
            } else if (reason !== null && typeof reason === 'object') {
                l = merge(reason, l);
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
});


function init(app) {

    // The very first operation should set up our logger
    log = app.logger.log.bind(app.logger);
    metrics = app.metrics;

    log('info/init', 'starting v1');
    metrics.increment('v1.init');

    var conf = app.conf;
    timeout = conf.timeout || timeout;

    vega.initVega(log, conf.defaultProtocol, conf.domains, conf.domainMap);
}


module.exports = function(app) {

    init(app);

    return {
        path: '/',
        api_version: 1,
        router: router
    };
};
