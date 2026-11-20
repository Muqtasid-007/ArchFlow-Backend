import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Comment, COMMENT_TEXT_MAX_LENGTH } from '../src/models/Comment.js';

const boardId = new mongoose.Types.ObjectId();
const authorId = new mongoose.Types.ObjectId();

test('root comments store a validated anchor and normalize text', async () => {
  const root = new Comment({
    boardId,
    authorId,
    threadId: new mongoose.Types.ObjectId(),
    text: '  Please review this part.  ',
    anchor: { type: 'canvas', x: 120, y: 240 },
  });
  root.threadId = root._id;

  await root.validate();
  assert.equal(root.text, 'Please review this part.');
  assert.equal(root.resolved, false);
  console.log('[comment model test] Root comment anchor and trimmed text validated');
});

test('replies point to their thread and cannot add another anchor', async () => {
  const threadId = new mongoose.Types.ObjectId();
  const reply = new Comment({ boardId, authorId, threadId, parentId: threadId, text: 'A reply' });
  await reply.validate();

  const misplacedAnchor = new Comment({
    boardId, authorId, threadId, parentId: threadId, text: 'A reply',
    anchor: { type: 'canvas', x: 1, y: 2 },
  });
  await assert.rejects(misplacedAnchor.validate(), /Replies inherit their root anchor/);
  console.log('[comment model test] Replies use threadId/parentId and inherit the root anchor');
});

test('comment text must be non-empty after trimming and no longer than 5,000 characters', async () => {
  const makeComment = (text) => {
    const comment = new Comment({
      boardId,
      authorId,
      text,
      anchor: { type: 'canvas', x: 0, y: 0 },
    });
    comment.threadId = comment._id;
    return comment;
  };

  await assert.rejects(makeComment('   ').validate(), /Comment text cannot be empty/);
  await assert.rejects(
    makeComment('x'.repeat(COMMENT_TEXT_MAX_LENGTH + 1)).validate(),
    /cannot exceed 5000 characters/,
  );
  await makeComment('x'.repeat(COMMENT_TEXT_MAX_LENGTH)).validate();
  console.log('[comment model test] Empty text rejected; 5,000 characters allowed; longer text rejected');
});

test('comment indexes support thread paging, root filters, authors, and node anchors', () => {
  const indexKeys = Comment.schema.indexes().map(([keys]) => Object.keys(keys).join(','));
  assert.ok(indexKeys.includes('boardId,resolved,createdAt'));
  assert.ok(indexKeys.includes('boardId,threadId,createdAt,_id'));
  assert.ok(indexKeys.includes('boardId,authorId,createdAt'));
  assert.ok(indexKeys.includes('boardId,anchor.type,anchor.nodeId'));
  console.log('[comment model test] Query indexes defined for threads, filters, and node anchors');
});
