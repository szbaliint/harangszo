// scripts/lib/photos.mjs: the pure parts of the photo import (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USER_AGENT, chunk, overpassQuery, commonsTitle, osmFile, osmWikidata, wikidataImage, stripHtml, isFreeLicense,
  licenceLabel, formatCredit, photoFromImageInfo, wikimediaUrl, pagesByTitle, byImportance,
} from "../scripts/lib/photos.mjs";

test("batching: at most n per batch, nothing lost, order kept", () => {
  const ids = Array.from({ length: 451 }, (_, i) => i);
  const b = chunk(ids, 200);
  assert.deepEqual(b.map(x => x.length), [200, 200, 51]);
  assert.deepEqual(b.flat(), ids);
  assert.deepEqual(chunk([], 50), []);
  assert.deepEqual(chunk([1, 2], 50), [[1, 2]]);
  assert.throws(() => chunk([1], 0));
});

test("Overpass query groups ids by object type and asks only for tags", () => {
  const q = overpassQuery([{ osm_type: "way", osm_id: 5 }, { osm_type: "node", osm_id: 1 }, { osm_type: "way", osm_id: "7" }, { osm_type: "bogus", osm_id: 9 }, { osm_type: "node", osm_id: "x" }]);
  assert.equal(q, "[out:json][timeout:120];(node(id:1);way(id:5,7););out tags;");
});

test("Commons file names from OSM and Wikidata values", () => {
  assert.equal(commonsTitle("File:Szeged_Dóm.jpg"), "File:Szeged Dóm.jpg");
  assert.equal(commonsTitle("https://commons.wikimedia.org/wiki/File:Esztergom%20Basilica.JPG"), "File:Esztergom Basilica.JPG");
  assert.equal(commonsTitle("https://upload.wikimedia.org/wikipedia/commons/a/ab/Eger_bazilika.jpg"), "File:Eger bazilika.jpg");
  assert.equal(commonsTitle("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Eger_bazilika.jpg/800px-Eger_bazilika.jpg"), "File:Eger bazilika.jpg");
  assert.equal(commonsTitle("https://hu.wikipedia.org/wiki/Fájl:Pannonhalma.jpg"), "File:Pannonhalma.jpg");
  assert.equal(commonsTitle("templom kép.jpeg"), "File:Templom kép.jpeg");
  assert.equal(commonsTitle("https://example.com/church.jpg"), null);
  assert.equal(commonsTitle("Category:Churches in Szeged"), null);
  assert.equal(commonsTitle(""), null);
  assert.equal(commonsTitle("File:100% bad.jpg"), "File:100% bad.jpg");   // undecodable % is kept as is
});

test("OSM tags: wikimedia_commons file first, then image; categories skipped", () => {
  assert.equal(osmFile({ wikimedia_commons: "Category:X;File:A.jpg", image: "File:B.jpg" }), "File:A.jpg");
  assert.equal(osmFile({ wikimedia_commons: "Category:X", image: "https://commons.wikimedia.org/wiki/File:B.jpg" }), "File:B.jpg");
  assert.equal(osmFile({ image: "https://example.com/x.jpg" }), null);
  assert.equal(osmFile({}), null);
  assert.equal(osmWikidata({ wikidata: "Q1234" }), "Q1234");
  assert.equal(osmWikidata({ wikidata: "q55;Q66" }), "Q55");
  assert.equal(osmWikidata({ wikidata: "Q0" }), null);
  assert.equal(osmWikidata({ wikidata: "nonsense" }), null);
});

test("Wikidata P18: preferred rank first, never deprecated", () => {
  const snak = v => ({ snaktype: "value", datavalue: { value: v } });
  assert.equal(wikidataImage({ claims: { P18: [{ rank: "normal", mainsnak: snak("A.jpg") }, { rank: "preferred", mainsnak: snak("B.jpg") }] } }), "File:B.jpg");
  assert.equal(wikidataImage({ claims: { P18: [{ rank: "deprecated", mainsnak: snak("A.jpg") }, { rank: "normal", mainsnak: snak("C d.jpg") }] } }), "File:C d.jpg");
  assert.equal(wikidataImage({ claims: { P18: [{ rank: "normal", mainsnak: { snaktype: "novalue" } }] } }), null);
  assert.equal(wikidataImage({ claims: {} }), null);
  assert.equal(wikidataImage(undefined), null);
});

test("licence filter: CC0, public domain, CC BY, CC BY-SA only", () => {
  for (const [short, lic] of [["CC BY-SA 4.0", "cc-by-sa-4.0"], ["CC BY 2.0", "cc-by-2.0"], ["CC0", "cc0"], ["Public domain", "pd"],
    ["CC BY-SA 3.0 de", null], [null, "cc-by-sa-3.0"], ["CC BY-SA 2.5,2.0,1.0", null], ["PD-old", null], ["CC BY 4.0", undefined]]) {
    assert.equal(isFreeLicense(short, lic), true, `${short} / ${lic}`);
  }
  for (const [short, lic] of [["CC BY-NC 2.0", "cc-by-nc-2.0"], ["CC BY-NC-SA 3.0", null], ["CC BY-ND 4.0", null], ["GFDL", "gfdl"],
    ["Fair use", null], ["Attribution", null], ["", ""], [null, null], ["All rights reserved", null]]) {
    assert.equal(isFreeLicense(short, lic), false, `${short} / ${lic}`);
  }
});

