'use strict';

var BBPromise = require('bluebird');
var urllib = require('url');
var vega = require('vega'); // Visualization grammar - https://github.com/trifacta/vega

// Vega has its own renderAsync() version, but it does not return a promise
var renderAsync = BBPromise.promisify(vega.headless.render, vega.headless);

module.exports = {
    /**
     * For protocol-relative URLs  (they begin with //), which protocol should we use
     */
    defaultProtocol: 'https',

    /**
     * A set of 'oldDomain' => 'newDomain' mappings
     */
    domainMap: false,

    /**
     * Regex to validate domain parameter
     */
    serverRe: null
};

/**
 * Init vega rendering
 * @param log
 * @param domains array of strings - which domains are valid
 */
module.exports.initVega = function (log, defaultProtocol, domains, domainMap) {
    if (module.exports.serverRe) {
        return; // avoid double-initialization
    }

    domains = domains || [];
    module.exports.defaultProtocol = defaultProtocol || module.exports.defaultProtocol;

    var validDomains = domains;
    if (domainMap && Object.getOwnPropertyNames(domainMap).length > 0) {
        module.exports.domainMap = domainMap;
        validDomains = validDomains.concat(Object.getOwnPropertyNames(domainMap));
    }

    if (validDomains.length === 0) {
        log('fatal/config', 'Config must have non-empty "domains" (list) and/or "domainMap" (dict)');
        process.exit(1);
    }

    // TODO: handle other symbols (even though they shouldn't be in the domains
    // TODO: implement per-host default protocol, e.g. wikipedia.org -> https, wmflabs.org -> http
    //       per-demain default protocol will probably not be enabled for production
    module.exports.serverRe = new RegExp('^([^@/:]*\.)?(' +
        validDomains
            .map(function (s) {
                return s.replace('.', '\\.');
            })
            .join('|') + ')$');

    vega.config.domainWhiteList = domains;
    vega.config.defaultProtocol = module.exports.defaultProtocol + ':';
    vega.config.safeMode = true;
    vega.config.isNode = true; // Vega is flaky with its own detection, fails in tests and with IDE debug

    // set up vega loggers to log to our device instead of stderr
    vega.log = function (msg) {
        log('debug/vega', msg);
    };
    vega.error = function (msg) {
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
        if (url && module.exports.domainMap) {
            url = url.replace(/^(https?:\/\/)([^#?\/]+)/, function (match, prot, domain) {
                var repl = module.exports.domainMap[domain];
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
};

module.exports.render = function (opts) {
    // BUG: see comment above at vega.data.load.sanitizeUrl = ...
    // In case of non-absolute URLs, use requesting domain as "local"
    vega.config.baseURL = module.exports.defaultProtocol + '://' + opts.domain;

    return renderAsync(opts.renderOpts);
};
