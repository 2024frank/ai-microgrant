/**
 * Fixed poster set for the Oberlin Public Library's Locable programs. These
 * are the library's own per-event images. CommunityHub requires an image URL
 * that ends in a real extension (it rejects the extension-less Locable CDN
 * URLs), so the app re-serves each of these at /api/media/library/<slug>.jpg
 * for CommunityHub to download. The slug allowlist is what keeps that media
 * route from fetching anything but these known images.
 */
export type LibraryPoster = { title: string; image: string };

export const LIBRARY_POSTERS: Record<string, LibraryPoster> = {
  'storytime': {
    title: 'Storytime at Oberlin Public Library',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNTg1MDZhYjktNmMxZC00MzUxLTljYzQtZGY3ZmI5ZGNkNGM4L1N0b3J5dGltZS5wbmciLCJlZGl0cyI6eyJyZXNpemUiOnsid2lkdGgiOjQwMH0sInBuZyI6eyJxdWFsaXR5Ijo4MCwiYWRhcHRpdmVGaWx0ZXJpbmciOnRydWV9fX0=',
  },
  'kitten-storytime': {
    title: 'Kitten Storytime at OPL',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvYmUyMTQ4ZWEtMzAxZC00ZjRmLTk0MTQtZmM3YTc0ZWRmNGEwL0tpdHRlbiBTdG9yeXRpbWUgMjAyNiAoMSkucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  },
  'reading-buddies': {
    title: 'Reading Buddies with Maya the Therapy Dog',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvOTY2OTI2ODItMTIyMC00NDM2LTgyNTgtMDA2Mzc4Y2Q5M2FkL1JlYWRpbmcgQnVkZGllcyBGbHllciAoSW5zdGFncmFtIFBvc3QgKDQ1KSkgKDMpLnBuZyIsImVkaXRzIjp7InJlc2l6ZSI6eyJ3aWR0aCI6NDAwfSwicG5nIjp7InF1YWxpdHkiOjgwLCJhZGFwdGl2ZUZpbHRlcmluZyI6dHJ1ZX19fQ==',
  },
  'kombucha': {
    title: 'Kombucha In Your Kitchen (OPL Modern Homesteading)',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNjRmYzc0OGQtZTc5Ny00Mjk2LTkwNTEtMGViNDA3NWM5MTgxLzc0NDMzMzAwNl8yODYyMTE3NzEyMDgwNTI1OV8yNDU4MzEzOTk0NjE1MzY3ODI2X24uanBnIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJqcGVnIjp7InF1YWxpdHkiOjgwfX19',
  },
  'lego': {
    title: 'L.E.G.O.',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9lZGl0ZWQvMDJkOTYzOTYtZmRmYy00M2VhLTlmOWEtZWE2YTUxYzBlZWRkL0xFR08ucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  },
  'music-open-mic': {
    title: 'Music Open Mic',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvYTk5ODY3NmUtYWIzOS00ZmQzLWI4ZWQtMWRiOWY1NzE5N2NkLzAucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  },
  'bird-conversation': {
    title: 'Bird Conversation: Where Have All The Birds Gone?',
    image: 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNzI2NGJlMzAtM2ViMS00ZjRkLTg5NTQtYjY1ODM5ZmM3MjdmL0JpcmRzLnBuZyIsImVkaXRzIjp7InJlc2l6ZSI6eyJ3aWR0aCI6NDAwfSwicG5nIjp7InF1YWxpdHkiOjgwLCJhZGFwdGl2ZUZpbHRlcmluZyI6dHJ1ZX19fQ==',
  },
};

export function libraryImagesByTitle(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { title, image } of Object.values(LIBRARY_POSTERS)) out[title] = image;
  return out;
}

/** Map a program title to its poster slug (exact, then normalized match). */
export function libraryPosterSlug(title: string): string | null {
  const normalize = (value: string) => value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = normalize(title);
  for (const [slug, poster] of Object.entries(LIBRARY_POSTERS)) {
    if (normalize(poster.title) === wanted) return slug;
  }
  return null;
}
