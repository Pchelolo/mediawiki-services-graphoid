'use strict';

var express = require('express'),
    preq = require('preq'),
    Promise = require('bluebird'),
    vega = null; // Visualization grammar - https://github.com/trifacta/vega

try{
    // Simplify debugging when vega is not available
    vega = require('vega');
} catch(err) {
    console.error(err);
}


/**
 * The main router object
 */
var router = express.Router();

/**
 * A list of allowed hosts
 */
var domains = [];

/**
 * A set of 'oldHost' => 'newHost' mappings
 */
var domainMap = {};

/**
 * For protocol-relative URLs  (they begin with //), which protocol should we use
 */
var defaultProtocol = 'http:';

/**
 * Limit request to 10 seconds by default
 */
var timeout = 10000;

/**
 * Regex to validate server parameter
 */
var serverRe = null;

function init(conf) {

    domains = conf.domains || domains;
    domainMap = conf.domainMap || domainMap;
    timeout = conf.timeout || timeout;
    defaultProtocol = conf.defaultProtocol || defaultProtocol;
    if (!defaultProtocol.endsWith(':')) {
        // colon in YAML has special meaning, allow it to be skipped
        defaultProtocol = defaultProtocol + ':';
    }

    var validDomains = domains.concat(Object.getOwnPropertyNames(domainMap));

    if (validDomains.length == 0) {
        console.error('Config must have non-empty "domains" (list) and/or "domainMap" (dict)');
        process.exit(1);
    }

    serverRe = new RegExp('^([-a-z0-9]+\\.)?(m\\.|zero\\.)?(' + validDomains.join('|') + ')$');

    if (vega) {
        vega.config.domainWhiteList = domains;
        vega.config.defaultProtocol = defaultProtocol;
        vega.config.safeMode = true;
        if (Object.getOwnPropertyNames(domainMap) > 0) {
            var originalSanitize = vega.data.load.sanitizeUrl;
            vega.data.load.sanitizeUrl = function(url) {
                url = originalSanitize(url);
                if (url) {
                    url = url.replace(/^(https?:\/\/)([-a-z0-9.]+)/, function(match, prot, host){
                        var repl = domainMap[host];
                        return repl ? prot + repl : match;
                    });
                }
                return url;
            };
        }
    }
}

/*
 * Utility functions
 */

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
    return new Promise(function (fulfill) {
        setTimeout(fulfill, time);
    });
}

function failOnTimeout(promise, time) {
    return time <= 0 ? promise :
        Promise.race([promise, delay(time).then(function () {
            throw 'Operation timed out';
        })]);
}

/**
 * Parse and validate request parameters
 */
function validateRequest(state) {

    var p = state.request.params,
        server = p.server,
        title = p.title,
        revid = p.revid,
        id = p.id;

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
            throw 'bad revid param';
        }
        revid = parseInt(revid);
    }

    if (revid) {
        state.apiRequest.revids = revid;
    } else if (title) {
        if (title.indexOf('|') > -1) {
            throw 'bad title param';
        }
        state.apiRequest.titles = title;
    } else {
        throw 'no revid or title given';
    }

    if (!/^[0-9a-f]+$/.test(id)) {
        throw 'bad id param';
    }
    state.graphId = id;

    // Remove optional part #2 from host (makes m. links appear as desktop to optimize cache)
    // 1  2 3
    // en.m.wikipedia.org
    var srvParts = serverRe.exec(server);
    if (!srvParts) {
        throw 'bad server param';
    }
    server = (srvParts[1] || '') + srvParts[3];

    state.server = domainMap[server] || server;
    state.apiUrl = defaultProtocol + '//' + server + '/w/api.php';

    return state;
}

/**
 * Retrieve graph specifications from the server
 * @param state is the object with the current state of the request processing
 */
function getSpec(state) {

    var callApiInt;

    var processResult = function (apiRes) {
        if (apiRes.status !== 200) {
            throw 'API result error code ' + apiRes.status;
        }
        var res = apiRes.body;
        if (res.hasOwnProperty('error')) {
            throw 'API result error: ' + JSON.stringify(res.error);
        }

        if (res.hasOwnProperty('warnings')) {
            console.error('API warning: ' + JSON.stringify(res.warnings) +
            ' from ' + state.server + JSON.stringify(state.apiRequest));
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
                return state;
            }
        }
        if (res.hasOwnProperty('continue')) {
            callApiInt(state.apiUrl, merge(state.apiRequest, res.continue));
        }
        throw 'Unable to find graph_specs with the given id';
    };

    callApiInt = function(url, req) {
        var reqOpts = {
            uri: url,
            query: req,
            headers: {
                'User-Agent': 'graph.ext backend (yurik at wikimedia)'
            }
        };
        return preq(reqOpts)
            .then(processResult)
            .catch(function (reason) {
                delete reqOpts.headers;
                console.error('API call failed: ' + state.server + JSON.stringify(state.apiRequest));
                throw reason; // re-throw
            });
    };

    return callApiInt(state.apiUrl, state.apiRequest);
}

function renderOnCanvas(state) {
    return new Promise(function (fulfill, reject){
        if (!vega) {
            throw 'Unable to load Vega npm module';
        }

        // In case of non-absolute URLs, use requesting server as "local"
        vega.config.baseURL = defaultProtocol + '//' + state.server;

        vega.headless.render({spec: state.graphData, renderer: 'canvas'}, function (err, result) {
            if (err) {
                reject(err);
            } else {
                var stream = result.canvas.pngStream();
                state.response.status(200).type('png');
                stream.on('data', function (chunk) {
                    state.response.write(chunk);
                });
                stream.on('end', function () {
                    state.response.end();
                    fulfill(state);
                });
            }
        });
    });
}

/**
 * Main entry point for graphoid
 */
router.get('/:server/:title/:revid/:id.png', function(req, res) {

    var render = Promise
        .resolve({request: req, response: res})
        .then(validateRequest)
        .then(getSpec)
        .then(renderOnCanvas);

    failOnTimeout(render, timeout)
        .catch(function (reason) {
            console.error('Failed ' + JSON.stringify(req.params) + ' ' + reason);
            if (reason.hasOwnProperty('stack')) {
                console.error(reason.stack);
            }
            res.status(400).json(reason);
        });
});


module.exports = function(app) {

    init(app.conf);

    return {
        path: '/v1',
        router: router
    };
};
