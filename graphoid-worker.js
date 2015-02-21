'use strict';

var cluster = require('cluster');

/**
 * The name of this instance.
 * @property {string}
 */
var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';
console.log( ' - ' + instanceName + ' loading...' );

var express = require('express'),
	request = require('request-promise'),
	Promise = require('promise'), // https://www.npmjs.com/package/promise
	urllib = require('url'),
	vega = null; // Visualization grammar - https://github.com/trifacta/vega


try{
	vega = require('vega');
} catch(err) {
	console.error(err);
}

var config;

// Get the config
try {
	config = require('./graphoid.config.json');
} catch (err) {
	console.error('Error loading graphoid.config.json');
	console.error(err);
	process.exit(1);
}

// A list of allowed hosts
config.domains = config.domains || [];

// A set of 'oldHost' => 'newHost' mappings
config.domainMap = config.domainMap || {};

// For protocol-relative URLs  (they begin with //), which protocol should we use
config.defaultProtocol = config.defaultProtocol || 'http:';

// Limit request to 10 seconds by default
config.timeout = config.timeout || 10000;

var validDomains = config.domains.concat(Object.getOwnPropertyNames(config.domainMap));

if (validDomains.length == 0) {
	console.error('Config must have non-empty "domains" (list) and/or "domainMap" (dict)');
	process.exit(1);
}

var serverRe = new RegExp('^([-a-z0-9]+\\.)?(m\\.|zero\\.)?(' + validDomains.join('|') + ')$');

if (vega) {
	vega.config.domainWhiteList = config.domains;
	vega.config.defaultProtocol = config.defaultProtocol;
	vega.config.safeMode = true;
	if (Object.getOwnPropertyNames(config.domainMap) > 0) {
		var originalSanitize = vega.data.load.sanitizeUrl;
		vega.data.load.sanitizeUrl = function(url) {
			url = originalSanitize(url);
			if (url) {
				url = url.replace(/^(https?:\/\/)([-a-z0-9.]+)/, function(match, prot, host){
					var repl = config.domainMap[host];
					return repl ? prot + repl : match;
				});
			}
			return url;
		};
	}
}

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

function getSpec(server, action, qs, id) {

	var url = 'http://' + server + '/w/api.php',
		processResult,
		callApiInt;

	processResult = function (response) {
		var body = JSON.parse(response);
		if (body.hasOwnProperty('error')) {
			throw 'API result error: ' + JSON.stringify(body.error);
		}
		if (body.hasOwnProperty('warnings')) {
			console.error('API warning: ' + JSON.stringify(body.warnings) + ' while getting ' + JSON.stringify({
				url: url,
				opts: qs
			}));
		}
		if (body.hasOwnProperty('query') && body.query.hasOwnProperty('pages')) {
			var pages = body.query.pages,
				graphData = null;

			Object.getOwnPropertyNames(pages).some(function (k) {
				var page = pages[k];
				if (page.hasOwnProperty('pageprops') && page.pageprops.hasOwnProperty('graph_specs')) {
					var gs = JSON.parse(page.pageprops.graph_specs);
					if (gs.hasOwnProperty(id)) {
						graphData = gs[id];
						return true;
					}
				}
				return false;
			});

			if (graphData) {
				return graphData;
			}
		}
		if (body.hasOwnProperty('continue')) {
			callApiInt(url, merge(qs, body.continue));
		}
		throw 'Unable to find graph_specs with the given id';
	};

	callApiInt = function(url, options) {
		var reqOpts = {
			url: url,
			qs: options,
			headers: {
				'User-Agent': 'graph.ext backend (yurik at wikimedia)'
			}
		};
		return request(reqOpts)
			.then(processResult)
			.catch(function (reason) {
				console.error(JSON.stringify(reqOpts));
				throw reason; // re-throw
			});
	};

	qs.action = action;
	qs.format = 'json';
	return callApiInt(url, qs);
}

function validateRequest(req) {
	var query = urllib.parse(req.url, true).query,
		api = {
			prop: 'pageprops',
			ppprop: 'graph_specs',
			continue: ''
		},
		revid = 0;

	if (query.hasOwnProperty('revid')) {
		if (!/^[0-9]+$/.test(query.revid)) {
			// must be a non-negative integer
			throw 'bad revid param';
		}
		revid = parseInt(query.revid);
	}
	if (revid) {
		api.revids = revid;
	} else if (query.hasOwnProperty('title')) {
		if (query.title.indexOf('|') > -1) {
			throw 'bad title param';
		}
		api.titles = query.title;
	} else {
		throw 'no revid or title given';
	}
	// In case we switch to title, make sure to fail on query.title.indexOf('|') > -1

	if (!query.hasOwnProperty('id')) {
		throw 'no id param';
	}
	if (!query.hasOwnProperty('server')) {
		throw 'no server param';
	}
	// Remove optional part #2 from host (makes m. links appear as desktop to optimize cache)
	// 1  2 3
	// en.m.wikipedia.org
	var srvParts = serverRe.exec(query.server);
	if (!srvParts) {
		throw 'bad server param';
	}
	var server = (srvParts[1] || '') + srvParts[3];

	return {
		server: config.domainMap[server] || server,
		action: 'query',
		query: api,
		id: query.id
	};
}

function renderOnCanvas(spec, server, response) {
	return new Promise(function (fulfill, reject){
		if (!vega) {
			throw 'Unable to load Vega npm module';
		}

		// In case of non-absolute URLs, use requesting server as "local"
		vega.config.baseURL = vega.config.defaultProtocol + '//' + server;

		vega.headless.render({spec: spec, renderer: 'canvas'}, function (err, result) {
			if (err) {
				reject(err);
			} else {
				var stream = result.canvas.pngStream();
				response.writeHead(200, {'Content-Type': 'image/png'});
				stream.on('data', function (chunk) {
					response.write(chunk);
				});
				stream.on('end', function () {
					response.end();
					fulfill();
				});
			}
		});
	});
}

// Adapted from https://www.promisejs.org/patterns/
function delay(time) {
	return new Promise(function (fulfill) {
		setTimeout(fulfill, time);
	});
}
function timeout(promise, time) {
	return Promise.race([promise, delay(time).then(function () {
		throw 'Operation timed out';
	})]);
}

var app = express();

// robots.txt: no indexing.
app.get(/^\/robots.txt$/, function ( req, response ) {
    response.end( 'User-agent: *\nDisallow: /\n' );
});


app.get('/', function(req, response) {

	var params = false;

	var render = new Promise(
		function (fulfill) {
			// validate input params
			params = validateRequest(req);
			fulfill(params);
		}).then(function (s) {
			// get graph definition from the api
			return getSpec(s.server, s.action, s.query, s.id);
		}).then(function (spec) {
			// render graph on canvas
			// bug: timeout might happen right in the middle of streaming
			return renderOnCanvas(spec, params.server, response);
		});

	timeout(render, config.timeout)
		.catch(function (reason) {
			console.error(reason + '\nURL=' + req.url);
			if (reason.hasOwnProperty('stack')) {
				console.error(reason.stack);
			}
			response.writeHead(400);
			response.end(JSON.stringify(reason));
		});
});

console.log( ' - ' + instanceName + ' ready' );
module.exports = app;