test("HTML is stripped from the author", () => {
  assert.equal(stripHtml('<a href="//commons.wikimedia.org/wiki/User:Foo" title="User:Foo">Foo&nbsp;Bar</a> &amp; <span>Baz</span>'), "Foo Bar & Baz");
  assert.equal(stripHtml("<div class=\"fn\">Kovács&#32;János<br/>(&#x48;U)</div>"), "Kovács János (HU)");
  assert.equal(stripHtml('x<script>alert(1)</script>y'), "x y");
  assert.equal(stripHtml(undefined), "");
});

test("credit line", () => {
  assert.equal(formatCredit('<a href="#">Kovács János</a>', "CC BY-SA 4.0"), "Fotó: Kovács János · CC BY-SA 4.0 · Wikimedia Commons");
  assert.equal(formatCredit("", "CC0"), "Fotó: CC0 · Wikimedia Commons");
  const long = formatCredit("Szó ".repeat(60), "CC BY 4.0");
  assert.ok(long.length < 170 && long.includes("… · CC BY 4.0 · Wikimedia Commons"), long);
  assert.equal(licenceLabel("", "cc-by-sa-4.0"), "CC BY-SA 4.0");
  assert.equal(licenceLabel(undefined, "pd"), "Public domain");
  assert.equal(licenceLabel("CC BY 3.0", "cc-by-3.0"), "CC BY 3.0");
});

test("imageinfo page → photo or reason", () => {
  const page = (md, extra = {}) => ({ title: "File:A.jpg", imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg",
    thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A.jpg/1000px-A.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:A.jpg",
    extmetadata: md, ...extra }] });
  assert.deepEqual(photoFromImageInfo(page({ Artist: { value: "<b>Foo</b>" }, LicenseShortName: { value: "CC BY-SA 4.0" }, License: { value: "cc-by-sa-4.0" } })), {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A.jpg/1000px-A.jpg",
    credit: "Fotó: Foo · CC BY-SA 4.0 · Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:A.jpg" });
  assert.deepEqual(photoFromImageInfo(page({ LicenseShortName: { value: "CC BY-NC 2.0" } })), { rejected: "licence" });
  assert.deepEqual(photoFromImageInfo(page({ LicenseShortName: { value: "CC0" } }, { mime: "application/pdf" })), { rejected: "not a photo" });
  assert.deepEqual(photoFromImageInfo({ title: "File:Gone.jpg", missing: true }), { rejected: "missing" });
  assert.deepEqual(photoFromImageInfo(undefined), { rejected: "missing" });
  // a small original: Commons returns no thumbnail, the original is used
  assert.equal(photoFromImageInfo(page({ LicenseShortName: { value: "CC0" } }, { thumburl: undefined })).url, "https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg");
});

test("thumbnail URLs: Wikimedia hosts only, tracking parameters dropped", () => {
  assert.equal(wikimediaUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/A%2C_B.jpg/1280px-A%2C_B.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail"),
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/A%2C_B.jpg/1280px-A%2C_B.jpg");
  assert.equal(wikimediaUrl("https://upload.wikimedia.org/wikipedia/commons/1/12/A.jpg?utm_source=x&keep=1"), "https://upload.wikimedia.org/wikipedia/commons/1/12/A.jpg?keep=1");
  assert.equal(wikimediaUrl("http://upload.wikimedia.org/wikipedia/commons/1/12/A.jpg"), null);
  assert.equal(wikimediaUrl("https://upload.wikimedia.org.example.com/A.jpg"), null);
  assert.equal(wikimediaUrl("ftp://upload.wikimedia.org/A.jpg"), null);
  assert.equal(wikimediaUrl(undefined), null);
});

test("pages are matched back through normalisation and redirects", () => {
  const q = { normalized: [{ from: "File:a b.jpg", to: "File:A b.jpg" }], redirects: [{ from: "File:Old.jpg", to: "File:New.jpg" }],
    pages: [{ title: "File:A b.jpg", n: 1 }, { title: "File:New.jpg", n: 2 }, { title: "File:Same.jpg", n: 3 }] };
  const m = pagesByTitle(["File:a b.jpg", "File:Old.jpg", "File:Same.jpg", "File:Absent.jpg"], q);
  assert.deepEqual([...m].map(([k, v]) => [k, v.n]), [["File:a b.jpg", 1], ["File:Old.jpg", 2], ["File:Same.jpg", 3]]);
});

test("most important churches first", () => {
  const list = [{ id: 1, importance_auto: 30 }, { id: 2, importance_auto: 90 }, { id: 3, importance_auto: 30, importance_manual: 95 }, { id: 4, importance_auto: 30 }];
  assert.deepEqual(list.sort(byImportance).map(c => c.id), [3, 2, 1, 4]);
});

test("User-Agent names the project, no e-mail address", () => {
  assert.equal(USER_AGENT, "Harangszo-photo-import/1.0 (+https://github.com/szbaliint/harangszo)");
  assert.doesNotMatch(USER_AGENT, /@/);
});
