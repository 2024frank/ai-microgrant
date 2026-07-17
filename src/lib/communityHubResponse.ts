export type CommunityHubModeration = 'pending' | 'approved' | 'rejected' | 'unknown';

export function normalizeCommunityHubPostId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim();
  if (!id || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function extractCommunityHubPost(value: unknown): Record<string, any> | null {
  const root = record(value);
  if (!root) return null;
  const direct = record(root.post);
  if (direct) return direct;
  const data = record(root.data);
  if (data) return record(data.post) ?? data;
  const result = record(root.result);
  if (result) return record(result.post) ?? result;
  return root;
}

export function extractCommunityHubPostId(value: unknown): string | null {
  const root = record(value);
  if (!root) return null;
  const post = extractCommunityHubPost(root);
  const candidates = [
    post?.id,
    post?.postId,
    post?.post_id,
    root.id,
    root.postId,
    root.post_id,
  ];
  for (const candidate of candidates) {
    const id = normalizeCommunityHubPostId(candidate);
    if (id) return id;
  }
  return null;
}

export function moderationFromCommunityHubPost(post: Record<string, any> | null): CommunityHubModeration {
  if (!post || !Object.prototype.hasOwnProperty.call(post, 'approved')) return 'unknown';
  if (post.approved === true || post.approved === 1 || post.approved === '1') return 'approved';
  if (post.approved === false || post.approved === 0 || post.approved === '0') return 'rejected';
  if (post.approved === null) return 'pending';
  return 'unknown';
}
