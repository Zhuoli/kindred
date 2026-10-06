import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandRejectReason, diversify, MAINSTREAM_CAP } from '../lib/gifts.js';
import { pickTag } from '../lib/interests.js';
import { brand, ent, tag } from './helpers.js';

test('brandRejectReason keeps giftable brands and explains rejections', () => {
  assert.equal(brandRejectReason(brand('1', 'Fjallraven')), null);
  assert.equal(brandRejectReason(brand('2', 'Razor', { subtype: 'CPG' })), 'everyday consumable');
  assert.match(brandRejectReason(brand('3', 'Agency', { type: 'Government Brand' })), /not a gift/);
  assert.equal(brandRejectReason(brand('4', 'Glasses Online', { genres: ['Eyewear', 'Fashion'], type: 'Retail Brand' })), 'prescription eyewear retailer');
  assert.equal(brandRejectReason(brand('4b', 'Goggle Maker', { genres: ['Eyewear', 'Fashion'] })), null, 'sunglasses/goggle makers are fine');
  assert.equal(brandRejectReason(brand('6b', 'Wool Socks', { genres: ['Fashion', 'Lingerie & Sleepwear', 'Athletic'] })), null, 'a secondary category does not disqualify');
  assert.equal(brandRejectReason(brand('5', 'Watchmaker', { genres: ['Eyewear', 'Watch'] })), null);
  assert.equal(brandRejectReason(brand('6', 'Undies', { genres: ['Lingerie & Sleepwear'] })), 'lingerie & sleepwear');
  assert.equal(brandRejectReason(brand('7', 'Everywhere', { pop: 0.995 })), 'mass-market');
  assert.equal(brandRejectReason(brand('8', 'Niche', { pop: 0.95 }), { cap: MAINSTREAM_CAP.surprise }), 'mass-market');
  assert.equal(brandRejectReason(brand('9', 'Ghost', { pop: 0 })), 'too little data');
});

test('diversify spreads picks across different tag clusters', () => {
  const t = (n) => tag(`urn:tag:genre:media:${n}`, n, 'urn:tag:genre:media');
  const items = [
    ent('a', 'A', 'urn:entity:book', { query: { affinity: 0.95 }, tags: [t('memoir'), t('race')] }),
    ent('b', 'B', 'urn:entity:book', { query: { affinity: 0.94 }, tags: [t('memoir'), t('race')] }),
    ent('c', 'C', 'urn:entity:book', { query: { affinity: 0.93 }, tags: [t('memoir'), t('race')] }),
    ent('d', 'D', 'urn:entity:book', { query: { affinity: 0.90 }, tags: [t('sci-fi')] }),
  ];
  assert.deepEqual(diversify(items, 2).map((e) => e.name), ['A', 'D']);
  assert.equal(diversify([], 3).length, 0);
});

test('pickTag prefers exact, relevant tag types and ignores decor', () => {
  const tags = [
    tag('urn:tag:decor:qloo:vinyl_flooring', 'Vinyl Flooring', 'urn:tag:decor:qloo'),
    tag('urn:tag:good_for:qloo:vinyl_music_listening', 'Vinyl Music Listening', 'urn:tag:good_for:qloo'),
    tag('urn:tag:category:place:vinyl_sign_shop', 'Vinyl sign shop', 'urn:tag:category:place'),
  ];
  const prefs = ['genre:place', 'good_for:qloo', 'category:place'];
  assert.equal(pickTag('vinyl', tags, prefs).id, 'urn:tag:good_for:qloo:vinyl_music_listening');
  assert.equal(pickTag('hiking', tags, prefs), null);
  assert.equal(pickTag('', tags, prefs), null);
});
