import seedState from '../../gist-seed/vlad-list.json';

// The Gist is found (or created on first use) automatically: the Worker looks for a gist that
// contains STATE_FILE. Set a GIST_ID variable/secret on the Worker to pin a specific gist instead.
const STATE_FILE = 'vlad-list.json';
const IMG_PREFIX = 'vlad-images-';        // shard files: vlad-images-0.json, vlad-images-1.json, …
const IMG_SHARD_MAX = 800_000;            // ~800 KB per shard — safely under GitHub's 1 MB limit
const GIST_DESCRIPTION = "Vlad's wish list data";

let GIST_URL = null;                      // resolved once per Worker instance

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function authHeaders(pat) {
  return {
    'Authorization': 'Bearer ' + pat,
    'Accept':        'application/vnd.github+json',
    'User-Agent':    'gist-proxy/1.0',
  };
}

// Find the gist holding STATE_FILE, or create it (seeded with the initial gifts) if none exists.
async function resolveGistUrl(env, pat) {
  if (GIST_URL) return GIST_URL;
  if (env.GIST_ID) return (GIST_URL = 'https://api.github.com/gists/' + env.GIST_ID);

  const list = await fetch('https://api.github.com/gists?per_page=100', { headers: authHeaders(pat) });
  if (!list.ok) throw new Error('GitHub error ' + list.status + ' listing gists: ' + await list.text());
  const found = (await list.json()).find(g => g.files && g.files[STATE_FILE]);
  if (found) return (GIST_URL = 'https://api.github.com/gists/' + found.id);

  const create = await fetch('https://api.github.com/gists', {
    method:  'POST',
    headers: { ...authHeaders(pat), 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [STATE_FILE]:          { content: JSON.stringify(seedState, null, 2) },
        [IMG_PREFIX + '0.json']: { content: '{}' },
      },
    }),
  });
  if (!create.ok) throw new Error('GitHub error ' + create.status + ' creating gist: ' + await create.text());
  const made = await create.json();
  return (GIST_URL = 'https://api.github.com/gists/' + made.id);
}

// Fetch the full gist and return { gist } or { error: Response }
async function fetchGist(pat) {
  const res = await fetch(GIST_URL, { headers: authHeaders(pat) });
  if (!res.ok) {
    const text = await res.text();
    return { error: new Response('GitHub error ' + res.status + ': ' + text, { status: 502, headers: CORS }) };
  }
  return { gist: await res.json() };
}

// Read a gist file's content, fetching raw_url if the content was truncated
async function fileContent(file, pat) {
  if (!file.truncated) return file.content || '';
  const res = await fetch(file.raw_url, { headers: authHeaders(pat) });
  if (!res.ok) return '';
  return await res.text();
}

