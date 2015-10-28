#!/usr/bin/env node

'use strict';

// Output dir
var outPath = '/home/yurik/wmf/graphoid/dumps/out/';

// A mapping file with "enwiki_p	en.wikipedia.org"
var wikiMapFile = '/home/yurik/wmf/graphoid/dumps/wikimap.tsv';

// dump file with all graphs
var dumpFile = '/home/yurik/wmf/graphoid/dumps/props_dump.tsv';


var fs = require('fs');
var BBPromise = require('bluebird');
var _ = require('underscore');
var pathlib = require('path');
var mkdir = BBPromise.promisify(require('mkdirp'));
var vega = require('../lib/vega');
BBPromise.promisifyAll(fs);

var dump, wikimap, ind=0;

var namespaces = {
    '0': '',
    '1': 'Talk:',
    '2': 'User:',
    '3': 'User talk:',
    '4': 'Project:',
    '5': 'Project talk:',
    '6': 'File:',
    '7': 'File talk:',
    '8': 'MediaWiki:',
    '9': 'MediaWiki talk:',
    '10': 'Template:',
    '11': 'Template talk:',
    '12': 'Help:',
    '13': 'Help talk:',
    '14': 'Category:',
    '15': 'Category talk:'
};

var canvasToBuffer;
function renderImage(domain, graphData, isSvg) {
    return vega.render({
        domain: domain,
        renderOpts: {spec: graphData, renderer: isSvg ? 'svg' : 'canvas'}
    }).then(isSvg ? function (result) {
            return result.svg;
        } : function (result) {
            if (!canvasToBuffer) {
                canvasToBuffer = BBPromise.promisify(result.canvas.toBuffer);
            }
            return canvasToBuffer.call(result.canvas);
        }
    );
}


vega.initVega(function (a, b) {
        //console.log('\t', a, b);
    }, 'https',
    ['mediawiki.org',
        'wikibooks.org',
        'wikidata.org',
        'wikimedia.org',
        'wikimediafoundation.org',
        'wikinews.org',
        'wikipedia.org',
        'wikiquote.org',
        'wikisource.org',
        'wikiversity.org',
        'wikivoyage.org',
        'wiktionary.org'
    ], {});

var errPath = pathlib.resolve(outPath, 'errors'),
    pngErrPath = pathlib.resolve(errPath, 'png'),
    svgErrPath = pathlib.resolve(errPath, 'svg'),
    jsonPath = pathlib.resolve(outPath, 'json'),
    pngPath = pathlib.resolve(outPath, 'png'),
    svgPath = pathlib.resolve(outPath, 'svg');


return BBPromise.resolve(true).then(function () {
    return BBPromise.all([mkdir(jsonPath), mkdir(pngPath), mkdir(svgPath), mkdir(errPath), mkdir(pngErrPath), mkdir(svgErrPath)]);
}).then(function () {
    return fs.readFileAsync(wikiMapFile, 'utf8');
}).then(function (v) {
    wikimap = {};
    _.each(v.split('\n'), function (v) {
        var parts = v.split('\t');
        wikimap[parts[0]] = parts[1];
    });
    return fs.readFileAsync(dumpFile, 'utf8')
}).then(function (v) {
    return BBPromise.map(v.split('\n'), function (v) {
        if (v === '') {
            return;
        }
        //if (ind % 1000 === 0) {
        //    console.log(ind);
        //}
        ind++;
        var parts = v.split('\t');
        var domain = wikimap[parts[0]];
        var spec = parts[4].replace(/\\\\/g, '\\');
        var title = (parts[2] in namespaces ? namespaces[parts[2]] : (parts[2] + ':')) + parts[3];
        try {
            var graphSpecMap = JSON.parse(spec);
        } catch (err) {
            console.log(domain + '/wiki/' + title + ' -- ' + ind + ' ' + err);
            return fs.writeFileAsync(pathlib.resolve(errPath, domain + '_' + encodeURIComponent(title) + '__parse') + '.txt', spec, 'utf8')
                .catch(function (err) {
                    console.error(err);
                });
        }
        return BBPromise.resolve(true).then(function () {
            return BBPromise.map(_.keys(graphSpecMap), function (hash) {
                var graphSpec = graphSpecMap[hash];
                var graphSpecStr = JSON.stringify(graphSpec);
                return BBPromise.all([
                    fs.writeFileAsync(pathlib.resolve(jsonPath, domain + '_' + hash) + '.json', graphSpecStr, 'utf8'),
                    renderImage(domain, graphSpec, true).then(function (data) {
                        return fs.writeFileAsync(pathlib.resolve(svgPath, domain + '_' + hash) + '.svg', data, 'utf8');
                    }).catch(function (err) {
                        console.log('SVG err: ' + domain + '/wiki/' + title + ' -- ' + ind + ' ' + err);
                        return fs.writeFileAsync(pathlib.resolve(svgErrPath, domain + '_' + hash) + '.json', graphSpecStr, 'utf8');
                    }),
                    renderImage(domain, graphSpec, false).then(function (data) {
                        return fs.writeFileAsync(pathlib.resolve(pngPath, domain + '_' + hash) + '.png', data);
                    }).catch(function (err) {
                        console.log('PNG err: ' + domain + '/wiki/' + title + ' -- ' + ind + ' ' + err);
                        return fs.writeFileAsync(pathlib.resolve(pngErrPath, domain + '_' + hash) + '.json', graphSpecStr, 'utf8');
                    })
                ])
            }).catch(function (err) {
                console.log(domain + '/wiki/' + title + ' -- ' + ind + ' ' + err);
                return fs.writeFileAsync(pathlib.resolve(errPath, domain + '_' + encodeURIComponent(title)) + '.txt', spec, 'utf8');
            });
        });
    }, {concurrency: 30});
});
