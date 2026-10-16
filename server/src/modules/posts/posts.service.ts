// Barrel for the posts service. The implementation is split across:
//   posts.write.ts    — createPost / updatePost / deletePost
//   posts.visibility.ts — assertVisibility / canViewPost / followingSet (the one home)
//   posts.read.ts     — getPostForViewer / searchPosts / getShowcasePosts
//   posts.hydrate.ts  — hydratePosts (used by feed/bookmarks too)
//   posts.tags.ts     — upsertTagsForPost / syncTagCounts
//   posts.media.ts    — uploadPostMedia / cleanupUploadedMedia
//
// External callers should keep importing from `posts.service` so the public
// surface stays stable; internal modules may import from the focused files.
export { createPost, updatePost, deletePost } from './posts.write';
export { assertVisibility, canViewPost, followingSet } from './posts.visibility';

export { getPostForViewer, searchPosts, getShowcasePosts } from './posts.read';

export { hydratePosts } from './posts.hydrate';
