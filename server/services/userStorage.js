// ── A user's files in Supabase Storage ──────────────────────────────
//
// Everything the backend stores for a user lives in one bucket under two
// prefixes (server.js):
//   <userId>/…            uploaded creatives (manual campaigns, ad images)
//   generated/<userId>/…  generated images and stored generated videos
//
// removeUserFiles() deletes all of them. Account deletion calls it before the
// database step: the files are public URLs with personal content (product
// photos, generated ads), so an erased account must not leave them behind.
// Throws when Storage reports an error, so the deletion stops and can be
// retried; a bucket or folder that doesn't exist counts as nothing to remove.

const PAGE = 1000;
const REMOVE_CHUNK = 100;
const MAX_DEPTH = 3;

function prefixesFor(userId) {
  const id = String(userId || '').trim();
  // A user id is a UUID. Anything else could widen the prefix (e.g. '' would
  // list the whole bucket), so refuse it outright.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('removeUserFiles: invalid user id');
  return [id, 'generated/' + id];
}

const _notFound = (err) => !!err && (Number(err.statusCode || err.status) === 404 || /not.?found/i.test(String(err.message || '')));

// All file paths under a prefix (folders are entries without an id).
async function _listAll(bucket, prefix, depth) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await bucket.list(prefix, { limit: PAGE, offset });
    if (error) { if (_notFound(error)) return out; throw new Error('storage list failed: ' + (error.message || error)); }
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (!row || !row.name) continue;
      const path = prefix + '/' + row.name;
      if (row.id == null) { if (depth < MAX_DEPTH) out.push(...await _listAll(bucket, path, depth + 1)); }
      else out.push(path);
    }
    if (rows.length < PAGE) return out;
  }
}

// Returns the number of files removed.
async function removeUserFiles(storage, bucketName, userId) {
  const prefixes = prefixesFor(userId);
  if (!storage || typeof storage.from !== 'function') return 0; // no Storage configured: nothing was ever stored
  const bucket = storage.from(bucketName);
  let removed = 0;
  for (const prefix of prefixes) {
    const paths = await _listAll(bucket, prefix, 0);
    for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + REMOVE_CHUNK);
      const { error } = await bucket.remove(chunk);
      if (error && !_notFound(error)) throw new Error('storage remove failed: ' + (error.message || error));
      removed += chunk.length;
    }
  }
  return removed;
}

module.exports = { removeUserFiles, prefixesFor };
