'use strict';

var BBPromise = require('bluebird');
var preq = require('preq');
var domino = require('domino');
var sUtil = require('../lib/util');
var urllib = require('url');
var vega = require('vega'); // Visualization grammar - https://github.com/trifacta/vega

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
 * A set of 'oldDomain' => 'newDomain' mappings
 */
var domainMap = false;

/**
 * For protocol-relative URLs  (they begin with //), which protocol should we use
 */
var defaultProtocol = 'https';

/**
 * Limit request to 10 seconds by default
 */
var timeout = 10000;

/**
 * Regex to validate domain parameter
 */
var serverRe = null;


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
 * Init vega rendering
 * @param domains array of strings - which domains are valid
 */
function initVega(domains) {
    vega.config.domainWhiteList = domains;
    vega.config.defaultProtocol = defaultProtocol + ':';
    vega.config.safeMode = true;
    vega.config.isNode = true; // Vega is flaky with its own detection, fails in tests and with IDE debug

    // set up vega loggers to log to our device instead of stderr
    vega.log = function(msg) {
        log('debug/vega', msg);
    };
    vega.error = function(msg) {
        log('warn/vega', msg);
    };

    //
    // TODO/BUG:  In multithreaded env, we cannot set global vega.config var
    // while handling multiple requests from multiple hosts.
    // Until vega is capable of per-rendering context, we must bail on any
    // relative (no hostname) data or image URLs.
    //
    // Do not set vega.config.baseURL. Current sanitizer implementation will fail
    // because of the missing protocol (safeMode == true). Still, lets double check
    // here, in case user has   'http:pathname', which for some strange reason is
    // parsed as correct by url lib.
    //
    var originalSanitize = vega.data.load.sanitizeUrl.bind(vega.data.load);
    vega.data.load.sanitizeUrl = function (urlOrig) {
        var url = originalSanitize.call(vega.data.load, urlOrig);
        if (url) {
            var parts = urllib.parse(url);
            if (!parts.protocol || !parts.hostname) {
                url = null;
            } else if (parts.protocol !== 'http:' && parts.protocol !== 'https:') {
                // load.sanitizeUrl() already does this, but double check to be safe
                url = null;
            }
        }
        if (url && domainMap) {
            url = url.replace(/^(https?:\/\/)([^#?\/]+)/, function (match, prot, domain) {
                var repl = domainMap[domain];
                return repl ? prot + repl : match;
            });
        }

        if (!url) {
            log('debug/url-deny', urlOrig);
        } else if (urlOrig !== url) {
            log('debug/url-fix', {'req': urlOrig, 'repl': url});
        } else {
            log('trace/url-ok', urlOrig);
        }
        return url;
    };
}


/**
 * Parse and validate request parameters
 */
function validateRequest(state) {

    var start = Date.now();

    var p = state.request.params,
        domain = p.domain,
        title = p.title,
        revid = p.revid,
        id = p.id;

    state.log = p; // log all parameters of the request

    state.apiRequest = {
        format: 'json',
        action: 'query',
        prop: 'pageprops',
        ppprop: 'graph_specs',
        continue: ''
    };

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

    var parts = serverRe.exec(domain);
    if (!parts) {
        throw new Err('info/param-domain', 'req.domain');
    }
    // Remove optional part #2 from domain (makes m. links appear as desktop to optimize cache)
    // 1  2 3
    // en.m.wikipedia.org
    var domain2 = parts[3];
    if (parts[1]) {
        domain2 = parts[1] + domain2;
    }
    domain2 = (domainMap && domainMap[domain2]) || domain2;

    state.domain = domain2;
    state.apiUrl = defaultProtocol + '://' + domain2 + '/w/api.php';
    if (domain !== domain2) {
        state.log.backend = domain2;
    }

    metrics.endTiming('req.time', start);

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
            headers: {'User-Agent': 'graph.ext backend (yurik at wikimedia)'}
        };
        return preq(requestOpts)
            .then(function (resp) {
                metrics.endTiming('domain.time', startApiReq);
                return resp;
            });

    }, function (apiRes) {

        // If first run, always allow
        if (!apiRes) {
            return state.apiRequest;
        }

        if (apiRes.status !== 200) {
            state.log.apiRetStatus = apiRes.status;
            throw new Err('error/domain-status', 'domain.status');
        }

        var res = apiRes.body;
        if (res.hasOwnProperty('error')) {
            state.log.apiRetError = res.error;
            throw new Err('error/domain-error', 'domain.error');
        }

        if (res.hasOwnProperty('warnings')) {
            state.log.apiWarning = res.warnings;
            state.request.logger.log('info/domain-warning', state.log);
            // Warnings are usually safe to continue
        }

        if (res.hasOwnProperty('query') && res.query.hasOwnProperty('pages')) {
            var pages = res.query.pages,
                graphData = null;

            Object.getOwnPropertyNames(pages).some(function (k) {
                var page = pages[k];
                if (page.hasOwnProperty('pageprops') && page.pageprops.hasOwnProperty('graph_specs')) {
                    var gs = JSON.parse(page.pageprops.graph_specs);
                    if (gs.hasOwnProperty(state.graphId)) {
                        graphData = gs[state.graphId];
                        return true;
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
        throw new Err('info/domain-no-graph', 'domain.no-graph');

    }).then(function () {
        metrics.endTiming('domain.total', startDefDownload);
        return state;
    });
}

function renderOnCanvas(state) {
    return new BBPromise(function (fulfill, reject){
        var start = Date.now();

        // BUG: see comment above at vega.data.load.sanitizeUrl = ...
        // In case of non-absolute URLs, use requesting domain as "local"
        vega.config.baseURL = defaultProtocol + '://' + state.domain;

        vega.headless.render({spec: state.graphData, renderer: 'canvas'}, function (err, result) {
            if (err) {
                state.log.vegaErr = err;
                reject(new Err('error/vega', 'vega.error'));
            } else {
                var stream = result.canvas.pngStream();
                state.response.status(200).type('png');
                stream.on('data', function (chunk) {
                    state.response.write(chunk);
                });
                stream.on('end', function () {
                    state.response.end();
                    metrics.endTiming('vega.time', start);
                    fulfill(state);
                });
            }
        });
    });
}

/**
 * Main entry point for graphoid
 */
router.get('/:title/:revid/:id.png', function(req, res) {

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
            metrics.endTiming('total.time', start);

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

            res.status(400).json(msg);
            metrics.increment(mx);
            req.logger.log(msg, l);
        });
});


function init(app) {

    // The very first operation should set up our logger
    log = app.logger.log.bind(app.logger);
    metrics = app.metrics;

    log('info/init', 'starting v1' );
    metrics.increment('v1.init');

    var conf = app.conf;
    var domains = conf.domains || domains;
    timeout = conf.timeout || timeout;
    defaultProtocol = conf.defaultProtocol || defaultProtocol;

    var validDomains = domains;
    if (conf.domainMap && Object.getOwnPropertyNames(conf.domainMap).length > 0) {
        domainMap = conf.domainMap;
        validDomains = validDomains.concat(Object.getOwnPropertyNames(domainMap));
    }

    if (validDomains.length === 0) {
        log('fatal/config', 'Config must have non-empty "domains" (list) and/or "domainMap" (dict)');
        process.exit(1);
    }

    serverRe = new RegExp('^([-a-z0-9]+\\.)?(m\\.|zero\\.)?(' + validDomains.join('|') + ')$');
    initVega(domains);
}


module.exports = function(app) {

    init(app);

    return {
        path: '/',
        api_version: 1,
        router: router
    };
};
