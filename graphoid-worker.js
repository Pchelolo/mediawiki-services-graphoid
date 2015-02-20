'use strict';

var cluster = require('cluster');

/**
 * The name of this instance.
 * @property {string}
 */
var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';
console.log( ' - ' + instanceName + ' loading...' );

var express = require('express'),
	fs = require('fs'),
	child_process = require('child_process'),
	request = require('request-promise'),
	Promise = require('promise'), // https://www.npmjs.com/package/promise
	http = require('http'),
	urllib = require('url'),
	querystring = require('querystring'),
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
	if (!config.hasOwnProperty('domains') || !(config.domains instanceof Array) || config.domains.length == 0) {
		throw 'The config "domains" value must be a non-empty list of domains';
	}
} catch (err) {
	console.error('Error loading graphoid.config.json');
	console.error(err);
	process.exit(1);
}

var serverRe = new RegExp('^([-a-z0-9]+\\.)?(m\\.|zero\\.)?(' + config.domains.join('|') + ')$');

if (vega) {
	vega.config.domainWhiteList = config.domains;
	vega.config.defaultProtocol = config.defaultProtocol || 'http:';
	vega.config.safeMode = true;
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
				graph_spec = null;

			Object.getOwnPropertyNames(pages).some(function (k) {
				var page = pages[k];
				if (page.hasOwnProperty('pageprops') && page.pageprops.hasOwnProperty('graph_specs')) {
					var gs = JSON.parse(page.pageprops.graph_specs);
					if (gs.hasOwnProperty(id)) {
						graph_spec = gs[id];
						return true;
					}
				}
				return false;
			});

			if (graph_spec) {
				return graph_spec;
			}
		}
		return body.hasOwnProperty('continue') ?
			callApiInt(url, merge(qs, body.continue)) : false;
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
	var query = urllib.parse(req.url, true).query;

	if (!query.hasOwnProperty('revid')) {
		throw 'no revid';
	}
	if (!/^[0-9]+$/.test(query.revid)) {
		// must be a non-negative integer
		throw 'bad revid param';
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
	return {
		server: (srvParts[1] || '') + srvParts[3],
		action: 'query',
		query: {
			revids: query.revid,
			prop: 'pageprops',
			ppprop: 'graph_specs',
			continue: ''
		},
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

var app = express(); // .createServer();

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

	// Limit request to 10 seconds by default, handle all errors
	timeout(render, config.timeout || 10000)
		.catch(function (reason) {
			console.error(reason + (params ? '\n' + JSON.stringify(params) : ''));
			response.writeHead(400);
			response.end(JSON.stringify(reason));
		});
});

console.log( ' - ' + instanceName + ' ready' );
module.exports = app;
