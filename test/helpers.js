export function ent(id, name, type, extra = {}) {
  return { entity_id: id, name, subtype: type, types: [type], popularity: 0.5, properties: { image: { url: `https://images.example/${id}.jpg` } }, ...extra };
}

/** Synthetic tag helper (no real Qloo data is stored in this repo). */
export const tag = (id, name, type) => ({ id, tag_id: id, name, type: type ?? id.split(':').slice(0, -1).join(':') });

/** Synthetic place with a primary genre, optional hours and tags. */
export function place(id, name, genre, { hours, tags = [], extra = {}, props = {} } = {}) {
  return ent(id, name, 'urn:entity:place', {
    properties: { address: `1 ${name} St San Francisco`, primary_genre: { id: `urn:tag:genre:place:${genre}` }, ...(hours ? { hours } : {}), ...props },
    tags,
    ...extra,
  });
}

/** Synthetic giftable brand. */
export function brand(id, name, { pop = 0.8, genres = ['Fashion'], subtype = 'Fashion', type = 'Product Brand', extra = {} } = {}) {
  return ent(id, name, 'urn:entity:brand', {
    popularity: pop,
    tags: [
      ...genres.map((g) => tag(`urn:tag:genre:brand:${g.toLowerCase()}`, g, 'urn:tag:genre:brand')),
      tag(`urn:tag:brand_subtype:qloo:${subtype.toLowerCase()}`, subtype, 'urn:tag:brand_subtype:qloo'),
      tag(`urn:tag:brand_type:qloo:${type.toLowerCase().replace(/ /g, '_')}`, type, 'urn:tag:brand_type:qloo'),
    ],
    ...extra,
  });
}

/** Fake Qloo client with scripted responses; records every call. */
export function fakeQloo({ search = {}, insights = () => ({ entities: [] }), tags = {}, compare = () => ({ shared: [], a: [], b: [] }) } = {}) {
  const calls = [];
  return {
    calls,
    async search(q, opts) { calls.push({ kind: 'search', q, opts }); return search[q] ?? []; },
    async tags(q, opts) { calls.push({ kind: 'tags', q, opts }); const t = tags[q]; return typeof t === 'function' ? t(opts) : (t ?? []); },
    async insights(params) { calls.push({ kind: 'insights', params }); return insights(params, calls); },
    async compare(a, b, opts) { calls.push({ kind: 'compare', a, b, opts }); return compare(a, b, opts); },
  };
}

export function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.write = (chunk) => { res.body += chunk; return true; };
  res.flushHeaders = () => {};
  res.end = (b) => { res.body += b ?? ''; res.ended = true; };
  res.lines = () => res.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  res.json = () => JSON.parse(res.body);
  return res;
}
