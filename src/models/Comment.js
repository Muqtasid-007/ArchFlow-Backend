import mongoose from 'mongoose';

export const COMMENT_TEXT_MAX_LENGTH = 5000;

const anchorSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['canvas', 'node'], required: true },
    // Canvas anchors use x/y. Node anchors use nodeId and offsets from its top-left.
    x: { type: Number, min: -10_000_000, max: 10_000_000 },
    y: { type: Number, min: -10_000_000, max: 10_000_000 },
    nodeId: { type: String, trim: true, maxlength: 64 },
    offsetX: { type: Number, min: -10_000_000, max: 10_000_000 },
    offsetY: { type: Number, min: -10_000_000, max: 10_000_000 },
  },
  { _id: false },
);

anchorSchema.pre('validate', function validateAnchorShape() {
  if (this.type === 'canvas') {
    if (!Number.isFinite(this.x)) this.invalidate('x', 'Canvas anchors need a world x coordinate');
    if (!Number.isFinite(this.y)) this.invalidate('y', 'Canvas anchors need a world y coordinate');
    if (this.nodeId != null) this.invalidate('nodeId', 'Canvas anchors cannot have a node id');
  }
  if (this.type === 'node') {
    if (!this.nodeId) this.invalidate('nodeId', 'Node anchors need a node id');
    if (!Number.isFinite(this.offsetX)) this.invalidate('offsetX', 'Node anchors need an x offset');
    if (!Number.isFinite(this.offsetY)) this.invalidate('offsetY', 'Node anchors need a y offset');
    if (this.x != null || this.y != null) this.invalidate('x', 'Node anchors use offsets instead of canvas coordinates');
  }
});

const commentSchema = new mongoose.Schema(
  {
    boardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Board', required: true },
    // Root messages use their own _id as threadId. Replies point to that root.
    threadId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    anchor: { type: anchorSchema, default: undefined },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: {
      type: String,
      required: [true, 'Comment text cannot be empty'],
      trim: true,
      minlength: [1, 'Comment text cannot be empty'],
      maxlength: [COMMENT_TEXT_MAX_LENGTH, `Comment text cannot exceed ${COMMENT_TEXT_MAX_LENGTH} characters`],
    },
    editedAt: { type: Date, default: null },
    // These fields are set on root messages only.
    resolved: { type: Boolean, default: undefined },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    orphanedAt: { type: Date, default: null },
    lastWorldX: { type: Number, min: -10_000_000, max: 10_000_000 },
    lastWorldY: { type: Number, min: -10_000_000, max: 10_000_000 },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        return ret;
      },
    },
  },
);

commentSchema.pre('validate', function validateThreadShape() {
  if (this.parentId == null) {
    if (!this.anchor) this.invalidate('anchor', 'Root comments need a canvas or node anchor');
    if (this.isNew && String(this.threadId) !== String(this._id)) {
      this.invalidate('threadId', 'A root comment uses its own id as threadId');
    }
    if (this.resolved === undefined) this.resolved = false;
  } else {
    if (this.anchor) this.invalidate('anchor', 'Replies inherit their root anchor');
    if (this.resolved !== undefined) this.invalidate('resolved', 'Only root comments can be resolved');
    if (this.resolvedBy != null || this.resolvedAt != null) {
      this.invalidate('resolvedBy', 'Only root comments can store resolution details');
    }
  }
});

// Root list/filter queries, paged thread replies, and node-anchor cleanup.
commentSchema.index(
  { boardId: 1, resolved: 1, createdAt: -1 },
  { partialFilterExpression: { parentId: null } },
);
commentSchema.index({ boardId: 1, threadId: 1, createdAt: 1, _id: 1 });
commentSchema.index({ boardId: 1, authorId: 1, createdAt: -1 });
commentSchema.index(
  { boardId: 1, 'anchor.type': 1, 'anchor.nodeId': 1 },
  { partialFilterExpression: { 'anchor.type': 'node' } },
);

export const Comment = mongoose.model('Comment', commentSchema);
