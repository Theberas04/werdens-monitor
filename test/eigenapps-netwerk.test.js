'use strict';
// Tests voor het zoeken naar Tom's eigen software op het netwerk: het
// vingerafdruk-bestand, de meta-tag, de titel-terugval en de zoekfunctie.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const ean = require('../lib/eigenapps-netwerk');

// Start een klein lokaal HTTP-servertje op een vrije poort. Geeft { poort, stop }.
async function miniServer(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    poort: srv.address().port,
    stop: () => new Promise((r) => srv.close(r)),
  };
}

test('titelVan haalt de titel uit HTML en normaliseert witruimte', () => {
  assert.equal(ean.titelVan('<html><head><title>  Mijn   app </title></head></html>'), 'Mijn app');
  assert.equal(ean.titelVan('<html>zonder titel</html>'), '');
  assert.equal(ean.titelVan(''), '');
});

test('metaVan leest de pijp-vorm en de JSON-vorm', () => {
  const pijp = ean.metaVan('<meta name="werdens-app" content="VoorraadThuis|1.4.2|Theberas04/voorraadthuis">');
  assert.deepEqual(pijp, { naam: 'VoorraadThuis', versie: '1.4.2', repo: 'Theberas04/voorraadthuis', sha: '' });

  const json = ean.metaVan('<meta name="werdens-app" content=\'{"naam":"Bakken","versie":"0.3.0","repo":"Theberas04/bakken"}\'>');
  assert.deepEqual(json, { naam: 'Bakken', versie: '0.3.0', repo: 'Theberas04/bakken', sha: '' });

  assert.equal(ean.metaVan('<meta name="iets-anders" content="x">'), null);
  assert.equal(ean.metaVan('<meta name="werdens-app" content="">'), null);
  assert.equal(ean.metaVan('<meta name="werdens-app" content="{kapot">'), null);
});

test('herkent een app aan het vingerafdruk-bestand', async () => {
  const srv = await miniServer((req, res) => {
    if (req.url === '/.well-known/werdens-app.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ naam: 'Testapp', versie: '2.3.4', repo: 'Theberas04/testapp' }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html><head><title>Iets anders</title></head></html>');
  });
  try {
    const app = await ean.herken('127.0.0.1', srv.poort);
    assert.ok(app, 'app moet herkend zijn');
    assert.equal(app.naam, 'Testapp');
    assert.equal(app.versie, '2.3.4');
    assert.equal(app.repo, 'Theberas04/testapp');
    assert.equal(app.herkend, 'vingerafdruk');
  } finally { await srv.stop(); }
});

test('herkent een app aan het tweede vingerafdruk-pad', async () => {
  const srv = await miniServer((req, res) => {
    if (req.url === '/werdens-app.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ naam: 'Kledingkast', versie: '1.0.0' }));
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  try {
    const app = await ean.herken('127.0.0.1', srv.poort);
    assert.ok(app);
    assert.equal(app.naam, 'Kledingkast');
    assert.equal(app.herkend, 'vingerafdruk');
  } finally { await srv.stop(); }
});

test('herkent een app aan de meta-tag in de pagina', async () => {
  const srv = await miniServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head><meta name="werdens-app" content="Zittesj|2.1.0|Theberas04/zittesj"><title>Zittesj</title></head></html>');
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  try {
    const app = await ean.herken('127.0.0.1', srv.poort);
    assert.ok(app);
    assert.equal(app.naam, 'Zittesj');
    assert.equal(app.versie, '2.1.0');
    assert.equal(app.herkend, 'meta');
  } finally { await srv.stop(); }
});

test('herkent een bekende app aan de paginatitel', async () => {
  const srv = await miniServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><title>AkkoordKast · gitaarsongbook met capo-advies</title></head><body>hoi</body></html>');
  });
  try {
    const app = await ean.herken('127.0.0.1', srv.poort);
    assert.ok(app);
    assert.equal(app.naam, 'AkkoordKast');
    assert.equal(app.repo, 'Theberas04/akkoordkast');
    assert.equal(app.herkend, 'titel');
  } finally { await srv.stop(); }
});

test('een onbekende pagina wordt niet als eigen software gezien', async () => {
  const srv = await miniServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><head><title>Router beheer</title></head><body>login</body></html>');
  });
  try {
    assert.equal(await ean.herken('127.0.0.1', srv.poort), null);
  } finally { await srv.stop(); }
});

test('zoek gebruikt de ontdekker en herkent de gevonden app', async () => {
  const srv = await miniServer((req, res) => {
    if (req.url === '/.well-known/werdens-app.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ naam: 'Gevonden app', versie: '9.9.9', repo: 'Theberas04/gevonden' }));
      return;
    }
    res.end('x');
  });
  try {
    const nepSubnet = { cidr: '10.0.0.0/24', netwerk: '10.0.0.0', prefix: 24, eigen: [], interface: 'test' };
    const uit = await ean.zoek({
      subnetten: [nepSubnet],
      poorten: [srv.poort],
      ontdekker: async () => [{ ip: '127.0.0.1', poorten: [srv.poort], hostnaam: 'testhost' }],
    });
    assert.equal(uit.length, 1);
    assert.equal(uit[0].naam, 'Gevonden app');
    assert.equal(uit[0].host, '127.0.0.1');
    assert.equal(uit[0].poort, srv.poort);
    assert.equal(uit[0].hostnaam, 'testhost');
  } finally { await srv.stop(); }
});

test('zoek slaat poorten over die niet in de lijst staan', async () => {
  const nepSubnet = { cidr: '10.0.0.0/24', netwerk: '10.0.0.0', prefix: 24, eigen: [], interface: 'test' };
  const uit = await ean.zoek({
    subnetten: [nepSubnet],
    poorten: [9999],
    ontdekker: async () => [{ ip: '127.0.0.1', poorten: [1234], hostnaam: '' }],
  });
  assert.equal(uit.length, 0);
});