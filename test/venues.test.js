import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTING_PRESETS, vetVenues, chainReason, opensEvenings, kindLabel, primaryGenre } from '../lib/venues.js';
import { place, tag } from './helpers.js';

const EVE = { saturday: [{ opens: 'T18:00:00', closes: 'T02:00:00', closed: false }] };
const DAY = { saturday: [{ opens: 'T08:00:00', closes: 'T16:00:00', closed: false }], sunday: [{ closed: true }] };

test('kindLabel and primaryGenre describe venue types', () => {
  assert.equal(kindLabel('restaurant:greek'), 'Greek restaurant');
  assert.equal(kindLabel('restaurant:cocktail_bar'), 'Cocktail bar');
  assert.equal(kindLabel('museum'), 'Museum');
  assert.equal(kindLabel(null), null);
  assert.equal(primaryGenre(place('1', 'x', 'restaurant:sushi')), 'restaurant:sushi');
  const fromGoodFor = { properties: { good_for: [{ id: 'urn:tag:genre:place:restaurant:bar' }] } };
  assert.equal(primaryGenre(fromGoodFor), 'restaurant:bar');
});

test('opensEvenings reads hours, including past-midnight closes', () => {
  assert.equal(opensEvenings(place('1', 'x', 'restaurant', { hours: EVE })), true);
  assert.equal(opensEvenings(place('1', 'x', 'restaurant', { hours: DAY })), false);
  assert.equal(opensEvenings(place('1', 'x', 'restaurant')), null, 'unknown hours are not held against a venue');
});

test('chainReason flags chains by name and tag, not independents', () => {
  assert.equal(chainReason(place('1', 'Starbucks Reserve', 'restaurant:coffee_shop')), 'known chain');
  assert.match(chainReason(place('2', 'Burger Spot', 'restaurant', { tags: [tag('urn:tag:culinary_style:qloo:fast_food', 'Fast food')] })), /Fast food/);
  assert.equal(chainReason(place('3', 'Corner Cafe', 'restaurant:cafe', { props: { loyalty_program: 'Corner Cafe Rewards' } })), null, 'stamp cards do not make a chain');
  assert.match(chainReason(place('4', 'Standard Stop', 'restaurant', { tags: [tag('urn:tag:ambience:qloo:standardized', 'Standardized')] })), /Standardized/);
  assert.equal(chainReason(place('5', 'Tiny Bistro', 'restaurant:french')), null);
});

test('dinner leg rejects bars, cafés, bakeries and daytime-only spots', () => {
  const leg = OUTING_PRESETS.dinner.main;
  const { picks, dropped } = vetVenues([
    place('a', 'Speakeasy', 'restaurant:cocktail_bar', { hours: EVE }),
    place('b', 'Good Bakery', 'restaurant:bakery'),
    place('c', 'Brunch Spot', 'restaurant:brunch'),
    place('d', 'Thai Place', 'restaurant:thai', { hours: EVE }),
    place('e', 'Lunch Counter', 'restaurant:mexican', { hours: DAY }),
    place('f', 'Generic But Barry', 'restaurant', { tags: [tag('urn:tag:genre:place:restaurant:bar', 'Bar', 'urn:tag:genre:place')] }),
    place('g', 'Generic Diner', 'restaurant', { tags: [tag('urn:tag:genre:place:restaurant:american', 'American', 'urn:tag:genre:place')] }),
    place('h', 'Bistro Lunch Hours', 'restaurant:french', { hours: DAY, tags: [tag('urn:tag:dining_options:place:dinner', 'Dinner', 'urn:tag:dining_options:place')] }),
  ], leg);
  assert.deepEqual(picks.map((p) => p.name), ['Thai Place', 'Generic Diner', 'Bistro Lunch Hours'], 'a Dinner dining option overrides lunch-only hours');
  assert.equal(dropped.length, 5);
});

test('drinks leg keeps bars and drops bowling alleys and restaurants', () => {
  const leg = OUTING_PRESETS.dinner.after;
  const { picks } = vetVenues([
    place('a', 'Lanes', 'bowling_alley'),
    place('b', 'Wine Bar', 'restaurant:wine_bar'),
    place('c', 'Saloon', 'restaurant', { tags: [tag('urn:tag:genre:place:restaurant:cocktail_bar', 'Cocktail bar', 'urn:tag:genre:place')] }),
    place('d', 'Tapas Place', 'restaurant:tapas'),
    place('e', 'Espresso Bar', 'restaurant:espresso_bar'),
    place('f', 'Velvet Lounge', 'lounge'),
  ], leg, { n: 4 });
  assert.deepEqual(picks.map((p) => p.name), ['Wine Bar', 'Velvet Lounge', 'Saloon'], 'direct type matches rank first');
});

test('live music leg accepts tagged event venues but ranks real music venues first', () => {
  const leg = OUTING_PRESETS.night.after;
  const lmv = tag('urn:tag:genre:place:live_music_venue', 'Live music venue', 'urn:tag:genre:place');
  const { picks } = vetVenues([
    place('a', 'Event Hall', 'event_venue', { tags: [lmv] }),
    place('b', 'Jazz Cellar', 'jazz_club'),
    place('c', 'Pasta Place', 'restaurant:italian', { tags: [lmv] }),
    place('d', 'Museum', 'museum'),
  ], leg);
  assert.deepEqual(picks.map((p) => p.name), ['Jazz Cellar', 'Event Hall']);
});

test('vetVenues dedupes by name, honours exclusions and demotes many-branch places', () => {
  const leg = OUTING_PRESETS.daytime.main;
  const { picks } = vetVenues([
    place('a', 'Local Roaster', 'restaurant:coffee_shop'),
    place('b', 'Local Roaster', 'restaurant:coffee_shop'),
    place('c', 'Local Roaster', 'restaurant:coffee_shop'),
    place('d', 'Corner Cafe', 'restaurant:cafe'),
    place('e', 'Skip Me', 'restaurant:cafe'),
  ], leg, { exclude: new Set(['skip me']) });
  assert.deepEqual(picks.map((p) => p.name), ['Corner Cafe', 'Local Roaster']);
});