// Patch one file in the gist (GitHub creates the file if it doesn't exist yet)
async function patchFile(pat, filename, content) {
  const res = await fetch(GIST_URL, {
    method:  'PATCH',
    headers: { ...authHeaders(pat), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ files: { [filename]: { content } } }),
  });
  if (!res.ok) {
    const text = await res.text();
    return new Response('GitHub error ' + res.status + ': ' + text, { status: 502, headers: CORS });
  }
  return null; // success
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);

  // ── /og?url=... — fetch OG image from any URL ──────────────────────
  if (url.pathname === '/og') {
    const target = url.searchParams.get('url');
    if (!target) return new Response('missing url param', { status: 400, headers: CORS });
    try {
      const res = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GiftListBot/1.0)' },
        redirect: 'follow',
      });
      if (!res.ok) return new Response('', { status: 204, headers: CORS });
      const html = await res.text();
      const match =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
        html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      if (!match) return new Response('', { status: 204, headers: CORS });
      let imgUrl = match[1];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      else if (imgUrl.startsWith('/')) imgUrl = new URL(target).origin + imgUrl;
      return new Response(JSON.stringify({ image: imgUrl }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response('', { status: 204, headers: CORS });
    }
  }

  const pat = env.GIST_PAT;
  if (!pat) return new Response('GIST_PAT secret missing', { status: 500, headers: CORS });

  await resolveGistUrl(env, pat);

  // ── /image  POST { id, dataUrl } — save a single image to the right shard ──
  if (url.pathname === '/image' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return new Response('invalid JSON body', { status: 400, headers: CORS });
    }
    const { id, dataUrl } = body;
    if (!id || !dataUrl) return new Response('missing id or dataUrl', { status: 400, headers: CORS });

    const { gist, error } = await fetchGist(pat);
    if (error) return error;

    // Collect all existing image shards
    const shardFiles = Object.keys(gist.files)
      .filter(f => f.startsWith(IMG_PREFIX))
      .sort(); // vlad-images-0.json, vlad-images-1.json, …

    // Find which shard already contains this id (for updates)
    let targetShard = null;
    let targetData  = {};
    for (const fname of shardFiles) {
      const file = gist.files[fname];
      let parsed = {};
      try { parsed = JSON.parse(file.content || '{}'); } catch {}
      if (parsed[id] !== undefined) {
        targetShard = fname;
        targetData  = parsed;
        break;
      }
    }

    // If not updating an existing entry, find the first shard with room
    if (!targetShard) {
      for (const fname of shardFiles) {
        const file = gist.files[fname];
        const size = new TextEncoder().encode(file.content || '').length;
        const entrySize = new TextEncoder().encode(JSON.stringify(dataUrl)).length + id.length + 10;
        if (size + entrySize < IMG_SHARD_MAX) {
          targetShard = fname;
          try { targetData = JSON.parse(file.content || '{}'); } catch {}
          break;
        }
      }
    }

    // No existing shard has room — create the next one
    if (!targetShard) {
      const nextIndex = shardFiles.length; // 0, 1, 2, …
      targetShard = IMG_PREFIX + nextIndex + '.json';
      targetData  = {};
    }

    targetData[id] = dataUrl;
    const err = await patchFile(pat, targetShard, JSON.stringify(targetData, null, 2));
    if (err) return err;

    return new Response(JSON.stringify({ shard: targetShard }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── /image  DELETE ?id=xxx — remove an image ──────────────────────
  if (url.pathname === '/image' && request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return new Response('missing id param', { status: 400, headers: CORS });

    const { gist, error } = await fetchGist(pat);
    if (error) return error;

    const shardFiles = Object.keys(gist.files).filter(f => f.startsWith(IMG_PREFIX)).sort();
    for (const fname of shardFiles) {
      let parsed = {};
      try { parsed = JSON.parse(gist.files[fname].content || '{}'); } catch {}
      if (parsed[id] !== undefined) {
        delete parsed[id];
        const err = await patchFile(pat, fname, JSON.stringify(parsed, null, 2));
        if (err) return err;
        return new Response('ok', { status: 200, headers: CORS });
      }
    }
    return new Response('ok', { status: 200, headers: CORS }); // not found is fine
  }

  // ── /progress  GET — read state + merge all image shards ──────────
  if (request.method === 'GET') {
    const { gist, error } = await fetchGist(pat);
    if (error) return error;

    const stateFile = gist.files[STATE_FILE];
    let data = {};
    if (stateFile) {
      const text = await fileContent(stateFile, pat);
      if (text) {
        try { data = JSON.parse(text); }
        catch { return new Response('State file contains invalid JSON', { status: 502, headers: CORS }); }
      }
    }

    // Merge all image shards — strip any images previously written into state file
    delete data.images;
    const shardFiles = Object.keys(gist.files).filter(f => f.startsWith(IMG_PREFIX)).sort();
    const mergedImages = {};
    for (const fname of shardFiles) {
      let parsed = {};
      try { parsed = JSON.parse(await fileContent(gist.files[fname], pat) || '{}'); } catch {}
      Object.assign(mergedImages, parsed);
    }
    data.images = mergedImages;

    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── /progress  POST — write state (never includes images) ─────────
  if (request.method === 'POST') {
    const body = await request.json();
    // Never store images in the state file
    delete body.images;
    const err = await patchFile(pat, STATE_FILE, JSON.stringify(body, null, 2));
    if (err) return err;
    return new Response('ok', { status: 200, headers: CORS });
  }

  return new Response('Not found', { status: 404, headers: CORS });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      // Always answer with CORS headers so the browser shows the real error instead of a CORS failure
      return new Response('Worker error: ' + (e && e.message ? e.message : e), { status: 500, headers: CORS });
    }
  },
};
