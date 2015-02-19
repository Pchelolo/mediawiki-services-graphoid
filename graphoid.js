#!/usr/bin/env node
/**
 * A very basic cluster-based server runner. Restarts failed workers, but does
 * not much else right now.
 */

//var express = require('express');
//var app = express.createServer();
//
//var graphoidWorker = require('./graphoid-worker.js');
//graphoidWorker.listen(port);
//return;


var cluster = require('cluster'),
	// when running on appfog.com the listen port for the app
	// is passed in an environment variable.  Most users can ignore this!
	port = process.env.GRAPHOID_PORT || 11042;

if (cluster.isMaster) {
	// Start a few more workers than there are cpus visible to the OS, so that we
	// get some degree of parallelism even on single-core systems. A single
	// long-running request would otherwise hold up all concurrent short requests.
	var numCPUs = require('os').cpus().length + 3;




	numCPUs = 1;





	// Fork workers.
	for (var i = 0; i < numCPUs; i++) {
		cluster.fork();
	}

	cluster.on('exit', function(worker) {
		if (!worker.suicide) {
			var exitCode = worker.process.exitCode;
			console.log('worker', worker.process.pid,
									'died ('+exitCode+'), restarting.');
			cluster.fork();
		}
	});

	process.on('SIGTERM', function() {
		console.log('master shutting down, killing workers');
		var workers = cluster.workers;
		Object.keys(workers).forEach(function(id) {
				console.log('Killing worker ' + id);
				workers[id].destroy();
		});
		console.log('Done killing workers, bye');
		process.exit(1);
	} );
	console.log('Starting Graphoid on port ' + port +
			'\nPoint your browser to http://localhost:' + port + '/ for a test form\n');
} else {
	var graphoidWorker = require('./graphoid-worker.js');
	process.on('SIGTERM', function() {
		console.log('Worker shutting down');
		process.exit(1);
	});
	graphoidWorker.listen(port);
}
