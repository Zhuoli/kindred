// Pre-built example friends. Only the *inputs* live in the repo; the plans are
// computed from Qloo once and kept in the private server-side cache, so judges
// get instant results that cost no quota (and no Qloo data is ever committed).

export const EXAMPLES = [
  {
    id: 'indie', title: 'The indie romantic', blurb: 'Sad-girl indie, coming-of-age films, a good bakery.',
    input: { friend: 'Maya', occasion: 'birthday', loves: ['Phoebe Bridgers', 'Lady Bird', 'Tartine Bakery'], interests: ['natural wine'], city: 'San Francisco', vibe: 'dinner', budget: 3, surprise: false },
  },
  {
    id: 'cinephile', title: 'The cinephile', blurb: 'Symmetry, longing, and a chef who yells "corner".',
    input: { friend: 'Sam', occasion: 'anniversary', loves: ['Wes Anderson', 'In the Mood for Love', 'The Bear'], interests: ['jazz'], city: 'New York', vibe: 'night', budget: 3, surprise: true },
  },
  {
    id: 'cozy', title: 'The cozy gamer', blurb: 'Farming sims, Ghibli, and soggy bottoms.',
    input: { friend: 'Jo', occasion: 'housewarming', loves: ['Stardew Valley', 'Studio Ghibli', 'The Great British Bake Off'], interests: ['vinyl'], city: 'Seattle', vibe: 'daytime', budget: 2, surprise: false },
  },
  {
    id: 'outdoors', title: 'The trail runner', blurb: 'Big skies, podcasts on the climb, natural wine after.',
    input: { friend: 'Riley', occasion: 'thank you', loves: ['Patagonia', 'Into the Wild', 'Fleet Foxes'], interests: ['hiking'], city: 'Portland', vibe: 'daytime', budget: 2, surprise: false },
  },
  {
    id: 'literary', title: 'The bookish host', blurb: 'Sally Rooney, period drama, a good wine list.',
    input: { friend: 'Priya', occasion: 'birthday', loves: ['Sally Rooney', 'Normal People', 'Little Women'], interests: ['wine bar'], city: 'Chicago', vibe: 'dinner', budget: 3, surprise: false },
  },
  // "Us" mode: plan for both of you.
  {
    id: 'us-date', title: 'Date night, two tastes', blurb: 'Her sad-girl indie meets his Radiohead and The Bear.',
    input: { mode: 'us', friend: 'Maya', you: 'Sam', occasion: 'date night', loves: ['Phoebe Bridgers', 'Lady Bird', 'Tartine Bakery'], interests: ['natural wine'], yourLoves: ['The Bear', 'Wes Anderson', 'Radiohead'], yourInterests: ['jazz'], city: 'San Francisco', vibe: 'dinner', budget: 3, surprise: false },
  },
  {
    id: 'us-roommates', title: 'Roommates\' Saturday', blurb: 'Cozy games and Ghibli vs. sci-fi and hip-hop.',
    input: { mode: 'us', friend: 'Jo', you: 'Alex', occasion: 'Saturday', loves: ['Stardew Valley', 'Studio Ghibli', 'The Great British Bake Off'], interests: ['vinyl'], yourLoves: ['Dune', 'Kendrick Lamar', 'Severance'], yourInterests: [], city: 'Seattle', vibe: 'daytime', budget: 2, surprise: false },
  },
];

export const exampleById = (id) => EXAMPLES.find((e) => e.id === id) ?? null;
