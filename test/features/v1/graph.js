'use strict';


// mocha defines to avoid JSHint breakage
/* global describe, it, before, beforeEach, after, afterEach */


var preq   = require('preq');
var assert = require('../../utils/assert.js');
var server = require('../../utils/server.js');


describe('graphoid', function() {

    this.timeout(20000);

    before(function () { return server.start(); });

    // common URI prefix for v1
    var uri = function(domain, title, revId, graphId) {
        return server.config.uri +
            ( domain !== null ? domain : 'mediawiki.org' ) + '/v1/' +
            ( title !== null ? title : 'Extension:Graph%2FDemo' ) + '/' +
            ( revId !== null ? revId : '1508976' ) + '/' +
            ( graphId !== null ? graphId : '597fd63eb884b45edcd7f71a2788bf01ce52ce9b' ) + '.png';
    };

    it('should get a PNG image from the Extension:Graph/Demo page without revision ID', function() {
        return preq.get({
            uri: uri(null, null, 0, null)
        }).then(function(res) {
            assert.status(res, 200);
            assert.contentType(res, 'image/png');
            assert.notDeepEqual(res.body, undefined, 'No body returned!');
        });
    });

    it('should get a PNG image from the Extension:Graph/Demo page with the given revision ID', function() {
        return preq.get({
            uri: uri(null, null, null, null)
        }).then(function(res) {
            assert.status(res, 200);
            assert.contentType(res, 'image/png');
            assert.notDeepEqual(res.body, undefined, 'No body returned!');
        });
    });

    it('should fail to get a non-existent graph id', function() {
        return preq.get({
            uri: uri(null, null, null, '1234567890123456789012345678901234567890')
        }).then(function(res) {
            throw new Error('Expected an error to be thrown, got status: ' + res.status);
        }, function(err) {
            assert.deepEqual(err.status, 400);
            assert.deepEqual(err.body, 'info/domain-no-graph');
        });
    });

    it('should fail with invalid graph id', function() {
        return preq.get({
            uri: uri(null, null, null, 'xxx4567890123456789012345678901234567890')
        }).then(function(res) {
            throw new Error('Expected an error to be thrown, got status: ' + res.status);
        }, function(err) {
            assert.deepEqual(err.status, 400);
            assert.deepEqual(err.body, 'info/param-id');
        });
    });

    it('should fail with invalid revision id', function() {
        return preq.get({
            uri: uri(null, null, 'abc', null)
        }).then(function(res) {
            throw new Error('Expected an error to be thrown, got status: ' + res.status);
        }, function(err) {
            assert.deepEqual(err.status, 400);
            assert.deepEqual(err.body, 'info/param-revid');
        });
    });

    it('should fail with invalid page name', function() {
        return preq.get({
            uri: uri(null, 'Page|A', '0', null)
        }).then(function(res) {
            throw new Error('Expected an error to be thrown, got status: ' + res.status);
        }, function(err) {
            assert.deepEqual(err.status, 400);
            assert.deepEqual(err.body, 'info/param-title');
        });
    });

    it('should fail to get a non-allowed domain', function() {
        return preq.get({
            uri: uri('example.org', null, null, null)
        }).then(function(res) {
            throw new Error('Expected an error to be thrown, got status: ' + res.status);
        }, function(err) {
            assert.deepEqual(err.status, 400);
            assert.deepEqual(err.body, 'info/param-domain');
        });
    });

});

