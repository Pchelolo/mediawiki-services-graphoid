"use strict";

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
	http = require("http"),
	url = require('url'),
	querystring = require('querystring'),
	vega = null; // Visualization grammar - https://github.com/trifacta/vega


try{
	vega = require("vega");
} catch(err) {
	console.log(err)
}

var config;

// Get the config
try {
	config = JSON.parse(fs.readFileSync('./graphoid.config.json', 'utf8'));
} catch ( e ) {
	console.error("Please set up your graphoid.config.json");
	process.exit(1);
}

var serverRe = new RegExp('^([-a-z0-9]+\.)?(m\.|zero\.)?(' + config.domains.join('|') + ')$');

if (vega) {
	vega.config.domainWhiteList = config.domains;
	vega.config.safeMode = true;
}

function merge() {
	var result = {};
	for (var i = 0; i < arguments.length; i++) {
		var obj = arguments[i];
		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				result[key] = obj[key];
			}
		}
	}
	return result;
}

function getSpec(server, action, qs, id) {

	var url = 'http://' + server + '/w/api.php',
		processResult,
		callApiInt;

	processResult = function (response) {
		var body = JSON.parse(response);
		if ('error' in body) {
			throw 'API result error: ' + data.error;
		}
		if ('warnings' in body) {
			console.log('API warning: ' + JSON.stringify(body.warnings) + ' while getting ' + JSON.stringify({
				url: url,
				opts: qs
			}));
		}
		if ('query' in body && 'pages' in body.query) {
			var obj = body.query.pages;
			for (var k in obj) {
				if (obj.hasOwnProperty(k)) {
					var page = obj[k];
					if ('pageprops' in page && 'graph_specs' in page.pageprops) {
						var gs = JSON.parse(page.pageprops.graph_specs);
						if (id in gs) {
							return gs[id];
						}
					}
				}
			}
		}
		if ('continue' in body) {
			return callApiInt(url, merge(qs, body.continue));
		} else {
			return false;
		}
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
				console.log(JSON.stringify(reqOpts));
				throw reason; // re-throw
			});
	};

	qs.action = action;
	qs.format = 'json';
	return callApiInt(url, qs);
}

function validateRequest(req) {
	var query = url.parse(req.url, true).query;
	if (!('revid' in query)) {
		throw 'no revid';
	}
	if (String(Math.abs(~~Number(query.revid))) !== query.revid) {
		// must be a non-negative integer
		throw 'bad revid param';
	}
	// In case we switch to title, make sure to fail on query.title.indexOf('|') > -1

	if (!('id' in query)) {
		throw 'no id param';
	}
	if (!('server' in query)) {
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

function renderOnCanvas(spec, response) {
	return new Promise(function (fulfill, reject){
		if (!vega) {
			throw "Unable to load Vega npm module";
		}
		vega.headless.render({spec: spec, renderer: "canvas"}, function (err, result) {
			if (err) {
				reject(err);
			} else {
				var stream = result.canvas.pngStream();
				response.writeHead(200, {"Content-Type": "image/png"});
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
    response.end( "User-agent: *\nDisallow: /\n" );
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
			return renderOnCanvas(spec, response);
		});

	// Limit request to 10 seconds, handle all errors
	timeout(render, 10000)
		.catch(function (reason) {
			console.log(reason + (params ? '\n' + JSON.stringify(params) : ''));
			response.writeHead(400);
			response.end(JSON.stringify(reason));
		});
});

console.log( ' - ' + instanceName + ' ready' );
module.exports = app;
